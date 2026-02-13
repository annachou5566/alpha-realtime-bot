require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");

const app = express();
app.use(cors({ origin: '*' })); // Cho phép mọi Frontend truy cập

const PORT = process.env.PORT || 3000;

// --- CẤU HÌNH R2 (Lấy từ biến môi trường Render - Tuyệt đối bảo mật) ---
const R2_CONFIG = {
    region: "auto",
    endpoint: process.env.R2_ENDPOINT_URL,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    }
};
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;

// Khởi tạo S3 Client
const s3Client = new S3Client(R2_CONFIG);

// --- BỘ NHỚ RAM (CACHE) ---
let TOKEN_CACHE = {}; 
let BASE_METADATA = {}; // Lưu dữ liệu gốc từ file R2 (để map tên, icon...)

// Header giả lập trình duyệt
const BINANCE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://www.binance.com/en/alpha',
    'Origin': 'https://www.binance.com'
};

// --- HÀM 1: TẢI FILE GỐC TỪ R2 (5 PHÚT/LẦN) ---
async function fetchBaseDataFromR2() {
    if (!R2_BUCKET_NAME) return;
    try {
        // console.log("⏳ Syncing market-data.json from R2...");
        const command = new GetObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: "market-data.json"
        });
        const response = await s3Client.send(command);
        const str = await response.Body.transformToString();
        const json = JSON.parse(str);
        
        // Map dữ liệu để tra cứu nhanh
        if (json.data && Array.isArray(json.data)) {
            json.data.forEach(item => {
                // Key trong file Python cũ là 's' (symbol) hoặc 'i' (id)
                // Ta lưu lại để dùng nếu cần
                const key = item.s || item.symbol; 
                if (key) BASE_METADATA[key] = item;
            });
        }
        // console.log(`✅ Metadata Synced: ${Object.keys(BASE_METADATA).length} tokens`);
    } catch (error) {
        console.error("❌ R2 Sync Error:", error.message);
    }
}

// --- HÀM 2: LẤY GIÁ REALTIME TỪ API TOKEN LIST (3 GIÂY/LẦN) ---
async function fetchRealtimePrices() {
    // API "Token List" bạn cung cấp - Lấy tất cả trong 1 lần gọi
    const url = "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list";
    
    try {
        const response = await axios.get(url, { headers: BINANCE_HEADERS, timeout: 2500 });
        const result = response.data;

        if (result.success && Array.isArray(result.data)) {
            const now = Date.now();
            
            result.data.forEach(token => {
                // Tạo key chuẩn: ALPHA_175USDT
                const symbolKey = `${token.alphaId}${token.symbol}`; 
                
                const currentPrice = parseFloat(token.price || 0);
                
                // --- LOGIC ANTI-CRASH (CHỐNG SẬP) ---
                // Lấy giá cũ trong Cache
                const oldData = TOKEN_CACHE[symbolKey] || {};
                const oldPrice = oldData.p || currentPrice;

                let status = "PRIME"; // Trạng thái bình thường
                let spreadColor = "#0ECB81"; // Xanh (Spread ổn)
                let spreadBg = "rgba(14, 203, 129, 0.1)";

                // Tính % thay đổi giá so với 3 giây trước
                let delta = 0;
                if (oldPrice > 0) delta = (currentPrice - oldPrice) / oldPrice;

                // CẢNH BÁO 1: Giảm > 0.5% trong 3s -> Trượt giá
                if (delta < -0.005) {
                    status = "SLIPPAGE";
                    spreadColor = "#F6465D"; // Đỏ nhạt
                    spreadBg = "rgba(246, 70, 93, 0.2)";
                }
                // CẢNH BÁO 2: Giảm > 1.5% trong 3s -> Sập mạnh
                if (delta < -0.015) {
                    status = "DUMPING";
                    spreadColor = "#FF003C"; // Đỏ đậm
                    spreadBg = "rgba(255, 0, 60, 0.4)";
                }
                
                // Lưu vào RAM
                TOKEN_CACHE[symbolKey] = {
                    s: symbolKey,
                    p: currentPrice,                    // Giá Realtime
                    v: parseFloat(token.volume24h || 0), // Volume 24h
                    c: parseFloat(token.percentChange24h || 0), // % đổi 24h
                    st: status,                         // Trạng thái (PRIME/DUMP)
                    sc: spreadColor,                    // Màu chữ spread
                    sb: spreadBg,                       // Màu nền spread
                    t: now                              // Thời gian cập nhật
                };
            });
        }
    } catch (error) {
        console.error("⚠️ Binance API Error:", error.message);
        // Không xóa Cache -> Frontend vẫn hiện giá cũ thay vì lỗi
    }
}

// --- KHỞI CHẠY ---
fetchBaseDataFromR2();      // Chạy ngay lần đầu
fetchRealtimePrices();      // Chạy ngay lần đầu

// Đặt lịch
setInterval(fetchRealtimePrices, 3000);     // 3 Giây/lần (Realtime)
setInterval(fetchBaseDataFromR2, 300000);   // 5 Phút/lần (R2 Sync)

// --- API CHO FRONTEND ---
app.get('/api/prices', (req, res) => {
    res.json({
        success: true,
        ts: Date.now(),
        data: TOKEN_CACHE
    });
});

app.get('/', (req, res) => res.send('Alpha Realtime Server is Running!'));

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});