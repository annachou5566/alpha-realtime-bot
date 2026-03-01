require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const FAKE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
    "client-type": "web"
};

// =====================================================================
// 🎯 KHU VỰC 1: API CHUẨN (ĐÃ XÓA API 1 PHÚT VÔ ÍCH)
// =====================================================================
const API_ENDPOINTS = {
    BULK_TOTAL: "https://www.binance.com/bapi/defi/v1/public/alpha-trade/aggTicker24?dataType=aggregate",
    BULK_LIMIT: "https://www.binance.com/bapi/defi/v1/public/alpha-trade/aggTicker24?dataType=limit",
    KLINES_TOTAL: (chainId, contract) => `https://www.binance.com/bapi/defi/v1/public/alpha-trade/agg-klines?chainId=${chainId}&interval=5m&limit=1000&tokenAddress=${contract}&dataType=aggregate`,
    KLINES_LIMIT: (chainId, contract) => `https://www.binance.com/bapi/defi/v1/public/alpha-trade/agg-klines?chainId=${chainId}&interval=5m&limit=1000&tokenAddress=${contract}&dataType=limit`,
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

// [MỚI] BỘ NHỚ LƯU VẾT AI CHO "KHẨU QUYẾT 3-9-60"
let TOKEN_METRICS_HISTORY = {}; 

const HISTORY_FILE_KEY = "finalized_history.json";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

                if (isActive && meta.alphaId) {
                    meta.contract = row.contract || meta.contract;
                    if(!meta.chainId && meta.chain) {
                        const cMap = {'bsc': 56, 'bnb': 56, 'eth': 1, 'base': 8453, 'arb': 42161, 'op': 10, 'polygon': 137};
                        meta.chainId = cMap[String(meta.chain).toLowerCase()] || 56;
                    }
                    newActive[meta.alphaId] = { ...meta, db_id: row.id };
                    if (!newTokens.includes(meta.alphaId)) newTokens.push(meta.alphaId);
                }
            });
            ACTIVE_CONFIG = newActive;
            ACTIVE_TOKEN_LIST = newTokens;
            console.log(`⚡ Sync Config: ${Object.keys(ACTIVE_CONFIG).length} giải ACTIVE.`);
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
                const res = await axios.get(url, { headers: FAKE_HEADERS });
                let offset = 0;
                if (res.data?.success && res.data.data?.klineInfos) {
                    res.data.data.klineInfos.forEach(k => {
                        const kTs = parseInt(k[0]);
                        if (kTs >= dayStartTs && kTs < startTs) offset += parseFloat(k[5]);
                    });
                }
                START_OFFSET_CACHE[alphaId] = offset;
            } catch (e) {}
        }
    }
}

// ==========================================
// 1.5. THUẬT TOÁN "SNAPSHOT CẮT ĐUÔI" 
// ==========================================
function buildSuffixSum(dataArray) {
    const arr = new Array(1440).fill(0);
    if (!dataArray || dataArray.length === 0) return arr;

    const minuteMap = new Array(1440).fill(0);
    const yesterdayStr = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    dataArray.forEach(k => {
        const candleTs = parseInt(k[0]);
        const dateObj = new Date(candleTs);
        if (dateObj.toISOString().split('T')[0] === yesterdayStr) {
            const startMin = dateObj.getUTCHours() * 60 + dateObj.getUTCMinutes();
            const volPerMin = Number(k[5] || 0) / 5; 
            for (let i = 0; i < 5; i++) {
                if (startMin + i < 1440) minuteMap[startMin + i] += volPerMin;
            }
        }
    });

    let runningSum = 0;
    for (let i = 1439; i >= 0; i--) {
        runningSum += minuteMap[i];
        arr[i] = runningSum;
    }
    return arr;
}

