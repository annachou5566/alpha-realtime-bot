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

const HISTORY_FILE_KEY = "finalized_history.json";

// --- HÀM TIỆN ÍCH ---
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ==========================================
// 1. CÁC JOB ĐỒNG BỘ DỮ LIỆU NỀN
// ==========================================

// JOB A: Lấy Kho Lịch Sử từ R2 (Chạy 1 lần lúc khởi động)
async function syncHistoryFromR2() {
    try {
        const cmd = new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: HISTORY_FILE_KEY });
        const resp = await s3Client.send(cmd);
        const str = await resp.Body.transformToString();
        HISTORY_CACHE = JSON.parse(str);
        console.log(`📚 Đã tải HISTORY từ R2: ${Object.keys(HISTORY_CACHE).length} giải đấu.`);
    } catch (e) {
        console.log("ℹ️ R2 History trống hoặc chưa tạo được (Sẽ thử lại sau).", e.message);
        HISTORY_CACHE = {}; 
    }
}

// JOB B: Lấy Config giải ĐANG CHẠY từ Supabase
async function syncActiveConfig() {
    try {
        const todayStr = new Date().toISOString().split('T')[0];
        const { data, error } = await supabase.from('tournaments').select('id, data').neq('id', -1);

        if (error) throw error;
        if (data) {
            const newActive = {};
            data.forEach(row => {
                const meta = row.data || {};
                
                // Logic lọc giải Active
                let isActive = true;
                if (meta.ai_prediction && meta.ai_prediction.status_label === 'FINALIZED') isActive = false;
                if (meta.end && meta.end < todayStr) isActive = false;

                // Chỉ lấy giải Active và bắt buộc phải có alphaId để gọi Binance
                if (isActive && meta.alphaId) {
                    newActive[meta.alphaId] = { ...meta, db_id: row.id };
                }
            });
            ACTIVE_CONFIG = newActive;
            console.log(`⚡ Đã đồng bộ ACTIVE Config: ${Object.keys(ACTIVE_CONFIG).length} giải đấu đang chạy.`);
        }
    } catch (e) { console.error("❌ Sync Active Config Error:", e.message); }
}

// JOB C: Lấy Base Volume Data từ R2 (Do Python cập nhật)
async function syncBaseData() {
    try {
        const cmd = new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: "tournaments-base.json" });
        const resp = await s3Client.send(cmd);
        const str = await resp.Body.transformToString();
        BASE_HISTORY_DATA = JSON.parse(str);
        console.log("✅ Đã tải Base History (Volume nền) từ R2.");
    } catch (e) { console.log("ℹ️ Không tìm thấy tournaments-base.json (Sẽ thử lại sau)."); }
}

