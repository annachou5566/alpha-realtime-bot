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
// 🎯 KHU VỰC 1: ĐIỀN CÁC ĐƯỜNG LINK API CỦA BẠN VÀO ĐÂY
// =====================================================================
const API_ENDPOINTS = {
    // 1. API Bulk 500 Token (Rolling 24h) - Gọi mỗi 3 giây
    BULK_TOTAL: "https://www.binance.com/bapi/defi/v1/public/alpha-trade/aggTicker24?dataType=aggregate",
    BULK_LIMIT: "https://www.binance.com/bapi/defi/v1/public/alpha-trade/aggTicker24?dataType=limit",

    // 2. API Klines Lịch sử (Dùng để Snapshot Cắt đuôi hôm qua)
    KLINES_TOTAL: (symbol, start, end) => `https://www.binance.com/bapi/defi/v1/public/alpha-trade/klines?symbol=${symbol}USDT&interval=1m&startTime=${start}&endTime=${end}&limit=1500&dataType=aggregate`,
    KLINES_LIMIT: (symbol, start, end) => `https://www.binance.com/bapi/defi/v1/public/alpha-trade/klines?symbol=${symbol}USDT&interval=1m&startTime=${start}&endTime=${end}&limit=1500&dataType=limit`,

    // 3. API Klines 1H (Dùng để tính Offset Rác đầu ngày khai mạc)
    KLINES_1H_OFFSET: (symbol, start, end) => `https://www.binance.com/bapi/defi/v1/public/alpha-trade/klines?symbol=${symbol}USDT&interval=1h&startTime=${start}&endTime=${end}&dataType=aggregate`,

    // 4. API Klines 1M (Dùng cho Analyzer 10s tính Spread, Flow)
    KLINES_1M_ANALYZER: (symbol) => `https://www.binance.com/bapi/defi/v1/public/alpha-trade/klines?symbol=${symbol}USDT&interval=1m&limit=10`
};

// --- CLIENTS ---
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

// --- RAM CACHE (BỘ NHỚ TẠM) ---
let GLOBAL_MARKET = {};      // Realtime Data 500 Token (3s/lần)
let ACTIVE_CONFIG = {};      // Config các giải ĐANG CHẠY (Từ Supabase)
let HISTORY_CACHE = {};      // Các giải ĐÃ KẾT THÚC (Từ R2)
let BASE_HISTORY_DATA = {};  // Dữ liệu volume quá khứ của giải đang chạy (Từ R2)
let START_OFFSET_CACHE = {}; // Offset volume rác đầu ngày

// THÊM BIẾN CHO THUẬT TOÁN CẮT ĐUÔI VOLUME
let SNAPSHOT_TAIL_TOTAL = {}; 
let SNAPSHOT_TAIL_LIMIT = {}; 
let ACTIVE_TOKEN_LIST = [];  // Danh sách token cần cắt đuôi

const HISTORY_FILE_KEY = "finalized_history.json";

// --- HÀM TIỆN ÍCH ---
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
        console.log(`📚 Đã tải HISTORY từ R2: ${Object.keys(HISTORY_CACHE).length} giải đấu.`);
    } catch (e) {
        console.log("ℹ️ R2 History trống hoặc chưa tạo được (Sẽ thử lại sau).");
        HISTORY_CACHE = {}; 
    }
}

async function syncActiveConfig() {
    try {
        const todayStr = new Date().toISOString().split('T')[0];
        const { data, error } = await supabase.from('tournaments').select('id, data').neq('id', -1);

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
                    newActive[meta.alphaId] = { ...meta, db_id: row.id };
                    if (!newTokens.includes(meta.alphaId)) newTokens.push(meta.alphaId);
                }
            });
            ACTIVE_CONFIG = newActive;
            ACTIVE_TOKEN_LIST = newTokens;
            console.log(`⚡ Đã đồng bộ ACTIVE Config: ${Object.keys(ACTIVE_CONFIG).length} giải đấu đang chạy.`);
        }
    } catch (e) { console.error("❌ Sync Active Config Error:", e.message); }
}