async function runYesterdaySnapshot() {
    console.log("📸 Bắt đầu chụp Snapshot cắt đuôi...");
    for (let symbol of ACTIVE_TOKEN_LIST) {
        try {
            const conf = ACTIVE_CONFIG[symbol];
            if (!conf || !conf.contract) continue;

            const [resTot, resLim] = await Promise.all([
                axios.get(API_ENDPOINTS.KLINES_TOTAL(conf.chainId || 56, conf.contract), { headers: FAKE_HEADERS }).catch(()=>({data:{}})),
                axios.get(API_ENDPOINTS.KLINES_LIMIT(conf.chainId || 56, conf.contract), { headers: FAKE_HEADERS }).catch(()=>({data:{}}))
            ]);

            SNAPSHOT_TAIL_TOTAL[symbol] = buildSuffixSum(resTot.data?.data?.klineInfos || []);
            SNAPSHOT_TAIL_LIMIT[symbol] = buildSuffixSum(resLim.data?.data?.klineInfos || []);
            await sleep(150); 
        } catch (e) {}
    }
    console.log("✅ Snapshot cắt đuôi hoàn tất!");
}

let lastDay = new Date().getUTCDate();
setInterval(() => {
    const nowDay = new Date().getUTCDate();
    if (nowDay !== lastDay) {
        lastDay = nowDay;
        SNAPSHOT_TAIL_TOTAL = {};
        SNAPSHOT_TAIL_LIMIT = {};
        runYesterdaySnapshot();
    }
}, 60000);

// ==========================================
// 2. LOGIC TÍNH TOÁN AI PREDICTION 
// ==========================================
function calculateAiPrediction(staticData, accumulatedData) {
    const currentVol = accumulatedData.totalAccumulated;
    const limitVol = accumulatedData.limitAccumulated;
    const usingLimit = (limitVol > 0);

    let projectedVol = currentVol;
    let isFinalized = false;
    const now = new Date();
    
    if (staticData.end) {
        let endTimeStr = staticData.endTime && staticData.endTime.includes(':') ? staticData.endTime : "13:00";
        if (endTimeStr.length === 5) endTimeStr += ":00";
        const endDate = new Date(`${staticData.end}T${endTimeStr}Z`);
        const freezeDate = new Date(endDate.getTime() - 1 * 60 * 1000); 

        if (now >= freezeDate) isFinalized = true;

        if (now < endDate && !isFinalized) {
            const diffSeconds = (endDate.getTime() - now.getTime()) / 1000;
            let velocity = 0;
            if (accumulatedData.analysis && accumulatedData.analysis.speed60s) { // Dùng speed60s mới
                velocity = accumulatedData.analysis.speed60s;
                if (usingLimit && currentVol > 0 && staticData.total_accumulated_volume > 0) {
                     velocity = velocity * (currentVol / staticData.total_accumulated_volume);
                }
            }
            if (velocity > 0) projectedVol += (velocity * diffSeconds);
        } else {
            isFinalized = true;
        }
    }

    let effectiveVol = projectedVol;
    const ruleType = staticData.ruleType || "trade_all";
    if (ruleType === 'buy_only') effectiveVol = projectedVol / 2;
    if (ruleType === 'trade_x4') effectiveVol = projectedVol * 4;

    let ticketSize = 0;
    if (usingLimit && accumulatedData.limitTx > 0) ticketSize = currentVol / accumulatedData.limitTx;
    else if (accumulatedData.totalTx > 0) ticketSize = currentVol / accumulatedData.totalTx;
    else if (accumulatedData.analysis && accumulatedData.analysis.ticket3s) ticketSize = accumulatedData.analysis.ticket3s; // Dùng ticket3s mới

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

    const finalTarget = (effectiveVol * finalK) / winners;
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
        rule: `Global Standard${adminNote} (K=${finalK.toFixed(2)})`,
        R: finalK,
        status_label: isFinalized ? "FINALIZED" : "LIVE PREDICTION",
        debug_info: `Vol:${(effectiveVol/1e9).toFixed(2)}B Ticket:$${Math.round(ticketSize)}`,
        is_finalized: isFinalized
    };
}

// ==========================================
// 3. AUTO-FINALIZE (CHỐT SỔ TỰ ĐỘNG)
// ==========================================
async function finalizeTournament(alphaId, finalData, predictionResult) {
    const config = ACTIVE_CONFIG[alphaId];
    if (!config || HISTORY_CACHE[alphaId]) return;

    console.log(`🏁 ĐANG CHỐT SỔ GIẢI ĐẤU: ${alphaId} ...`);
    const finalObj = {
        ...config,
        total_accumulated_volume: finalData.totalAccumulated,
        limit_accumulated_volume: finalData.limitAccumulated,
        limit_accumulated_tx: finalData.limitTx,
        tx_count: finalData.totalTx,
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
    delete ACTIVE_CONFIG[alphaId];

    try {
        const cmd = new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: HISTORY_FILE_KEY, Body: JSON.stringify(HISTORY_CACHE), ContentType: "application/json" });
        await s3Client.send(cmd);
        console.log(`✅ Đã lưu kết quả ${alphaId} lên R2.`);
    } catch (e) {}
}

