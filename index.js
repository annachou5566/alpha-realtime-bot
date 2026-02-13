require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");

const app = express();
const PORT = process.env.PORT || 3000;
const API_SECRET_KEY = process.env.API_SECRET_KEY || 'WaveAlpha_S3cur3_P@ssw0rd_5566';

app.use(cors({ origin: '*' }));

// --- BỘ NHỚ TẠM (RAM) ---
let PRICE_CACHE = {}; 
let TOKEN_CACHE = null;
let LAST_TOKEN_SYNC = 0;

// --- CẤU HÌNH R2 ---
const s3Client = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT_URL,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    }
});

// ==========================================
// 📈 VÒNG LẶP LẤY GIÁ DUY NHẤT (WORKER)
// ==========================================
async function singleWorkerLoop() {
    try {
        const url = "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list";
        const res = await axios.get(url, { timeout: 5000 });

        if (res.data && res.data.success) {
            const tokens = res.data.data;
            const newCache = {}; 

            tokens.forEach(t => {
                const id = t.alphaId ? t.alphaId.replace("ALPHA_", "") : null;
                if (!id) return;

                const price = parseFloat(t.price || 0);
                const symbol = (t.symbol || "").toUpperCase().trim();

                // Lưu giá kèm Tên (Symbol) để Web dễ khớp lệnh
                newCache[id] = {
                    p: price,
                    s: symbol,
                    t: Date.now()
                };
            });

            PRICE_CACHE = newCache; 
            
            // Log duy nhất để bạn theo dõi trên Render
            const artx = tokens.find(t => t.symbol === 'ARTX');
            console.log(`✅ [REALTIME] ARTX: ${artx ? artx.price : 'N/A'} | Lúc: ${new Date().toLocaleTimeString()}`);
        }
    } catch (e) {
        console.error("❌ Lỗi Binance:", e.message);
    } finally {
        // Chạy lại sau 3 giây
        setTimeout(singleWorkerLoop, 3000);
    }
}

// ==========================================
// 🛣️ ĐỊNH TUYẾN API
// ==========================================

// Middleware bảo mật
const checkKey = (req, res, next) => {
    const key = req.headers['x-api-key'];
    if (key !== API_SECRET_KEY) return res.status(403).json({success: false, msg: "Sai Key"});
    next();
};

// API Lấy giá
app.get('/api/prices', checkKey, (req, res) => {
    res.json({ success: true, data: PRICE_CACHE });
});

// API Lấy danh sách Token từ R2
app.get('/api/tokens', checkKey, async (req, res) => {
    try {
        // Cache danh sách token trong 10 phút để tiết kiệm request R2
        if (TOKEN_CACHE && (Date.now() - LAST_TOKEN_SYNC < 600000)) {
            return res.json({ success: true, data: TOKEN_CACHE });
        }
        
        const cmd = new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: "market-data.json" });
        const resp = await s3Client.send(cmd);
        const str = await resp.Body.transformToString();
        TOKEN_CACHE = JSON.parse(str).data || [];
        LAST_TOKEN_SYNC = Date.now();
        
        res.json({ success: true, data: TOKEN_CACHE });
    } catch (e) { 
        res.status(500).json({success: false, msg: e.message}); 
    }
});

// Trang kiểm tra trạng thái
app.get('/', (req, res) => {
    res.send(`Server Alpha is running. Last update: ${new Date().toLocaleTimeString()}`);
});

app.listen(PORT, () => {
    console.log(`🚀 Server LIVE at port ${PORT}`);
    singleWorkerLoop(); 
});