async function syncBaseData() {
    try {
        const cmd = new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: "tournaments-base.json" });
        const resp = await s3Client.send(cmd);
        const str = await resp.Body.transformToString();
        BASE_HISTORY_DATA = JSON.parse(str);
        console.log("✅ Đã tải Base History (Volume nền) từ R2.");
    } catch (e) { console.log("ℹ️ Không tìm thấy tournaments-base.json (Sẽ thử lại sau)."); }
}

async function checkStartOffsets() {
    const todayStr = new Date().toISOString().split('T')[0];
    
    for (const alphaId in ACTIVE_CONFIG) {
        const conf = ACTIVE_CONFIG[alphaId];
        if (conf.start === todayStr) {
            if (START_OFFSET_CACHE[alphaId]) continue;

            const startTimeStr = (conf.startTime || "00:00").includes(":") ? conf.startTime : conf.startTime + ":00";
            const startTs = new Date(`${conf.start}T${startTimeStr}Z`).getTime();
            const dayStartTs = new Date(`${conf.start}T00:00:00Z`).getTime();

            try {
                // SỬ DỤNG LINK TỪ CONFIG BÊN TRÊN
                const url = API_ENDPOINTS.KLINES_1H_OFFSET(alphaId, dayStartTs, startTs);
                const res = await axios.get(url, { headers: FAKE_HEADERS });
                let offset = 0;
                if (res.data?.success && res.data.data?.klineInfos) {
                    res.data.data.klineInfos.forEach(k => offset += parseFloat(k[5]));
                }
                START_OFFSET_CACHE[alphaId] = offset;
                console.log(`⚖️ Đã tính Offset Volume cho ${alphaId}: ${offset}`);
            } catch (e) { console.error(`Lỗi tính Offset ${alphaId}:`, e.message); }
        }
    }
}

// ==========================================
// 1.5. THUẬT TOÁN "SNAPSHOT CẮT ĐUÔI"
// ==========================================
function buildSuffixSum(klines) {
    const arr = new Array(1440).fill(0);
    if (!klines || !Array.isArray(klines)) return arr;

    const minuteMap = {};
    klines.forEach(k => {
        const date = new Date(parseInt(k[0]));
        const minuteIndex = date.getUTCHours() * 60 + date.getUTCMinutes();
        minuteMap[minuteIndex] = parseFloat(k[5] || 0); 
    });

    let runningSum = 0;
    for (let i = 1439; i >= 0; i--) {
        runningSum += (minuteMap[i] || 0);
        arr[i] = runningSum;
    }
    return arr;
}

