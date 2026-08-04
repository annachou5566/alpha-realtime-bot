'use strict';

const fs = require('node:fs');

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);
  if (first < 0 || first !== last) throw new Error(`${label}: expected exactly one canonical match`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

const indexPath = 'index.js';
let source = fs.readFileSync(indexPath, 'utf8');

source = replaceOnce(
  source,
  "    realtimePollMs: envInt('REALTIME_POLL_MS', 60_000, 30_000, 15 * 60_000),\n    limitRefreshMs: envInt('LIMIT_REFRESH_MS', 5 * 60_000, 60_000, 30 * 60_000),\n    configSyncMs: envInt('CONFIG_SYNC_MS', 15 * 60_000, 5 * 60_000, 60 * 60_000),",
  "    // Edge caches market/competition payloads for five minutes. Polling the same\n    // all-token Binance payload every minute only burns Render service bandwidth.\n    realtimePollMs: envInt('REALTIME_POLL_MS', 5 * 60_000, 60_000, 15 * 60_000),\n    limitRefreshMs: envInt('LIMIT_REFRESH_MS', 5 * 60_000, 60_000, 30 * 60_000),\n    configSyncMs: envInt('CONFIG_SYNC_MS', 30 * 60_000, 10 * 60_000, 60 * 60_000),",
  'cache-aligned poll intervals'
);

source = replaceOnce(
  source,
  "    spotTickerIdleMs: envInt('SPOT_TICKER_IDLE_MS', 2 * 60_000, 30_000, 30 * 60_000),\n    tickCacheEnabled: String(process.env.ENABLE_TICK_CACHE || '').toLowerCase() === 'true',",
  "    spotTickerIdleMs: envInt('SPOT_TICKER_IDLE_MS', 2 * 60_000, 30_000, 30 * 60_000),\n    tokenListSyncMs: envInt('TOKEN_LIST_SYNC_MS', 6 * 60 * 60_000, 60 * 60_000, 24 * 60 * 60_000),\n    tickCacheEnabled: String(process.env.ENABLE_TICK_CACHE || '').toLowerCase() === 'true',",
  'token-list sync interval'
);

source = replaceOnce(
  source,
  "        res.setHeader('x-wave-release', 'competition-price-series-v3');",
  "        res.setHeader('x-wave-release', 'competition-price-series-v4');",
  'release marker v4'
);

source = replaceOnce(
  source,
  "let BASE_HISTORY_DATA = {};  \nlet START_OFFSET_CACHE = {};",
  "let BASE_HISTORY_DATA = {};  \nlet BASE_DATA_ETAG = '';\nlet START_OFFSET_CACHE = {};",
  'base data ETag state'
);

source = replaceOnce(
  source,
  "async function syncBaseData() {\n    try {\n        const cmd = new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: \"tournaments-base.json\" });\n        const resp = await s3Client.send(cmd);\n        const str = await resp.Body.transformToString();\n        BASE_HISTORY_DATA = JSON.parse(str);\n        console.log(\"✅ Đã tải Base History (Volume nền).\");\n    } catch (e) { }\n}",
  "async function syncBaseData(options = {}) {\n    const force = options.force === true;\n    const key = 'tournaments-base.json';\n    try {\n        if (!force && BASE_DATA_ETAG) {\n            const head = await s3Client.send(new HeadObjectCommand({\n                Bucket: process.env.R2_BUCKET_NAME,\n                Key: key,\n            }));\n            const nextEtag = String(head && head.ETag || '');\n            if (nextEtag && nextEtag === BASE_DATA_ETAG) {\n                console.log('✅ Base History unchanged; skipped body download.');\n                return { changed: false, etag: nextEtag };\n            }\n        }\n\n        const cmd = new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key });\n        const resp = await s3Client.send(cmd);\n        const str = await resp.Body.transformToString();\n        BASE_HISTORY_DATA = JSON.parse(str);\n        BASE_DATA_ETAG = String(resp && resp.ETag || BASE_DATA_ETAG || '');\n        console.log(\"✅ Đã tải Base History (Volume nền).\");\n        return { changed: true, etag: BASE_DATA_ETAG };\n    } catch (e) {\n        console.warn('⚠️ Base History sync failed:', e.message);\n        return { changed: false, error: e.message };\n    }\n}",
  'conditional base data sync'
);

source = replaceOnce(
  source,
  "    await syncBaseData();",
  "    await syncBaseData({ force: true });",
  'startup base force load'
);

source = replaceOnce(
  source,
  "    setInterval(syncBinanceTokenList, 60 * 60 * 1000); // 1 tiếng cập nhật danh bạ gốc 1 lần",
  "    setInterval(syncBinanceTokenList, RUNTIME.tokenListSyncMs); // master list changes slowly; default 6h",
  'master token-list interval'
);

fs.writeFileSync(indexPath, source);

const testPath = 'test/index-contract.test.js';
let testSource = fs.readFileSync(testPath, 'utf8');
testSource = replaceOnce(
  testSource,
  "    assert.match(source, /x-wave-release', 'competition-price-series-v3/);",
  "    assert.match(source, /x-wave-release', 'competition-price-series-v4/);\n    assert.match(source, /REALTIME_POLL_MS', 5 \* 60_000/);\n    assert.match(source, /CONFIG_SYNC_MS', 30 \* 60_000/);\n    assert.match(source, /TOKEN_LIST_SYNC_MS', 6 \* 60 \* 60_000/);\n    assert.match(source, /Base History unchanged; skipped body download/);\n    assert.match(source, /syncBaseData\(\{ force: true \}\)/);",
  'cache-aligned polling contracts'
);
fs.writeFileSync(testPath, testSource);
