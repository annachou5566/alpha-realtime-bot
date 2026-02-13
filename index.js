require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");

const app = express();
const PORT = process.env.PORT || 3000;
const API_SECRET_KEY = process.env.API_SECRET_KEY || 'WaveAlpha_S3cur3_P@ssw0rd_5566';

// --- CẤU HÌNH R2 ---
const R2_CONFIG = {
    region: "auto",
    endpoint: process.env.R2_ENDPOINT_URL,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    }
};
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const s3Client = new S3Client(R2_CONFIG);

app.use(cors({ origin: '*' }));
app.use(rateLimit({ windowMs: 60000, max: 300 })); // Tăng giới hạn lên xíu cho thoải mái

// Middleware Key
const apiKeyMiddleware = (req, res, next) => {
    const clientKey = req.headers['x-api-key'];
    if (!clientKey || clientKey !== API_SECRET_KEY) {
        return res.status(403).json({ success: false, message: "⛔ Sai API Key!" });
    }
    next();
};

// ==========================================
// 🚀 TỐI ƯU CACHE CHO DANH SÁCH TOKEN (R2)
// ==========================================
let TOKEN_CACHE = null;       // Biến lưu dữ liệu trong RAM
let LAST_CACHE_TIME = 0;      // Thời điểm lưu cuối cùng
const CACHE_DURATION = 10 * 60 * 1000; // 10 Phút mới phải gọi R2 một lần

app.get('/api/tokens', apiKeyMiddleware, async (req, res) => {
    try {
        const now = Date.now();

        // 1. Nếu đã có Cache và chưa hết hạn (10 phút) -> Trả về luôn
        if (TOKEN_CACHE && (now - LAST_CACHE_TIME < CACHE_DURATION)) {
            // console.log("⚡ Lấy Token từ RAM (Siêu nhanh)");
            return res.json({ success: true, data: TOKEN_CACHE, source: 'cache' });
        }

        // 2. Nếu chưa có hoặc đã hết hạn -> Gọi R2 tải mới
        console.log("📥 Đang tải market-data.json từ R2 (Làm mới Cache)...");
        const command = new GetObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: "market-data.json"
        });
        
        const response = await s3Client.send(command);
        const str = await response.Body.transformToString();
        const json = JSON.parse(str);
        
        // Lưu vào RAM để dùng cho lần sau
        TOKEN_CACHE = json.data || json.tokens || [];
        LAST_CACHE_TIME = now;
        
        res.json({ success: true, data: TOKEN_CACHE, source: 'r2' });
        console.log("✅ Đã cập nhật Cache danh sách token.");

    } catch (error) {
        console.error("❌ Lỗi R2:", error);
        // Nếu R2 lỗi mà trong RAM vẫn còn hàng cũ -> Trả hàng cũ đỡ chống cháy
        if (TOKEN_CACHE) {
             return res.json({ success: true, data: TOKEN_CACHE, source: 'cache-fallback' });
        }
        res.status(500).json({ success: false, message: "Lỗi tải dữ liệu R2", error: error.message });
    }
});

// ==========================================
// REALTIME PRICES (Giữ nguyên không đổi)
// ==========================================
const BINANCE_API_URL = "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list";
let PRICE_CACHE = {}; 

async function workerLoop() {
    try {
        const response = await axios.get(BINANCE_API_URL, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 2500 });
        if (response.data.success) {
            response.data.data.forEach(token => {
                const id = token.alphaId ? token.alphaId.replace("ALPHA_", "") : null;
                if (!id) return;
                PRICE_CACHE[id] = { p: parseFloat(token.price), st: 'NORMAL', cl: '#0ECB81', sb: 'rgba(14, 203, 129, 0.1)' };
            });
        }
    } catch (e) { console.error("Binance Worker Error"); }
}
setInterval(workerLoop, 3000);

app.get('/api/prices', apiKeyMiddleware, (req, res) => {
    res.json({ success: true, ts: Date.now(), data: PRICE_CACHE });
});

app.listen(PORT, () => console.log(`Server chạy port ${PORT}`));
