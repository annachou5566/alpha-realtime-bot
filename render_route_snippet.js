// ═══════════════════════════════════════════════════════════════════
// ETF FLOWS — paste vào index.js của alpha-realtime-bot
// Chỉ đọc R2, không compute gì — Render không tốn thêm gì đáng kể
// ═══════════════════════════════════════════════════════════════════

// Cache RAM — tránh hit R2 liên tục
let ETF_CACHE = { data: null, ts: 0 };
const ETF_TTL = 60 * 1000; // 60s

app.get('/api/etf-flows', async (req, res) => {
  try {
    const now = Date.now();

    // Trả cache nếu còn mới
    if (ETF_CACHE.data && now - ETF_CACHE.ts < ETF_TTL) {
      return res.json(ETF_CACHE.data);
    }

    // Đọc từ R2
    const cmd  = new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: 'etf-flows.json' });
    const resp = await s3Client.send(cmd);
    const chunks = [];
    for await (const chunk of resp.Body) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));

    // Gắn success flag giống pattern hiện tại
    const out = { success: true, ...data };
    ETF_CACHE = { data: out, ts: now };

    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json(out);

  } catch (err) {
    console.error('[ETF] R2 read error:', err.message);
    // Trả cache cũ nếu có, tránh trả lỗi cho client
    if (ETF_CACHE.data) return res.json(ETF_CACHE.data);
    res.status(503).json({ success: false, error: 'ETF data unavailable' });
  }
});