// JOB D: Tính Offset Volume nếu giải bắt đầu đúng ngày hôm nay
async function checkStartOffsets() {
    const todayStr = new Date().toISOString().split('T')[0];
    
    for (const alphaId in ACTIVE_CONFIG) {
        const conf = ACTIVE_CONFIG[alphaId];
        if (conf.start === todayStr) {
            if (START_OFFSET_CACHE[alphaId]) continue; // Đã tính rồi thì bỏ qua

            const startTimeStr = (conf.startTime || "00:00").includes(":") ? conf.startTime : conf.startTime + ":00";
            const startTs = new Date(`${conf.start}T${startTimeStr}Z`).getTime();
            const dayStartTs = new Date(`${conf.start}T00:00:00Z`).getTime();

            try {
                const url = `https://www.binance.com/bapi/defi/v1/public/alpha-trade/klines?symbol=${alphaId}USDT&interval=1h&startTime=${dayStartTs}&endTime=${startTs}&dataType=aggregate`;
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
// 2. LOGIC TÍNH TOÁN AI PREDICTION 
// ==========================================
function calculateAiPrediction(staticData, accumulatedData) {
    const currentVol = accumulatedData.totalAccumulated;
    const limitVol = accumulatedData.limitAccumulated;
    const usingLimit = (limitVol > 0);

    // --- TIME BONUS LOGIC ---
    let projectedVol = currentVol;
    let isFinalized = false;
    const now = new Date();
    
    if (staticData.end) {
        let endTimeStr = staticData.endTime && staticData.endTime.includes(':') ? staticData.endTime : "13:00";
        if (endTimeStr.length === 5) endTimeStr += ":00";
        const endDate = new Date(`${staticData.end}T${endTimeStr}Z`);
        
        // Mốc đóng băng: 1 phút cuối (Khớp logic Deno)
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

    // --- RULE TYPE LOGIC ---
    let effectiveVol = projectedVol;
    const ruleType = staticData.ruleType || "trade_all";
    if (ruleType === 'buy_only') effectiveVol = projectedVol / 2;
    if (ruleType === 'trade_x4') effectiveVol = projectedVol * 4;

    // --- TICKET SIZE ---
    let ticketSize = 0;
    if (usingLimit && accumulatedData.limitTx > 0) {
        ticketSize = currentVol / accumulatedData.limitTx;
    } else if (accumulatedData.totalTx > 0) {
        ticketSize = currentVol / accumulatedData.totalTx;
    } else if (accumulatedData.analysis && accumulatedData.analysis.ticket) {
        ticketSize = accumulatedData.analysis.ticket;
    }

    // --- HỆ SỐ K & TARGET ---
    const k = 0.93; // Cố định theo yêu cầu
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

    // --- TÍNH DELTA ---
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

    // 1. Ghi đè cập nhật vào Supabase (Backup & Admin View)
    try {
        await supabase.from('tournaments').update({ data: finalObj }).eq('id', config.db_id);
    } catch (e) { console.error("❌ Lỗi ghi chốt sổ lên Supabase:", e.message); }

    // 2. Chuyển nhà từ Active -> History Cache
    HISTORY_CACHE[alphaId] = finalObj;
    delete ACTIVE_CONFIG[alphaId];

    // 3. Upload File History mới nhất lên R2 (Lưu vĩnh viễn)
    try {
        const cmd = new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: HISTORY_FILE_KEY,
            Body: JSON.stringify(HISTORY_CACHE),
            ContentType: "application/json"
        });
        await s3Client.send(cmd);
        console.log(`💾 Đã lưu vĩnh viễn ${alphaId} vào R2 History.`);
    } catch (e) { console.error("❌ Lỗi Upload History lên R2:", e.message); }
}

// ==========================================
// 4. VÒNG LẶP REALTIME (Quét API Binance)
// ==========================================
async function loopRealtime() {
    try {
        const [resTot, resLim] = await Promise.all([
            axios.get("https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list", { headers: FAKE_HEADERS, timeout: 5000 }),
            axios.get("https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list?dataType=limit", { headers: FAKE_HEADERS, timeout: 5000 })
        ]);

        if (resTot.data?.success) {
            const limitMap = {};
            if (resLim.data?.success) {
                resLim.data.data.forEach(t => limitMap[t.alphaId] = parseFloat(t.volume24h || 0));
            }

            resTot.data.data.forEach(t => {
                const id = t.alphaId;
                if (!id) return;
                
                GLOBAL_MARKET[id] = {
                    p: parseFloat(t.price || 0),
                    v: { dt: parseFloat(t.volume24h || 0), dl: limitMap[id] || 0 }, // Dùng Volume 24h hiện tại
                    tx: parseFloat(t.count24h || 0),
                    analysis: GLOBAL_MARKET[id]?.analysis // Giữ nguyên analysis cũ
                };
            });
        }
    } catch (e) { console.error("⚠️ Lỗi quét API Binance Realtime:", e.message); }
    
    setTimeout(loopRealtime, 3000); // Lặp lại sau 3 giây
}

// Analyzer tính Flow, Spread (10s/lần)
async function loopAnalyzer() {
    const activeIds = Object.keys(ACTIVE_CONFIG);
    
    // Quét song song bằng batch nhỏ cho các token đang chạy
    const BATCH_SIZE = 5;
    for (let i = 0; i < activeIds.length; i += BATCH_SIZE) {
        const batch = activeIds.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (id) => {
            try {
                const url = `https://www.binance.com/bapi/defi/v1/public/alpha-trade/klines?symbol=${id}USDT&interval=1m&limit=10`;
                const res = await axios.get(url, { headers: FAKE_HEADERS, timeout: 3000 });
                
                if (res.data?.success && res.data.data?.length > 0) {
                    const klines = res.data.data;
                    const last = klines[klines.length - 1];
                    const high = parseFloat(last[2]), low = parseFloat(last[3]);
                    const spread = low > 0 ? ((high - low) / low) * 100 : 0;

                    const last5 = klines.slice(-5);
                    let sumVol = 0, sumTx = 0;
                    last5.forEach(k => { sumVol += parseFloat(k[7] || 0); sumTx += parseFloat(k[8] || 0); });
                    
                    const speed = sumVol / 300; // $/giây
                    const ticket = sumTx > 0 ? sumVol / sumTx : 0;

                    if (!GLOBAL_MARKET[id]) GLOBAL_MARKET[id] = {};
                    GLOBAL_MARKET[id].analysis = { spread, speed, ticket };
                }
            } catch (e) {}
        }));
        await sleep(200);
    }
    setTimeout(loopAnalyzer, 10000); // Lặp lại sau 10 giây
}

// ==========================================
// 5. API ENDPOINTS (Trục Chính Trả Data Cho Frontend)
// ==========================================
app.get('/api/market-data', (req, res) => {
    res.json({ success: true, count: Object.keys(GLOBAL_MARKET).length, data: GLOBAL_MARKET });
});

app.get('/api/competition-data', (req, res) => {
    const responseData = {};
    const nowStr = new Date().toISOString().split('T')[0];

    // 1. Phục vụ toàn bộ dữ liệu tĩnh HISTORY (Không tốn CPU)
    Object.assign(responseData, HISTORY_CACHE);

    // 2. Phục vụ dữ liệu động ACTIVE (Tính toán Realtime)
    Object.keys(ACTIVE_CONFIG).forEach(alphaId => {
        const config = ACTIVE_CONFIG[alphaId];
        const base = BASE_HISTORY_DATA[alphaId] || {};
        const real = GLOBAL_MARKET[alphaId] || {};
        const offset = START_OFFSET_CACHE[alphaId] || 0;

        const todayVol = real.v?.dt || 0;
        const todayLimit = real.v?.dl || 0;

        // Trừ rác đầu ngày nếu bắt đầu hôm nay
        let effectiveTodayVol = todayVol;
        if (config.start === nowStr) effectiveTodayVol = Math.max(0, todayVol - offset);

        const totalAccumulated = (base.base_total_vol || 0) + effectiveTodayVol;
        const limitAccumulated = (base.base_limit_vol || 0) + todayLimit;
        
        // Tái tạo mảng History để vẽ Chart
        const historyArr = base.history_total ? [...base.history_total] : [];
        const existingToday = historyArr.find(h => h.date === nowStr);
        if (existingToday) existingToday.vol = effectiveTodayVol;
        else historyArr.push({ date: nowStr, vol: effectiveTodayVol });

        // Logic AI
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

        // KÍCH HOẠT CHỐT SỔ NẾU ĐÃ KẾT THÚC
        if (aiResult.is_finalized) {
            finalizeTournament(alphaId, {
                totalAccumulated, limitAccumulated, limitTx: limitTxAccumulated, totalTx: totalTxAccumulated
            }, aiResult);
        }
    });

    res.json(responseData);
});

// START SERVER VÀ CÁC CRON JOBS
app.listen(PORT, () => {
    console.log(`🚀 [Wave Alpha Core] Máy chủ đang chạy tại port ${PORT}`);
    
    // Kích hoạt nạp dữ liệu lần đầu
    syncHistoryFromR2();
    syncActiveConfig();
    syncBaseData();
    checkStartOffsets();
    
    // Kích hoạt vòng lặp Realtime
    loopRealtime();
    loopAnalyzer();
    
    // Chu kỳ cập nhật dữ liệu nền (Giảm tải Egress)
    setInterval(syncActiveConfig, 5 * 60 * 1000); // Cập nhật config Supabase 5 phút/lần
    setInterval(syncBaseData, 30 * 60 * 1000);    // Tải lại Base R2 30 phút/lần
    setInterval(checkStartOffsets, 15 * 60 * 1000); // Quét Offset 15 phút/lần
});