async function runYesterdaySnapshot() {
    console.log("📸 Đang chụp Snapshot dữ liệu hôm qua để cắt đuôi Volume...");
    const yesterday = new Date(Date.now() - 86400000);
    const startTime = new Date(yesterday).setUTCHours(0,0,0,0);
    const endTime = new Date(yesterday).setUTCHours(23,59,59,999);

    for (let symbol of ACTIVE_TOKEN_LIST) {
        try {
            // SỬ DỤNG LINK TỪ CONFIG BÊN TRÊN
            const urlTot = API_ENDPOINTS.KLINES_TOTAL(symbol, startTime, endTime);
            const urlLim = API_ENDPOINTS.KLINES_LIMIT(symbol, startTime, endTime);
            
            const [resTot, resLim] = await Promise.all([
                axios.get(urlTot, { headers: FAKE_HEADERS }),
                axios.get(urlLim, { headers: FAKE_HEADERS })
            ]);

            SNAPSHOT_TAIL_TOTAL[symbol] = buildSuffixSum(resTot.data?.data?.klineInfos);
            SNAPSHOT_TAIL_LIMIT[symbol] = buildSuffixSum(resLim.data?.data?.klineInfos);
            await sleep(100); 
        } catch (e) {}
    }
    console.log("✅ Snapshot hoàn tất!");
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
            if (accumulatedData.analysis && accumulatedData.analysis.speed) {
                velocity = accumulatedData.analysis.speed;
                if (usingLimit && currentVol > 0 && staticData.total_accumulated_volume > 0) {
                     const ratio = currentVol / staticData.total_accumulated_volume;
                     velocity = velocity * ratio;
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
    if (usingLimit && accumulatedData.limitTx > 0) {
        ticketSize = currentVol / accumulatedData.limitTx;
    } else if (accumulatedData.totalTx > 0) {
        ticketSize = currentVol / accumulatedData.totalTx;
    } else if (accumulatedData.analysis && accumulatedData.analysis.ticket) {
        ticketSize = accumulatedData.analysis.ticket;
    }

    const k = 0.93;
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
        rule: `Global Standard${adminNote} (K=${finalK.toFixed(2)}) ${usingLimit ? '[LIMIT DATA]' : ''}`,
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

    console.log(`🏁 ĐANG CHỐT SỔ GIẢI ĐẤU: ${alphaId}...`);

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

    try {
        await supabase.from('tournaments').update({ data: finalObj }).eq('id', config.db_id);
    } catch (e) {}

    HISTORY_CACHE[alphaId] = finalObj;
    delete ACTIVE_CONFIG[alphaId];

    try {
        const cmd = new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: HISTORY_FILE_KEY,
            Body: JSON.stringify(HISTORY_CACHE),
            ContentType: "application/json"
        });
        await s3Client.send(cmd);
    } catch (e) {}
}

// ==========================================
// 4. VÒNG LẶP REALTIME (TÍCH HỢP CẮT ĐUÔI)
// ==========================================
async function loopRealtime() {
    try {
        // SỬ DỤNG LINK TỪ CONFIG BÊN TRÊN
        const [resTot, resLim] = await Promise.all([
            axios.get(API_ENDPOINTS.BULK_TOTAL, { headers: FAKE_HEADERS, timeout: 5000 }),
            axios.get(API_ENDPOINTS.BULK_LIMIT, { headers: FAKE_HEADERS, timeout: 5000 })
        ]);

        if (resTot.data?.success) {
            const now = new Date();
            const currentMinute = now.getUTCHours() * 60 + now.getUTCMinutes();

            const limitMap = {};
            if (resLim.data?.success) {
                resLim.data.data.forEach(t => limitMap[t.alphaId] = parseFloat(t.volume24h || 0));
            }

            resTot.data.data.forEach(t => {
                const id = t.alphaId;
                if (!id) return;
                
                const rollVolTot = parseFloat(t.volume24h || 0);
                const rollVolLim = limitMap[id] || 0;

                // CẮT ĐUÔI VỚI SNAPSHOT
                const tailTot = SNAPSHOT_TAIL_TOTAL[id]?.[currentMinute] || 0;
                const tailLim = SNAPSHOT_TAIL_LIMIT[id]?.[currentMinute] || 0;

                let dailyTot = rollVolTot - tailTot;
                let dailyLim = rollVolLim - tailLim;

                if (dailyTot < 0) dailyTot = rollVolTot * 0.3;
                if (dailyLim < 0) dailyLim = rollVolLim * 0.3;

                GLOBAL_MARKET[id] = {
                    p: parseFloat(t.price || 0),
                    v: { dt: dailyTot, dl: dailyLim }, 
                    tx: parseFloat(t.count24h || 0),
                    analysis: GLOBAL_MARKET[id]?.analysis 
                };
            });
        }
    } catch (e) { console.error("⚠️ Lỗi quét API Binance Realtime:", e.message); }
    
    setTimeout(loopRealtime, 3000); 
}

