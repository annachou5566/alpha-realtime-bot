require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { createClient } = require('@supabase/supabase-js');
const https = require('https'); 

// ⚡ BỎ THƯ VIỆN WEBSOCKET ĐỂ ÉP XUNG BĂNG THÔNG
const http = require('http');
// Xóa: const { Server } = require("socket.io");
// Xóa: const WebSocket = require('ws');

axios.defaults.httpsAgent = new https.Agent({
    servername: 'www.binance.com' 
});

const app = express();

// 🛑 NÉN DỮ LIỆU HTTP
const compression = require('compression');
app.use(compression());

// ⚡ CHỈ DÙNG EXPRESS THUẦN TÚY, CẮT BỎ SOCKET.IO
const server = http.createServer(app);
// Xóa: const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const FAKE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
    "client-type": "web"
};

const API_ENDPOINTS = {
    BULK_TOTAL: "https://www.binance.com/bapi/defi/v1/public/alpha-trade/aggTicker24?dataType=aggregate",
    BULK_LIMIT: "https://www.binance.com/bapi/defi/v1/public/alpha-trade/aggTicker24?dataType=limit",
    KLINES_1H_OFFSET: (chainId, contract) => `https://www.binance.com/bapi/defi/v1/public/alpha-trade/agg-klines?chainId=${chainId}&interval=1h&limit=100&tokenAddress=${contract}&dataType=aggregate`
};

const s3Client = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT_URL,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    }
});
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.use(cors({ origin: '*' }));

// --- RAM CACHE ---
let GLOBAL_MARKET = {};      
let ACTIVE_CONFIG = {};      
let HISTORY_CACHE = {};      
let BASE_HISTORY_DATA = {};  
let START_OFFSET_CACHE = {}; 
let SNAPSHOT_TAIL_TOTAL = {}; 
let SNAPSHOT_TAIL_LIMIT = {}; 
let ACTIVE_TOKEN_LIST = [];  

let TOKEN_METRICS_HISTORY = {}; 
let MARKET_VOL_HISTORY = [];
let PREDICTION_SMOOTHING_CACHE = {};

// HÀM LẤY 14 CÂY NẾN 1D TỪ API BAPI (WEB3/DEFI)
async function fetch14DaysHistoryBapi() {
    console.log("⏳ Đang lấy danh sách Token để cào lịch sử Volume...");
    let historyMap = {}; 

    try {
        const resTot = await axios.get(API_ENDPOINTS.BULK_TOTAL, { headers: FAKE_HEADERS, timeout: 10000 });
        
        if (!resTot.data?.success || !resTot.data?.data) {
            console.log("❌ Lấy danh sách token thất bại, không thể cào lịch sử.");
            return;
        }

        let tokensToFetch = resTot.data.data.filter(t => 
            t.contractAddress && 
            t.stockState !== 1 && 
            t.stockState !== true && 
            !t.rwaInfo
        );

        if (tokensToFetch.length === 0) {
            console.log("⚠️ Không tìm thấy token nào hợp lệ để cào.");
            return;
        }

        console.log(`🎯 Tìm thấy ${tokensToFetch.length} tokens. Bắt đầu cào Klines 1D...`);

        for (let i = 0; i < tokensToFetch.length; i += 10) {
            const chunk = tokensToFetch.slice(i, i + 10);
            await Promise.all(chunk.map(async (t) => {
                try {
                    let chainId = t.chainId || (t.chain === 'BSC' ? 56 : (t.chain === 'ETH' ? 1 : 56));
                    let tokenAddr = t.contractAddress;

                    const url = `https://www.binance.com/bapi/defi/v1/public/alpha-trade/agg-klines?chainId=${chainId}&interval=1d&limit=14&tokenAddress=${tokenAddr}&dataType=aggregate`;
                    const res = await axios.get(url, { headers: FAKE_HEADERS, timeout: 5000 });
                    const json = res.data;
                    
                    if (json?.success && json?.data?.klineInfos) {
                        json.data.klineInfos.forEach(candle => {
                            let dateStr = new Date(parseInt(candle[0])).toISOString().split('T')[0];
                            let vol = parseFloat(candle[5] || 0);
                            
                            if (!historyMap[dateStr]) historyMap[dateStr] = 0;
                            historyMap[dateStr] += vol;
                        });
                    }
                } catch (e) { }
            }));
            await new Promise(resolve => setTimeout(resolve, 300)); 
        }

        let tempArr = [];
        Object.keys(historyMap).sort().forEach(date => {
            tempArr.push({ date: date, daily: historyMap[date], rolling: historyMap[date] });
        });

        let todayStr = new Date().toISOString().split('T')[0];
        MARKET_VOL_HISTORY = tempArr.filter(x => x.date !== todayStr).slice(-13);

        console.log(`✅ Cào BAPI xong! Nạp thành công ${MARKET_VOL_HISTORY.length} ngày lịch sử chuẩn 100%.`);
    } catch (error) {
        console.error("❌ Lỗi nghiêm trọng khi cào BAPI:", error.message);
    }
}