// ==========================================
// 4. VÒNG LẶP REALTIME & TÍCH HỢP "AI 3-9-60"
// ==========================================
async function loopRealtime() {
    try {
        const [resTot, resLim] = await Promise.all([
            axios.get(API_ENDPOINTS.BULK_TOTAL, { headers: FAKE_HEADERS, timeout: 5000 }),
            axios.get(API_ENDPOINTS.BULK_LIMIT, { headers: FAKE_HEADERS, timeout: 5000 })
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
                if (!id || !ACTIVE_CONFIG[id]) return; // Chỉ tính toán cho các token đang ACTIVE
                
                const rollVolTot = parseFloat(t.volume24h || 0);
                const rollVolLim = limitMap[id] || 0;
                const currentPrice = parseFloat(t.price || 0);
                const currentTx = limitTxMap[id] || 0;

                const tailTot = SNAPSHOT_TAIL_TOTAL[id]?.[currentMinute] || 0;
                const tailLim = SNAPSHOT_TAIL_LIMIT[id]?.[currentMinute] || 0;

                let dailyTot = Math.max(0, rollVolTot - tailTot);
                let dailyLim = Math.max(0, rollVolLim - tailLim);
                if (dailyTot < dailyLim) dailyTot = dailyLim; 

                // ====================================================
                // 🧠 BỘ NÃO AI: THỰC THI KHẨU QUYẾT MỚI (BẮT RÂU NẾN)
                // ====================================================
                let history = TOKEN_METRICS_HISTORY[id] || [];
                let buyVol3s = 0, sellVol3s = 0, tickVol3s = 0, tickTx3s = 0;

                if (history.length > 0) {
                    const lastData = history[history.length - 1];
                    if (dailyTot >= lastData.v) {
                        tickVol3s = dailyTot - lastData.v;
                        tickTx3s = currentTx - lastData.tx;
                        if (currentPrice >= lastData.p) buyVol3s = tickVol3s;
                        else sellVol3s = tickVol3s;
                    } else {
                        history = []; // Reset qua ngày mới
                    }
                }

                history.push({ ts: currentTs, p: currentPrice, v: dailyTot, tx: currentTx, buyV: buyVol3s, sellV: sellVol3s, tickTx: tickTx3s });
                history = history.filter(h => currentTs - h.ts <= 60000); // Lưu chuẩn 60s
                TOKEN_METRICS_HISTORY[id] = history;

                let spread15s = 0, trend60s = 0, dropFromPeak = 0, netFlow60s = 0, speed60s = 0, ticket3s = 0;

                if (history.length > 1) {
                    const oldest60s = history[0];
                    const newest = history[history.length - 1];

                    // --- 1. KHUNG 60 GIÂY (Toàn cảnh & Dòng tiền) ---
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

                    // CHỈ BÁO TREND CHUẨN NẾN 1 PHÚT
                    if (oldest60s.p > 0) trend60s = ((newest.p - oldest60s.p) / oldest60s.p) * 100;
                    
                    // CHỈ BÁO ĐẢO CHIỀU (Khoảng cách từ Giá hiện tại rơi khỏi Đỉnh 1 phút)
                    if (maxP60 !== -1 && maxP60 > 0) dropFromPeak = ((newest.p - maxP60) / maxP60) * 100; // Ra số âm

                    // --- 2. KHUNG 3 GIÂY (Whale Tracker) ---
                    if (tickTx3s > 0) ticket3s = tickVol3s / tickTx3s;

                    // --- 3. KHUNG 15 GIÂY (Spread thực chiến - Dùng 15s để loại bỏ nhiễu) ---
                    const history15s = history.filter(h => currentTs - h.ts <= 15000);
                    if (history15s.length > 0) {
                        let maxP15 = -1, minP15 = Infinity;
                        history15s.forEach(h => { if(h.p > maxP15) maxP15 = h.p; if(h.p < minP15) minP15 = h.p; });
                        if (minP15 > 0 && maxP15 !== -1 && minP15 !== Infinity) spread15s = ((maxP15 - minP15) / minP15) * 100;
                    }
                }
                // ====================================================

                GLOBAL_MARKET[id] = {
                    p: currentPrice,
                    c: parseFloat(t.percentChange24h || t.priceChangePercent || 0), 
                    r24: rollVolTot,                                               
                    l: parseFloat(t.liquidity || 0),                             
                    mc: parseFloat(t.marketCap || 0),                              
                    h: parseInt(t.holders || t.holderCount || 0),                  
                    v: { dt: dailyTot, dl: dailyLim }, 
                    tx: currentTx, 
                    // Nạp bộ thông số ĐÃ CHUẨN HÓA lên Frontend
                    analysis: { spread: spread15s, trend: trend60s, drop: dropFromPeak, netFlow: netFlow60s, speed: speed60s, ticket: ticket3s } 
                };
            });
        }
    } catch (e) { console.error("⚠️ Lỗi quét API Binance Realtime:", e.message); }
    setTimeout(loopRealtime, 3000); 
}