async function loopAnalyzer() {
    const activeIds = Object.keys(ACTIVE_CONFIG);
    const BATCH_SIZE = 5;
    for (let i = 0; i < activeIds.length; i += BATCH_SIZE) {
        const batch = activeIds.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (id) => {
            try {
                // SỬ DỤNG LINK TỪ CONFIG BÊN TRÊN
                const url = API_ENDPOINTS.KLINES_1M_ANALYZER(id);
                const res = await axios.get(url, { headers: FAKE_HEADERS, timeout: 3000 });
                
                if (res.data?.success && res.data.data?.length > 0) {
                    const klines = res.data.data;
                    const last = klines[klines.length - 1];
                    const high = parseFloat(last[2]), low = parseFloat(last[3]);
                    const spread = low > 0 ? ((high - low) / low) * 100 : 0;

                    const last5 = klines.slice(-5);
                    let sumVol = 0, sumTx = 0;
                    last5.forEach(k => { sumVol += parseFloat(k[7] || 0); sumTx += parseFloat(k[8] || 0); });
                    
                    const speed = sumVol / 300; 
                    const ticket = sumTx > 0 ? sumVol / sumTx : 0;

                    if (!GLOBAL_MARKET[id]) GLOBAL_MARKET[id] = {};
                    GLOBAL_MARKET[id].analysis = { spread, speed, ticket };
                }
            } catch (e) {}
        }));
        await sleep(200);
    }
    setTimeout(loopAnalyzer, 10000); 
}

// ==========================================
// 5. API ENDPOINTS
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
        const offset = START_OFFSET_CACHE[alphaId] || 0;

        const todayVol = real.v?.dt || 0;
        const todayLimit = real.v?.dl || 0;

        let effectiveTodayVol = todayVol;
        if (config.start === nowStr) effectiveTodayVol = Math.max(0, todayVol - offset);

        const totalAccumulated = (base.base_total_vol || 0) + effectiveTodayVol;
        const limitAccumulated = (base.base_limit_vol || 0) + todayLimit;
        
        const historyArr = base.history_total ? [...base.history_total] : [];
        const existingToday = historyArr.find(h => h.date === nowStr);
        if (existingToday) existingToday.vol = effectiveTodayVol;
        else historyArr.push({ date: nowStr, vol: effectiveTodayVol });

        const limitTxAccumulated = (base.base_limit_tx || 0) + (real.tx ? real.tx * 0.5 : 0);
        const totalTxAccumulated = (base.base_total_tx || 0) + (real.tx || 0);

        const aiResult = calculateAiPrediction(config, {
            totalAccumulated,
            limitAccumulated,
            limitTx: limitTxAccumulated,
            totalTx: totalTxAccumulated,
            analysis: real.analysis || {}
        });

        responseData[alphaId] = {
            ...config,
            price: real.p,
            total_accumulated_volume: totalAccumulated,
            limit_accumulated_volume: limitAccumulated,
            real_alpha_volume: effectiveTodayVol,
            real_vol_history: historyArr,
            market_analysis: real.analysis || { label: "WAIT..." },
            ai_prediction: aiResult
        };

        if (aiResult.is_finalized) {
            finalizeTournament(alphaId, {
                totalAccumulated, limitAccumulated, limitTx: limitTxAccumulated, totalTx: totalTxAccumulated
            }, aiResult);
        }
    });

    res.json(responseData);
});

// START SERVER VÀ CÁC CRON JOBS
app.listen(PORT, async () => {
    console.log(`🚀 [Wave Alpha Core] Máy chủ đang chạy tại port ${PORT}`);
    
    await syncHistoryFromR2();
    await syncActiveConfig();
    await syncBaseData();
    await checkStartOffsets();
    
    // Nạp đạn Snapshot cho các giải đang chạy trước khi bắt đầu Realtime
    await runYesterdaySnapshot();
    
    loopRealtime();
    loopAnalyzer();
    
    setInterval(syncActiveConfig, 5 * 60 * 1000); 
    setInterval(syncBaseData, 30 * 60 * 1000);    
    setInterval(checkStartOffsets, 15 * 60 * 1000); 
});