async function syncMarketHistory() {
    try {
        const cmd = new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: "market_vol_history.json" });
        const resp = await s3Client.send(cmd);
        const str = await resp.Body.transformToString();
        MARKET_VOL_HISTORY = JSON.parse(str);
    } catch (e) { }
}
const HISTORY_FILE_KEY = "finalized_history.json";

// ==========================================
// 1. CÁC JOB ĐỒNG BỘ DỮ LIỆU NỀN
// ==========================================
async function syncHistoryFromR2() {
    try {
        const cmd = new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: HISTORY_FILE_KEY });
        const resp = await s3Client.send(cmd);
        const str = await resp.Body.transformToString();
        HISTORY_CACHE = JSON.parse(str);
        console.log(`📚 Đã tải HISTORY từ R2: ${Object.keys(HISTORY_CACHE).length} giải.`);
    } catch (e) { HISTORY_CACHE = {}; }
}

async function syncActiveConfig() {
    try {
        const todayStr = new Date().toISOString().split('T')[0];
        const { data, error } = await supabase.from('tournaments').select('id, contract, data').neq('id', -1);

        if (error) throw error;
        if (data) {
            const newActive = {};
            const newTokens = [];
            data.forEach(row => {
                const meta = row.data || {};
                let isActive = true;
                if (meta.ai_prediction && meta.ai_prediction.status_label === 'FINALIZED') isActive = false;
                if (meta.end && meta.end < todayStr) isActive = false;

                if (meta.alphaId) {
                    meta.contract = row.contract || meta.contract;
                    if(!meta.chainId && meta.chain) {
                        const cMap = {'bsc': 56, 'bnb': 56, 'eth': 1, 'base': 8453, 'arb': 42161, 'op': 10, 'polygon': 137};
                        meta.chainId = cMap[String(meta.chain).toLowerCase()] || 56;
                    }

                    if (isActive) {
                        newActive[meta.alphaId] = { ...meta, db_id: row.id };
                        if (!newTokens.includes(meta.alphaId)) newTokens.push(meta.alphaId);
                    } else {
                        if (HISTORY_CACHE[meta.alphaId]) {
                            if (meta.history) {
                                HISTORY_CACHE[meta.alphaId].history = meta.history;
                                if (!HISTORY_CACHE[meta.alphaId].data) HISTORY_CACHE[meta.alphaId].data = {};
                                HISTORY_CACHE[meta.alphaId].data.history = meta.history;
                            }
                        } else {
                            HISTORY_CACHE[meta.alphaId] = { ...meta, db_id: row.id };
                        }
                    }
                }
            });
            ACTIVE_CONFIG = newActive;
            ACTIVE_TOKEN_LIST = newTokens;
            console.log(`⚡ Sync Config: ${Object.keys(ACTIVE_CONFIG).length} ACTIVE, History updated.`);
        }
    } catch (e) { console.error("❌ Sync Active Config Error:", e.message); }
}

async function syncBaseData() {
    try {
        const cmd = new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: "tournaments-base.json" });
        const resp = await s3Client.send(cmd);
        const str = await resp.Body.transformToString();
        BASE_HISTORY_DATA = JSON.parse(str);
        console.log("✅ Đã tải Base History (Volume nền).");
    } catch (e) { }
}

