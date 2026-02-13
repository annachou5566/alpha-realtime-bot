require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");

const app = express();
const PORT = process.env.PORT || 3000;

// Mật khẩu truy cập API (Cấu hình trên Environment Render hoặc dùng mặc định)
const API_SECRET_KEY = process.env.API_SECRET_KEY || 'WaveAlpha_S3cur3_P@ssw0rd_5566';

// ==========================================
// 🛡️ CẤU HÌNH BẢO MẬT & LƯU LƯỢNG
// ==========================================
app.use(cors({ origin: '*' })); // Cho phép Web gọi API

const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 phút
    max: 500, // Tăng giới hạn lên 500 request/phút
    message: { success: false, message: "⚠️ Quá nhiều yêu cầu, vui lòng thử lại sau." }
});
app.use(limiter);

// Middleware kiểm tra chìa khóa (API Key)
const apiKeyMiddleware = (req, res, next) => {
    const clientKey = req.headers['x-api-key'];
    if (!clientKey || clientKey !== API_SECRET_KEY) {
        return res.status(403).json({ success: false, message: "⛔ Truy cập bị từ chối: Sai API Key!" });
    }
    next();
};

// ==========================================
// ☁️ CẤU HÌNH CLOUDFLARE R2
// ==========================================
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

// Cache cho danh sách Token từ R2 (Lưu 10 phút)
let TOKEN_CACHE = null;
let LAST_TOKEN_SYNC = 0;
const TOKEN_CACHE_DURATION = 10 * 60 * 1000; 

// ==========================================
// 📈 CẤU HÌNH REALTIME PRICES (BINANCE)
// ==========================================
const BINANCE_API_URL = "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list";
let PRICE_CACHE = {}; 
let lastWorkerRun = "Chưa chạy";

/**
 * Vòng lặp lấy giá từ Binance - Tối ưu chống treo
 */
/**
 * Vòng lặp lấy giá từ Binance - Phiên bản chuẩn chỉnh nhất
 */
/**
 * VÒNG LẶP LẤY GIÁ TỪ BINANCE - PHIÊN BẢN CHUẨN KHỚP TÊN (SYMBOL)
 * Chức năng: Lấy giá, tính toán PUMP/DUMP và gửi kèm Symbol để Frontend dễ khớp lệnh.
 */
async function workerLoop() {
    try {
        const response = await axios.get(BINANCE_API_URL, { 
            headers: { 'User-Agent': 'Mozilla/5.0' }, 
            timeout: 5000 
        });

        if (response && response.data && response.data.success) {
            const tokens = response.data.data;
            let artxLog = "N/A";

            tokens.forEach(token => {
                // 1. Chuẩn hóa ID (Bỏ chữ ALPHA_)
                const id = token.alphaId ? token.alphaId.replace("ALPHA_", "") : null;
                if (!id) return;

                // 2. Lấy Tên Token (Ví dụ: ARTX, GORILLA) - Đây là chìa khóa để khớp lệnh
                const symbol = (token.symbol || "").toUpperCase().trim();
                
                // 3. Xử lý giá
                const currentPrice = parseFloat(token.price || 0);
                const oldData = PRICE_CACHE[id] || {};
                const oldPrice = oldData.p || currentPrice;

                // 4. Logic màu sắc & trạng thái
                let status = "NORMAL";
                let color = "#0ECB81"; // Xanh lá
                
                if (currentPrice < oldPrice) {
                    status = "SLIPPAGE";
                    color = "#F6465D"; // Đỏ
                } else if (currentPrice > oldPrice) {
                    status = "PUMPING";
                    color = "#00F0FF"; // Xanh dương (Khi tăng)
                }

                // 5. Lưu vào RAM (Gửi thêm trường 's' là Symbol về cho Web)
                PRICE_CACHE[id] = {
                    p: currentPrice,           // Giá
                    s: symbol,                 // TÊN TOKEN (QUAN TRỌNG NHẤT)
                    st: status,                // Trạng thái
                    cl: color,                 // Màu chữ
                    sb: (color === '#F6465D') ? 'rgba(246, 70, 93, 0.1)' : 
                        (color === '#00F0FF') ? 'rgba(0, 240, 255, 0.1)' : 'rgba(14, 203, 129, 0.1)',
                    t: Date.now()
                };

                if (symbol === "ARTX") artxLog = currentPrice;
            });

            lastWorkerRun = new Date().toLocaleTimeString();
            console.log(`🚀 [Binance] Sync: ${tokens.length} mã | ARTX: ${artxLog} | Lúc: ${lastWorkerRun}`);
        }
    } catch (e) {
        console.error("❌ Lỗi Server Worker:", e.message);
    } finally {
        // Luôn chạy lại sau 3 giây bất kể thành công hay thất bại
        setTimeout(workerLoop, 3000); 
    }
}

// ==========================================
// 🛣️ ĐỊNH TUYẾN API (ROUTES)
// ==========================================

// API 1: Lấy danh sách Token (Tải từ R2 và Cache)
app.get('/api/tokens', apiKeyMiddleware, async (req, res) => {
    try {
        const now = Date.now();
        if (TOKEN_CACHE && (now - LAST_TOKEN_SYNC < TOKEN_CACHE_DURATION)) {
            return res.json({ success: true, data: TOKEN_CACHE, source: 'cache' });
        }

        console.log("📥 Đang làm mới danh sách Token từ R2...");
        const command = new GetObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: "market-data.json"
        });
        
        const response = await s3Client.send(command);
        const str = await response.Body.transformToString();
        const json = JSON.parse(str);
        
        TOKEN_CACHE = json.data || json.tokens || [];
        LAST_TOKEN_SYNC = now;
        
        res.json({ success: true, data: TOKEN_CACHE, source: 'r2' });
    } catch (error) {
        console.error("❌ Lỗi R2:", error.message);
        if (TOKEN_CACHE) return res.json({ success: true, data: TOKEN_CACHE, source: 'fallback' });
        res.status(500).json({ success: false, message: "Không thể tải dữ liệu R2" });
    }
});

// API 2: Lấy giá Realtime (Lấy từ RAM - Siêu nhanh)
app.get('/api/prices', apiKeyMiddleware, (req, res) => {
    res.json({
        success: true,
        ts: Date.now(),
        last_sync: lastWorkerRun,
        data: PRICE_CACHE
    });
});

// Kiểm tra Server sống hay chết
app.get('/', (req, res) => {
    res.send(`<h1>Alpha Realtime Server is Online</h1><p>Last Sync: ${lastWorkerRun}</p>`);
});

// ==========================================
// 🏁 KHỞI CHẠY SERVER
// ==========================================
app.listen(PORT, () => {
    console.log(`---`);
    console.log(`✅ Server đang chạy tại cổng: ${PORT}`);
    console.log(`🔑 API Key bảo mật: ${API_SECRET_KEY}`);
    console.log(`---`);
    
    // Kích hoạt vòng lặp lấy giá ngay lập tức
    workerLoop();
});