// ==========================================
// 6. API TRẢ DỮ LIỆU CHO FRONTEND
// ==========================================
app.get('/api/market-data', (req, res) => {
    res.json({ success: true, count: Object.keys(GLOBAL_MARKET).length, data: GLOBAL_MARKET });
});

app.get('/api/competition-data', (req, res) => {
    const responseData = {};
    const nowStr = new Date().toISOString().split('T')[0];
    Object.assign(responseData, HISTORY_CACHE);

    Object.keys(ACTIVE_CONFIG).forEach(alphaId => {
        const config = ACTIVE_CONFIG[alphaId];
        const base = BASE_HISTORY_DATA[alphaId] || {};
        const real = GLOBAL_MARKET[alphaId] || {};
        
        const offset = parseFloat(START_OFFSET_CACHE[alphaId] || 0);
        let effectiveTodayVol = parseFloat(real.v?.dt || 0);
        if (config.start === nowStr) effectiveTodayVol = Math.max(0, effectiveTodayVol - offset);

        const totalAccumulated = parseFloat(base.base_total_vol || 0) + effectiveTodayVol;
        const limitAccumulated = parseFloat(base.base_limit_vol || 0) + parseFloat(real.v?.dl || 0);  
        
        const historyArr = base.history_total ? [...base.history_total] : [];
        const existingToday = historyArr.find(h => h.date === nowStr);
        if (existingToday) existingToday.vol = effectiveTodayVol;
        else historyArr.push({ date: nowStr, vol: effectiveTodayVol });

        const realTx = parseFloat(real.tx || 0);
        const limitTxAccumulated = parseFloat(base.base_limit_tx || 0) + realTx; 
        const totalTxAccumulated = parseFloat(base.base_total_tx || 0) + realTx;

        const aiResult = calculateAiPrediction(config, {
            totalAccumulated, limitAccumulated, limitTx: limitTxAccumulated, totalTx: totalTxAccumulated, analysis: real.analysis || {}
        });

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
            market_analysis: real.analysis || { label: "WAIT..." }, // Trả thẳng 5 thông số xịn về Web
            ai_prediction: aiResult
        };

        if (aiResult.is_finalized) {
            finalizeTournament(alphaId, { totalAccumulated, limitAccumulated, limitTx: limitTxAccumulated, totalTx: totalTxAccumulated }, aiResult);
        }
    });

    res.json(responseData);
});

app.get('/api/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: "Thiếu tham số url" });
    try {
        const response = await axios.get(targetUrl, { headers: FAKE_HEADERS, timeout: 10000 });
        res.json(response.data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// START SERVER
app.listen(PORT, async () => {
    console.log(`🚀 [Wave Alpha Core] Máy chủ đang chạy tại port ${PORT}`);
    await syncHistoryFromR2();
    await syncActiveConfig();
    await syncBaseData();
    await checkStartOffsets();
    
    await runYesterdaySnapshot();
    
    loopRealtime(); // Chạy duy nhất 1 nhịp đập 3s
    
    setInterval(syncActiveConfig, 5 * 60 * 1000); 
    setInterval(syncBaseData, 30 * 60 * 1000);    
    setInterval(checkStartOffsets, 15 * 60 * 1000); 
});