async function checkStartOffsets() {
    const todayStr = new Date().toISOString().split('T')[0];
    for (const alphaId in ACTIVE_CONFIG) {
        const conf = ACTIVE_CONFIG[alphaId];
        if (conf.start === todayStr) {
            if (START_OFFSET_CACHE[alphaId] || !conf.contract) continue;
            const startTimeStr = (conf.startTime || "00:00").includes(":") ? conf.startTime : conf.startTime + ":00";
            const startTs = new Date(`${conf.start}T${startTimeStr}Z`).getTime();
            const dayStartTs = new Date(`${conf.start}T00:00:00Z`).getTime();

            try {
                const url = API_ENDPOINTS.KLINES_1H_OFFSET(conf.chainId || 56, conf.contract);
                const res = await axios.get(url, { headers: FAKE_HEADERS, timeout: 5000 });
                let offset = 0;
                if (res.data?.success && res.data.data?.klineInfos) {
                    res.data.data.klineInfos.forEach(k => {
                        const kTs = parseInt(k[0]);
                        if (kTs >= dayStartTs && kTs < startTs) offset += parseFloat(k[5] || 0);
                    });
                }
                START_OFFSET_CACHE[alphaId] = offset;
            } catch (e) {}
        }
    }
}

// ==========================================
// 1.5. ĐỒNG BỘ "CÁI ĐUÔI" TỪ PYTHON BOT
// ==========================================
async function syncTailsFromR2() {
    try {
        const cmd = new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: "tails_cache.json" });
        const resp = await s3Client.send(cmd);
        const str = await resp.Body.transformToString();
        const data = JSON.parse(str);
        
        if (data.total) SNAPSHOT_TAIL_TOTAL = data.total;
        if (data.limit) SNAPSHOT_TAIL_LIMIT = data.limit;
        
        if (MARKET_VOL_HISTORY.length === 0) {
            let calcDaily = 0;
            Object.keys(SNAPSHOT_TAIL_TOTAL).forEach(id => {
                calcDaily += (SNAPSHOT_TAIL_TOTAL[id][0] || 0); 
            });
            if (calcDaily > 0) {
                let yStr = new Date(Date.now() - 86400000).toISOString().split('T')[0];
                MARKET_VOL_HISTORY.push({ date: yStr, daily: calcDaily, rolling: calcDaily });
            }
        }
        console.log(`🦊 Đã tải Tails Cache từ R2.`);
    } catch (e) {
        console.error("⚠️ Chưa tải được Tails Cache.");
    }
}

let lastHistoryDay = new Date().getUTCDate();
setInterval(() => {
    const nowDay = new Date().getUTCDate();
    if (nowDay !== lastHistoryDay) {
        lastHistoryDay = nowDay;
        
        let totalDaily = 0;
        Object.values(GLOBAL_MARKET).forEach(t => {
            if (t && t.ss !== 1 && t.ss !== true && t.id !== '_STATS' && t.v) {
                totalDaily += (t.r24 || 0); 
            }
        });

        let yStr = new Date(Date.now() - 86400000).toISOString().split('T')[0];
        MARKET_VOL_HISTORY = MARKET_VOL_HISTORY.filter(x => x.date !== yStr); 
        MARKET_VOL_HISTORY.push({ date: yStr, daily: totalDaily, rolling: totalDaily });
        if (MARKET_VOL_HISTORY.length > 14) MARKET_VOL_HISTORY.shift(); 
        
        SNAPSHOT_TAIL_TOTAL = {}; 
        SNAPSHOT_TAIL_LIMIT = {};
        
        console.log("🕛 Đã qua ngày mới! Cập nhật 1 cây nến vào lịch sử thành công.");
    }
}, 60000);

