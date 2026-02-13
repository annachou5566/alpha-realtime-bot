require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CẤU HÌNH MẬT KHẨU (LẤY TỪ RENDER) ---
// Nếu trên Render không đặt biến này, nó sẽ dùng mặc định là 'wave-alpha-secret-2026'
const API_SECRET_KEY = process.env.API_SECRET_KEY || 'wave-alpha-secret-2026';

// --- LỚP BẢO VỆ 1: RATE LIMIT (Chống Spam) ---
const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, 
    max: 120, // Cho phép 120 request/phút (thoải mái cho Frontend gọi 3s/lần)
    message: { status: "error", message: "Too many requests, please try again later." }
});
app.use(limiter);

// --- LỚP BẢO VỆ 2: CORS (Chống web lạ) ---
const allowedOrigins = [
    'https://wave-alpha.pages.dev',

];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            return callback(new Error('Blocked by CORS'), false);
        }
        return callback(null, true);
    }
}));

// --- LỚP BẢO VỆ 3: API KEY CHECK (CÁI BẠN CẦN) ---
// Đây là "người bảo vệ" chặn cửa
const apiKeyMiddleware = (req, res, next) => {
    // 1. Lấy chìa khóa từ Header người gửi
    const clientKey = req.headers['x-api-key'];

    // 2. So sánh với chìa khóa gốc của Server
    if (!clientKey || clientKey !== API_SECRET_KEY) {
        // Nếu sai hoặc không có chìa -> Đuổi về ngay
        return res.status(403).json({ 
            success: false, 
            message: "⛔ ACCESS DENIED." 
        });
    }
    
    // 3. Nếu đúng -> Cho đi tiếp
    next();
};

// --- LOGIC LẤY GIÁ (GIỮ NGUYÊN) ---
const BINANCE_API_URL = "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list";
let PRICE_CACHE = {}; 

async function workerLoop() {
    try {
        const response = await axios.get(BINANCE_API_URL, { 
            headers: { 'User-Agent': 'Mozilla/5.0' }, 
            timeout: 2500 
        });
        const result = response.data;
        if (result.success && Array.isArray(result.data)) {
            result.data.forEach(token => {
                const symbolKey = token.symbol ? token.symbol.toUpperCase().trim() : null;
                if (!symbolKey) return;
                
                const currentPrice = parseFloat(token.price || 0);
                const oldData = PRICE_CACHE[symbolKey] || {};
                const oldPrice = oldData.p || currentPrice;

                let status = "NORMAL";
                let color = "#0ECB81";
                
                let delta = 0;
                if (oldPrice > 0) delta = (currentPrice - oldPrice) / oldPrice;

                if (delta < -0.005) { status = "SLIPPAGE"; color = "#F6465D"; }
                if (delta < -0.015) { status = "DUMPING"; color = "#FF003C"; }
                if (delta > 0.005) { status = "PUMPING"; color = "#00F0FF"; }

                PRICE_CACHE[symbolKey] = {
                    p: currentPrice,
                    st: status,
                    cl: color,
                    sc: color, // Map cho code frontend cũ
                    sb: (status === 'DUMPING') ? 'rgba(255, 0, 60, 0.2)' : 'rgba(14, 203, 129, 0.1)', // Thêm background color
                    t: Date.now()
                };
            });
        }
    } catch (e) { console.error("Binance Error"); }
}
workerLoop();
setInterval(workerLoop, 3000);

// --- API PUBLIC (ĐÃ ĐƯỢC BẢO VỆ BỞI MIDDLEWARE) ---
// Chèn 'apiKeyMiddleware' vào giữa đường đi
app.get('/api/prices', apiKeyMiddleware, (req, res) => {
    res.json({
        success: true,
        ts: Date.now(),
        data: PRICE_CACHE
    });
});

app.get('/', (req, res) => res.send('Alpha Secure Server is Running.'));

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
