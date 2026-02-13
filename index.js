require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");

const app = express();
const PORT = process.env.PORT || 3000;
const API_SECRET_KEY = process.env.API_SECRET_KEY || 'WaveAlpha_S3cur3_P@ssw0rd_5566';

// --- CẤU HÌNH R2 (Lấy từ biến môi trường Render) ---
const R2_CONFIG = {
    region: "auto",
    endpoint: process.env.R2_ENDPOINT_URL, // VD: https://<accountid>.r2.cloudflarestorage.com
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    }
};
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME; // VD: wave-alpha-data
const s3Client = new S3Client(R2_CONFIG);

// --- MIDDLEWARE BẢO MẬT ---
app.use(cors({ origin: '*' })); // Tạm mở để debug, sau này chặn lại sau
app.use(rateLimit({ windowMs: 60000, max: 200 })); // Chống spam

// Kiểm tra Key
const apiKeyMiddleware = (req, res, next) => {
    const clientKey = req.headers['x-api-key'];
    if (!clientKey || clientKey !== API_SECRET_KEY) {
        return res.status(403).json({ success: false, message: "⛔ Sai API Key!" });
    }
    next();
};

// --- API 1: LẤY DANH SÁCH TOKEN TỪ R2 (Cái bạn đang cần) ---
app.get('/api/tokens', apiKeyMiddleware, async (req, res) => {
    try {
        console.log("📥 Đang tải market-data.json từ R2...");
        const command = new GetObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: "market-data.json"
        });
        
        const response = await s3Client.send(command);
        const str = await response.Body.transformToString();
        const json = JSON.parse(str);
        
        res.json({ success: true, data: json.data || json.tokens || [] });
        console.log("✅ Đã gửi danh sách token cho Frontend.");
    } catch (error) {
        console.error("❌ Lỗi R2:", error);
        res.status(500).json({ success: false, message: "Lỗi tải dữ liệu R2", error: error.message });
    }
});

// --- API 2: REALTIME PRICES (Giữ nguyên) ---
const BINANCE_API_URL = "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list";
let PRICE_CACHE = {}; 

async function workerLoop() {
    try {
        const response = await axios.get(BINANCE_API_URL, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 2500 });
        if (response.data.success) {
            response.data.data.forEach(token => {
                // Logic xử lý giá giữ nguyên như cũ
                const id = token.alphaId ? token.alphaId.replace("ALPHA_", "") : null;
                if (!id) return;
                
                PRICE_CACHE[id] = {
                    p: parseFloat(token.price),
                    st: 'NORMAL', // Tạm để normal cho nhẹ
                    t: Date.now()
                };
            });
        }
    } catch (e) { console.error("Lỗi Binance Worker"); }
}
setInterval(workerLoop, 3000);

app.get('/api/prices', apiKeyMiddleware, (req, res) => {
    res.json({ success: true, ts: Date.now(), data: PRICE_CACHE });
});

app.listen(PORT, () => console.log(`Server chạy port ${PORT}`));