// ==========================================
// 2. LOGIC TÍNH TOÁN AI PREDICTION
// ==========================================
function calculateAiPrediction(staticData, accumulatedData) {
    let currentVol = accumulatedData.limitAccumulated || 0;
    let usingLimit = true;

    if (currentVol === 0 && accumulatedData.totalAccumulated > 0) {
        currentVol = accumulatedData.totalAccumulated;
        usingLimit = false; 
    }

    let projectedVol = currentVol;
    let isFinalized = false;
    const now = new Date();
    
    if (staticData.end) {
        let endTimeStr = staticData.endTime && staticData.endTime.includes(':') ? staticData.endTime : "13:00";
        if (endTimeStr.length === 5) endTimeStr += ":00";
        const endDate = new Date(`${staticData.end}T${endTimeStr}Z`);
        const freezeDate = endDate; 

        if (now >= freezeDate) {
            isFinalized = true;
        } else {
            const diffSeconds = (endDate.getTime() - now.getTime()) / 1000;
            let velocity = 0;
            let rawSpeed = accumulatedData.analysis?.speed || 0; 
            
            if (rawSpeed > 0) {
                if (usingLimit && accumulatedData.totalAccumulated > 0) {
                     const ratio = currentVol / accumulatedData.totalAccumulated;
                     velocity = rawSpeed * ratio; 
                } else {
                    velocity = rawSpeed;
                }
            }
            if (velocity > 0) projectedVol += (velocity * diffSeconds);
        }
    }

    let effectiveVol = projectedVol;
    const ruleType = staticData.ruleType || "trade_all";
    if (ruleType === 'buy_only') effectiveVol = projectedVol / 2;
    if (ruleType === 'trade_x4') effectiveVol = projectedVol * 4;

    let ticketSize = 0;
    if (usingLimit && accumulatedData.limitTx > 0) ticketSize = currentVol / accumulatedData.limitTx;
    else if (accumulatedData.totalTx > 0) ticketSize = currentVol / accumulatedData.totalTx;
    else if (accumulatedData.analysis && accumulatedData.analysis.ticket) ticketSize = accumulatedData.analysis.ticket;

    const k = 1.03;
    const winners = parseInt(staticData.topWinners || 5000);
    let finalK = k;
    let adminNote = "";
    if (staticData.ai_factor) {
        const adminFactor = parseFloat(staticData.ai_factor);
        if (!isNaN(adminFactor) && adminFactor !== 0) {
            finalK = k * adminFactor;
            adminNote = ` [Adj x${adminFactor}]`;
        }
    }

    const rawTarget = (effectiveVol * finalK) / winners;
    
    const alphaId = staticData.alphaId || staticData.symbol || "UNKNOWN";
    if (!PREDICTION_SMOOTHING_CACHE[alphaId]) PREDICTION_SMOOTHING_CACHE[alphaId] = [];
    
    const nowTs = Date.now();
    let cacheArr = PREDICTION_SMOOTHING_CACHE[alphaId];
    
    cacheArr.push({ ts: nowTs, val: rawTarget });
    cacheArr = cacheArr.filter(item => nowTs - item.ts <= 3600000);
    PREDICTION_SMOOTHING_CACHE[alphaId] = cacheArr;
    
    let sumTarget = 0;
    cacheArr.forEach(item => sumTarget += item.val);
    const finalTarget = cacheArr.length > 0 ? (sumTarget / cacheArr.length) : rawTarget;
    
    let deltaVal = 0;
    const targets = staticData.history || [];
    let lastMinTarget = 0;
    if (targets.length > 0) {
        const sorted = [...targets].sort((a,b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        const latest = sorted.find(h => parseFloat(h.target) > 0);
        if (latest) lastMinTarget = parseFloat(latest.target);
    }
    
    deltaVal = lastMinTarget > 0 ? (finalTarget - lastMinTarget) : finalTarget;

    return {
        target: Math.round(finalTarget),
        delta: Math.round(deltaVal),
        rule: `Global Standard${adminNote} (K=${finalK.toFixed(2)}) ${usingLimit ? '[LIMIT]' : ''}`,
        R: finalK,
        status_label: isFinalized ? "FINALIZED" : "LIVE PREDICTION",
        debug_info: `Vol:${(effectiveVol/1e9).toFixed(2)}B Ticket:$${Math.round(ticketSize)}`,
        is_finalized: isFinalized
    };
}

// ==========================================
// 3. AUTO-FINALIZE
// ==========================================
async function finalizeTournament(alphaId, finalData, predictionResult) {
    const config = ACTIVE_CONFIG[alphaId];
    
    if (ACTIVE_CONFIG[alphaId]) delete ACTIVE_CONFIG[alphaId];
    if (!config || HISTORY_CACHE[alphaId]) return;

    console.log(`🏁 ĐANG CHỐT SỔ GIẢI ĐẤU: ${alphaId} ...`);
    const finalObj = {
        ...config,
        total_accumulated_volume: finalData.totalAccumulated,
        limit_accumulated_volume: finalData.limitAccumulated,
        limit_accumulated_tx: finalData.limitTx,
        tx_count: finalData.totalTx,
        real_vol_history: finalData.historyArr,
        ai_prediction: {
            target: predictionResult.target,
            delta: predictionResult.delta,
            rule: predictionResult.rule,
            R: predictionResult.R,
            last_calc: Date.now(),
            debug_info: predictionResult.debug_info,
            status_label: "FINALIZED"
        },
        last_updated_ts: Date.now()
    };

    try { await supabase.from('tournaments').update({ data: finalObj }).eq('id', config.db_id); } catch (e) {}
    HISTORY_CACHE[alphaId] = finalObj;

    try {
        const cmd = new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: HISTORY_FILE_KEY, Body: JSON.stringify(HISTORY_CACHE), ContentType: "application/json" });
        await s3Client.send(cmd);
        console.log(`✅ Đã lưu kết quả ${alphaId} lên R2.`);
    } catch (e) {}
}

// ==========================================
// 4. VÒNG LẶP REALTIME (FALLBACK API)
// ==========================================
async function loopRealtime() {
    try {
        const [resTot, resLim] = await Promise.all([
            axios.get(API_ENDPOINTS.BULK_TOTAL, { headers: FAKE_HEADERS, timeout: 10000 }),
            axios.get(API_ENDPOINTS.BULK_LIMIT, { headers: FAKE_HEADERS, timeout: 10000 })
        ]);

        if (resTot.data?.success) {
            const now = new Date();
            const currentTs = now.getTime();
            const currentMinute = now.getUTCHours() * 60 + now.getUTCMinutes();

            const limitMap = {};
            const limitTxMap = {}; 
            if (resLim.data?.success) {
                resLim.data.data.forEach(t => {
                    limitMap[t.alphaId] = parseFloat(t.volume24h || 0);
                    limitTxMap[t.alphaId] = parseFloat(t.count24h || 0); 
                });
            }

            resTot.data.data.forEach(t => {
                const id = t.alphaId;
                if (!id) return;
                
                let rollVolTot = parseFloat(t.volume24h || 0);
                let rollVolLim = limitMap[id] || 0;
                let currentPrice = parseFloat(t.price || 0);
                let currentTx = limitTxMap[id] || 0;

                const tailTot = SNAPSHOT_TAIL_TOTAL[id]?.[currentMinute] || 0;
                const tailLim = SNAPSHOT_TAIL_LIMIT[id]?.[currentMinute] || 0;

                let dailyTot = Math.max(0, rollVolTot - tailTot);
                let dailyLim = Math.max(0, rollVolLim - tailLim);
                if (dailyTot < dailyLim) dailyTot = dailyLim; 

                if (ACTIVE_CONFIG[id] && ACTIVE_CONFIG[id].inputTokens && ACTIVE_CONFIG[id].inputTokens.length > 0) {
                    const dbData = ACTIVE_CONFIG[id]; 
                    
                    dailyTot = parseFloat(dbData.real_alpha_volume || 0);
                    dailyLim = parseFloat(dbData.limit_daily_volume || 0);
                    currentTx = parseFloat(dbData.daily_tx_count || 0);
                    rollVolTot = parseFloat(dbData.real_alpha_volume || 0);

                    START_OFFSET_CACHE[id] = 0; 
                    BASE_HISTORY_DATA[id] = {
                        base_total_vol: parseFloat(dbData.total_accumulated_volume || 0) - dailyTot,
                        base_limit_vol: parseFloat(dbData.limit_accumulated_volume || 0) - dailyLim,
                        base_total_tx: parseFloat(dbData.tx_count || 0) - currentTx,
                        base_limit_tx: parseFloat(dbData.limit_accumulated_tx || 0) - currentTx
                    };
                }

                GLOBAL_MARKET[id] = {
                    ca: t.contractAddress,
                    p: currentPrice,
                    c: parseFloat(t.percentChange24h || t.priceChangePercent || 0),
                    r24: rollVolTot,
                    l: parseFloat(t.liquidity || 0),
                    mc: parseFloat(t.marketCap || 0),
                    h: parseInt(t.holders || t.holderCount || 0),
                    tx: currentTx,
                    ss: (t.stockState || t.rwaInfo) ? 1 : 0, 
                    v: { dt: dailyTot, dl: dailyLim } 
                };

                if (!ACTIVE_CONFIG[id]) return; 

                let history = TOKEN_METRICS_HISTORY[id] || [];
                let buyVol3s = 0, sellVol3s = 0, tickVol3s = 0, tickTx3s = 0;

                if (history.length > 0) {
                    const lastData = history[history.length - 1];
                    if (rollVolTot >= lastData.v) {
                        tickVol3s = rollVolTot - lastData.v;
                        tickTx3s = currentTx - lastData.tx;
                        if (currentPrice >= lastData.p) buyVol3s = tickVol3s;
                        else sellVol3s = tickVol3s;
                    } else {
                        history = []; 
                    }
                }
                history.push({ ts: currentTs, p: currentPrice, v: rollVolTot, tx: currentTx, buyV: buyVol3s, sellV: sellVol3s, tickTx: tickTx3s });
                history = history.filter(h => currentTs - h.ts <= 60000); 
                TOKEN_METRICS_HISTORY[id] = history;

                let spread15s = 0, trend60s = 0, dropFromPeak = 0, netFlow60s = 0, speed60s = 0, ticket3s = 0;
                if (history.length > 1) {
                    const oldest60s = history[0];
                    const newest = history[history.length - 1];

                    let totalBuy60s = 0, totalSell60s = 0;
                    let maxP60 = -1, minP60 = Infinity;

                    history.forEach(h => { 
                        totalBuy60s += h.buyV; 
                        totalSell60s += h.sellV; 
                        if(h.p > maxP60) maxP60 = h.p; 
                        if(h.p < minP60) minP60 = h.p;
                    });

                    netFlow60s = totalBuy60s - totalSell60s; 
                    const deltaTs60s = (newest.ts - oldest60s.ts) / 1000;
                    if (deltaTs60s > 0) speed60s = (newest.v - oldest60s.v) / deltaTs60s; 
                    if (oldest60s.p > 0) trend60s = ((newest.p - oldest60s.p) / oldest60s.p) * 100;
                    if (maxP60 !== -1 && maxP60 > 0) dropFromPeak = ((newest.p - maxP60) / maxP60) * 100; 
                    if (tickTx3s > 0) ticket3s = tickVol3s / tickTx3s;

                    const history15s = history.filter(h => currentTs - h.ts <= 15000);
                    if (history15s.length > 0) {
                        let maxP15 = -1, minP15 = Infinity;
                        history15s.forEach(h => { if(h.p > maxP15) maxP15 = h.p; if(h.p < minP15) minP15 = h.p; });
                        if (minP15 > 0 && maxP15 !== -1 && minP15 !== Infinity) spread15s = ((maxP15 - minP15) / minP15) * 100;
                    }
                }

                GLOBAL_MARKET[id].analysis = { spread: spread15s, trend: trend60s, drop: dropFromPeak, netFlow: netFlow60s, speed: speed60s, ticket: ticket3s }; 

                const config = ACTIVE_CONFIG[id];
                const base = BASE_HISTORY_DATA[id] || {};
                const nowStr = now.toISOString().split('T')[0];

                const offset = parseFloat(START_OFFSET_CACHE[id] || 0);
                let effectiveTodayVol = parseFloat(dailyTot || 0);
                if (config.start === nowStr) effectiveTodayVol = Math.max(0, effectiveTodayVol - offset);

                const totalAccumulated = parseFloat(base.base_total_vol || 0) + effectiveTodayVol;
                const limitAccumulated = parseFloat(base.base_limit_vol || 0) + parseFloat(dailyLim || 0);

                const realTx = parseFloat(currentTx || 0);
                const limitTxAccumulated = parseFloat(base.base_limit_tx || 0) + realTx; 
                const totalTxAccumulated = parseFloat(base.base_total_tx || 0) + realTx;

                const aiResult = calculateAiPrediction(config, {
                    totalAccumulated, 
                    limitAccumulated, 
                    limitTx: limitTxAccumulated, 
                    totalTx: totalTxAccumulated, 
                    analysis: GLOBAL_MARKET[id].analysis
                });

                GLOBAL_MARKET[id].ai_prediction = aiResult;
                GLOBAL_MARKET[id].effectiveTodayVol = effectiveTodayVol;
                GLOBAL_MARKET[id].limitAccumulated = limitAccumulated;
                GLOBAL_MARKET[id].totalAccumulated = totalAccumulated;

                if (aiResult.is_finalized) {
                    const historyArr = base.history_total ? [...base.history_total] : [];
                    const existingToday = historyArr.find(h => h.date === nowStr);
                    if (existingToday) existingToday.vol = effectiveTodayVol;
                    else historyArr.push({ date: nowStr, vol: effectiveTodayVol });

                    finalizeTournament(id, { 
                        totalAccumulated, 
                        limitAccumulated, 
                        limitTx: limitTxAccumulated, 
                        totalTx: totalTxAccumulated,
                        historyArr: historyArr 
                    }, aiResult);
                }

            }); 

            GLOBAL_MARKET['_STATS'] = MARKET_VOL_HISTORY;

        } 
    } catch (e) { 
        console.error("⚠️ Lỗi quét API Binance Realtime:", e.message); 
    }
}



// ==========================================
// 6. API TRẢ DỮ LIỆU CHO FRONTEND
// ==========================================
app.get('/api/market-data', (req, res) => {
    // Ép Cache 60s
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({ success: true, count: Object.keys(GLOBAL_MARKET).length, data: GLOBAL_MARKET });
});

app.get('/api/competition-data', (req, res) => {
    // [CẦM MÁU BĂNG THÔNG] Ép trình duyệt tự cache 30 giây (Vì data giải đấu không cần update quá nhanh).
    res.setHeader('Cache-Control', 'public, max-age=30');
    
    const responseData = {};
    const nowStr = new Date().toISOString().split('T')[0];
    Object.assign(responseData, HISTORY_CACHE);

    Object.keys(ACTIVE_CONFIG).forEach(alphaId => {
        const config = ACTIVE_CONFIG[alphaId];
        const base = BASE_HISTORY_DATA[alphaId] || {};
        const real = GLOBAL_MARKET[alphaId] || {};
        
        const effectiveTodayVol = real.effectiveTodayVol || 0;
        const totalAccumulated = real.totalAccumulated || parseFloat(base.base_total_vol || 0);
        const limitAccumulated = real.limitAccumulated || parseFloat(base.base_limit_vol || 0);  
        
        const historyArr = base.history_total ? [...base.history_total] : [];
        const existingToday = historyArr.find(h => h.date === nowStr);
        if (existingToday) existingToday.vol = effectiveTodayVol;
        else historyArr.push({ date: nowStr, vol: effectiveTodayVol });

        const aiResult = real.ai_prediction || { label: "WAIT...", target: 0, delta: 0, is_finalized: false };

        responseData[alphaId] = {
            ...config,
            price: real.p !== undefined ? real.p : config.price,
            change_24h: real.c !== undefined ? real.c : config.change_24h,
            liquidity: real.l !== undefined ? real.l : config.liquidity,
            volume: { ...(config.volume || {}), rolling_24h: real.r24 !== undefined ? real.r24 : (config.volume?.rolling_24h || 0) },
            total_accumulated_volume: totalAccumulated,
            limit_accumulated_volume: limitAccumulated,
            real_alpha_volume: effectiveTodayVol,
            base_total_vol: base.base_total_vol || 0,
            base_limit_vol: base.base_limit_vol || 0,
            real_vol_history: historyArr,
            market_analysis: real.analysis || { label: "WAIT..." },
            ai_prediction: aiResult
        };
    });

    res.json(responseData);
});

app.get('/api/klines', async (req, res) => {
    const { contract, chainId, interval, limit } = req.query;

    let binanceInterval = interval === 'tick' ? '1s' : interval;
    let queryLimit = limit || 300;

    if (!contract || contract === 'undefined' || contract === 'null') {
        return res.json([]); 
    }

    let klines = [];
    try {
        let cleanAddr = contract.toLowerCase();
        let cid = chainId || 56;
        
        if (String(cid) === "501" || cid === "CT_501" || String(cid) === "784" || cid === "CT_784") {
            cleanAddr = contract;
        }
        
        let bapiUrl = `https://www.binance.com/bapi/defi/v1/public/alpha-trade/agg-klines?chainId=${cid}&interval=${binanceInterval}&limit=${queryLimit}&tokenAddress=${cleanAddr}&dataType=aggregate`;
        
        const response = await axios.get(bapiUrl, { headers: FAKE_HEADERS, timeout: 10000 });
        
        if (response.data && response.data.code === "000000" && response.data.data && response.data.data.klineInfos) {
            klines = response.data.data.klineInfos.map(k => {
                if (Array.isArray(k)) {
                    return { time: Math.floor(parseInt(k[0]) / 1000), open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) };
                } else {
                    return { time: Math.floor(parseInt(k.timestamp) / 1000), open: parseFloat(k.openPrice), high: parseFloat(k.highPrice), low: parseFloat(k.lowPrice), close: parseFloat(k.closePrice), volume: parseFloat(k.volume) };
                }
            });
            klines.sort((a, b) => a.time - b.time);
        }
        
        res.json(klines);
        
    } catch (error) {
        console.error("Lỗi lấy nến:", error.message);
        res.status(500).json({ error: "Lỗi lấy dữ liệu" });
    }
});
// =======================================================
// 🛡️ API SMART MONEY (TÀNG HÌNH + RAM CACHE 60s CHỐNG QUÁ TẢI)
// =======================================================
const SMART_MONEY_CACHE = {}; 

app.get('/api/smart-money', async (req, res) => {
    const { contractAddress, chainId } = req.query;
    
    if (!contractAddress || contractAddress === 'undefined') {
        return res.json({ success: false, message: "Thiếu contract" });
    }

    let cid = chainId || 56;
    let cleanAddr = contractAddress.toLowerCase();
    
    if (String(cid) === "501" || cid === "CT_501" || String(cid) === "784" || cid === "CT_784") {
        cleanAddr = contractAddress; 
    }

    let cacheKey = `${cid}_${cleanAddr}`;
    let nowTs = Date.now();

    // Nếu có trong Két sắt RAM (dưới 60s) -> Trả về luôn, không tốn 1 byte băng thông
    if (SMART_MONEY_CACHE[cacheKey] && (nowTs - SMART_MONEY_CACHE[cacheKey].ts < 60000)) {
        return res.json(SMART_MONEY_CACHE[cacheKey].data);
    }

    let bapiUrl = `https://web3.binance.com/bapi/defi/v4/public/wallet-direct/buw/wallet/market/token/dynamic/info?chainId=${cid}&contractAddress=${cleanAddr}`;

    try {
        const advHeaders = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
            "Origin": "https://web3.binance.com",
            "Referer": "https://web3.binance.com/",
            "sec-ch-ua": "\"Not A(Brand\";v=\"99\", \"Google Chrome\";v=\"121\", \"Chromium\";v=\"121\"",
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": "\"Windows\""
        };

        const response = await axios.get(bapiUrl, { headers: advHeaders, timeout: 8000 });

        if (response.data && response.data.success) {
            SMART_MONEY_CACHE[cacheKey] = { ts: nowTs, data: response.data };
            return res.json(response.data);
        } else {
            return res.json(response.data || { success: false });
        }
    } catch (error) {
        // Chỉ im lặng trả về lỗi 500, không in log rác ra màn hình
        return res.status(error.response ? error.response.status : 500).json({ success: false });
    }
});
// =====================================================================
// 🚀 START SERVER
// =====================================================================
server.listen(PORT, async () => {
    console.log(`🚀 [Wave Alpha Core] Máy chủ đang chạy tại port ${PORT}`);
    
    await syncHistoryFromR2();
    await syncActiveConfig();
    await syncBaseData();
    await checkStartOffsets();
    await fetch14DaysHistoryBapi(); 
    await syncTailsFromR2();
    
    
    
    // 2. CHẠY PHƯƠNG ÁN DỰ PHÒNG CỐ ĐỊNH 15 GIÂY 1 LẦN
    loopRealtime(); 
    setInterval(loopRealtime, 15000); 
    
    setInterval(syncActiveConfig, 5 * 60 * 1000); 
    setInterval(syncBaseData, 30 * 60 * 1000);   
    setInterval(checkStartOffsets, 15 * 60 * 1000); 
    setInterval(syncTailsFromR2, 10 * 60 * 1000); 
});
