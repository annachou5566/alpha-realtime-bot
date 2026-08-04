'use strict';

const fs = require('node:fs');

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);
  if (first < 0 || first !== last) {
    throw new Error(`${label}: expected exactly one canonical match`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

const indexPath = 'index.js';
let source = fs.readFileSync(indexPath, 'utf8');

source = replaceOnce(
  source,
  'const { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require("@aws-sdk/client-s3");',
  'const { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require("@aws-sdk/client-s3");',
  'S3 HeadObject import'
);

source = replaceOnce(
  source,
  "    priceSyncMs: envInt('PRICE_SYNC_MS', 15 * 60_000, 5 * 60_000, 60 * 60_000),\n    tickCacheEnabled: String(process.env.ENABLE_TICK_CACHE || '').toLowerCase() === 'true',",
  "    priceSyncMs: envInt('PRICE_SYNC_MS', 15 * 60_000, 5 * 60_000, 60 * 60_000),\n    spotTickerIdleMs: envInt('SPOT_TICKER_IDLE_MS', 2 * 60_000, 30_000, 30 * 60_000),\n    tickCacheEnabled: String(process.env.ENABLE_TICK_CACHE || '').toLowerCase() === 'true',",
  'Spot ticker runtime setting'
);

source = replaceOnce(
  source,
  "const BANDWIDTH = {\n    startedAt: Date.now(),\n    httpOutBytes: 0,\n    httpByRoute: Object.create(null),\n    upstreamInBytes: 0,\n    upstreamByHost: Object.create(null),\n    wsInBytes: 0,\n    wsByStream: Object.create(null),\n    r2ReadBytes: 0,\n    r2WriteBytes: 0,\n    supabaseReadBytes: 0,\n};",
  "const BANDWIDTH = {\n    startedAt: Date.now(),\n    httpOutBytes: 0,\n    httpByRoute: Object.create(null),\n    upstreamInBytes: 0,\n    upstreamByHost: Object.create(null),\n    wsInBytes: 0,\n    wsByStream: Object.create(null),\n    r2ReadBytes: 0,\n    r2WriteBytes: 0,\n    supabaseReadBytes: 0,\n};\n\nlet BANDWIDTH_STEADY_BASELINE = null;\n\nfunction captureBandwidthBaseline() {\n    return {\n        startedAt: Date.now(),\n        httpOutBytes: BANDWIDTH.httpOutBytes,\n        upstreamInBytes: BANDWIDTH.upstreamInBytes,\n        wsInBytes: BANDWIDTH.wsInBytes,\n        r2ReadBytes: BANDWIDTH.r2ReadBytes,\n        r2WriteBytes: BANDWIDTH.r2WriteBytes,\n        supabaseReadBytes: BANDWIDTH.supabaseReadBytes,\n    };\n}\n\nfunction bandwidthDeltaSince(baseline) {\n    if (!baseline) return null;\n    const delta = key => Math.max(0, Number(BANDWIDTH[key] || 0) - Number(baseline[key] || 0));\n    return {\n        startedAt: baseline.startedAt,\n        httpOutBytes: delta('httpOutBytes'),\n        upstreamInBytes: delta('upstreamInBytes'),\n        wsInBytes: delta('wsInBytes'),\n        r2ReadBytes: delta('r2ReadBytes'),\n        r2WriteBytes: delta('r2WriteBytes'),\n        supabaseReadBytes: delta('supabaseReadBytes'),\n    };\n}",
  'steady-state bandwidth baseline'
);

source = replaceOnce(
  source,
  "app.get('/api/bandwidth-stats', (req, res) => {\n    const elapsedHours = Math.max((Date.now() - BANDWIDTH.startedAt) / 3_600_000, 1 / 60);\n    const project750h = bytes => Math.round((bytes / elapsedHours) * 750);\n    res.setHeader('Cache-Control', 'no-store');\n    res.json({\n        startedAt: new Date(BANDWIDTH.startedAt).toISOString(),\n        elapsedHours: Number(elapsedHours.toFixed(2)),\n        bytes: BANDWIDTH,\n        projected750h: {\n            httpOutBytes: project750h(BANDWIDTH.httpOutBytes),\n            serviceInitiatedBytes: project750h(\n                BANDWIDTH.upstreamInBytes + BANDWIDTH.wsInBytes + BANDWIDTH.r2ReadBytes + BANDWIDTH.r2WriteBytes + BANDWIDTH.supabaseReadBytes\n            ),\n        },\n        runtime: RUNTIME,\n    });\n});",
  "app.get('/api/bandwidth-stats', (req, res) => {\n    const elapsedHours = Math.max((Date.now() - BANDWIDTH.startedAt) / 3_600_000, 1 / 60);\n    const project750h = (bytes, hours = elapsedHours) => Math.round((bytes / Math.max(hours, 1 / 60)) * 750);\n    const steadyBytes = bandwidthDeltaSince(BANDWIDTH_STEADY_BASELINE);\n    const steadyElapsedHours = steadyBytes\n        ? Math.max((Date.now() - steadyBytes.startedAt) / 3_600_000, 1 / 60)\n        : null;\n    const steadyState = steadyBytes ? {\n        startedAt: new Date(steadyBytes.startedAt).toISOString(),\n        elapsedHours: Number(steadyElapsedHours.toFixed(2)),\n        bytes: steadyBytes,\n        projected750h: {\n            httpOutBytes: project750h(steadyBytes.httpOutBytes, steadyElapsedHours),\n            serviceInitiatedBytes: project750h(\n                steadyBytes.upstreamInBytes + steadyBytes.wsInBytes + steadyBytes.r2ReadBytes + steadyBytes.r2WriteBytes + steadyBytes.supabaseReadBytes,\n                steadyElapsedHours\n            ),\n        },\n    } : null;\n    res.setHeader('Cache-Control', 'no-store');\n    res.json({\n        startedAt: new Date(BANDWIDTH.startedAt).toISOString(),\n        elapsedHours: Number(elapsedHours.toFixed(2)),\n        bytes: BANDWIDTH,\n        projected750h: {\n            httpOutBytes: project750h(BANDWIDTH.httpOutBytes),\n            serviceInitiatedBytes: project750h(\n                BANDWIDTH.upstreamInBytes + BANDWIDTH.wsInBytes + BANDWIDTH.r2ReadBytes + BANDWIDTH.r2WriteBytes + BANDWIDTH.supabaseReadBytes\n            ),\n        },\n        steadyState,\n        runtime: RUNTIME,\n    });\n});",
  'bandwidth stats steady-state report'
);

source = replaceOnce(
  source,
  "        res.setHeader('x-wave-release', 'competition-price-series-v2');",
  "        res.setHeader('x-wave-release', 'competition-price-series-v3');",
  'release marker v3'
);

source = replaceOnce(
  source,
  "let SNAPSHOT_TAIL_TOTAL = {}; \nlet SNAPSHOT_TAIL_LIMIT = {}; \nlet ACTIVE_TOKEN_LIST = [];",
  "let SNAPSHOT_TAIL_TOTAL = {}; \nlet SNAPSHOT_TAIL_LIMIT = {}; \nlet TAILS_CACHE_ETAG = '';\nlet ACTIVE_TOKEN_LIST = [];",
  'tails cache ETag state'
);

source = replaceOnce(
  source,
  "async function syncTailsFromR2() {\n    try {\n        const cmd = new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: \"tails_cache.json\" });\n        const resp = await s3Client.send(cmd);\n        const str = await resp.Body.transformToString();\n        const data = JSON.parse(str);\n        \n        if (data.total) SNAPSHOT_TAIL_TOTAL = data.total;\n        if (data.limit) SNAPSHOT_TAIL_LIMIT = data.limit;\n        \n        if (MARKET_VOL_HISTORY.length === 0) {\n            let calcDaily = 0;\n            Object.keys(SNAPSHOT_TAIL_TOTAL).forEach(id => {\n                calcDaily += (SNAPSHOT_TAIL_TOTAL[id][0] || 0); \n            });\n            if (calcDaily > 0) {\n                let yStr = new Date(Date.now() - 86400000).toISOString().split('T')[0];\n                MARKET_VOL_HISTORY.push({ date: yStr, daily: calcDaily, rolling: calcDaily });\n            }\n        }\n        console.log(`🦊 Đã tải Tails Cache từ R2.`);\n    } catch (e) {\n        console.error(\"⚠️ Chưa tải được Tails Cache.\");\n    }\n}",
  "async function syncTailsFromR2(options = {}) {\n    const force = options.force === true;\n    const key = 'tails_cache.json';\n    try {\n        if (!force && TAILS_CACHE_ETAG) {\n            const head = await s3Client.send(new HeadObjectCommand({\n                Bucket: process.env.R2_BUCKET_NAME,\n                Key: key,\n            }));\n            const nextEtag = String(head && head.ETag || '');\n            if (nextEtag && nextEtag === TAILS_CACHE_ETAG) {\n                console.log('🦊 Tails Cache unchanged; skipped 24 MB body download.');\n                return { changed: false, etag: nextEtag };\n            }\n        }\n\n        const cmd = new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key });\n        const resp = await s3Client.send(cmd);\n        const str = await resp.Body.transformToString();\n        const data = JSON.parse(str);\n        TAILS_CACHE_ETAG = String(resp && resp.ETag || TAILS_CACHE_ETAG || '');\n        \n        if (data.total) SNAPSHOT_TAIL_TOTAL = data.total;\n        if (data.limit) SNAPSHOT_TAIL_LIMIT = data.limit;\n        \n        if (MARKET_VOL_HISTORY.length === 0) {\n            let calcDaily = 0;\n            Object.keys(SNAPSHOT_TAIL_TOTAL).forEach(id => {\n                calcDaily += (SNAPSHOT_TAIL_TOTAL[id][0] || 0); \n            });\n            if (calcDaily > 0) {\n                let yStr = new Date(Date.now() - 86400000).toISOString().split('T')[0];\n                MARKET_VOL_HISTORY.push({ date: yStr, daily: calcDaily, rolling: calcDaily });\n            }\n        }\n        console.log(`🦊 Đã tải Tails Cache từ R2.`);\n        return { changed: true, etag: TAILS_CACHE_ETAG };\n    } catch (e) {\n        console.error(\"⚠️ Chưa tải được Tails Cache.\", e.message);\n        return { changed: false, error: e.message };\n    }\n}",
  'conditional tails cache sync'
);

source = replaceOnce(
  source,
  "    await syncTailsFromR2();",
  "    await syncTailsFromR2({ force: true });",
  'startup tails force load'
);

source = replaceOnce(
  source,
  "let SPOT_TICKER_SOCKET = null;\nlet SPOT_TICKER_SHOULD_RUN = true;\nlet SPOT_TICKER_LAST_REQUEST_AT = Date.now();\nconst SPOT_TICKER_IDLE_MS = envInt('SPOT_TICKER_IDLE_MS', 15 * 60_000, 5 * 60_000, 60 * 60_000);",
  "let SPOT_TICKER_SOCKET = null;\nlet SPOT_TICKER_SHOULD_RUN = false;\nlet SPOT_TICKER_LAST_REQUEST_AT = 0;\nconst SPOT_TICKER_IDLE_MS = RUNTIME.spotTickerIdleMs;",
  'demand-driven Spot ticker state'
);

source = replaceOnce(
  source,
  "    // Spot Ticker — WS stream thay REST, không bao giờ bị ban api.binance.com\n    connectSpotTickerWS();",
  "    // Spot Ticker is demand-driven. Do not ingest the all-market stream until\n    // /api/spot-tickers is requested; the last complete snapshot remains cached.\n    console.log('💤 [SPOT-WS] Demand-driven; waiting for /api/spot-tickers.');",
  'remove startup Spot ticker connection'
);

source = replaceOnce(
  source,
  "    (async () => {\n        const dryRun = await syncTournamentPriceSeries({ includeHistory: true, maxFetches: 100, dryRun: true });\n        console.log('[PRICE-BACKFILL] startup dry-run', dryRun);\n        if (Number(dryRun.missing || 0) > 0) {\n            const result = await syncTournamentPriceSeries({ includeHistory: true, maxFetches: 100 });\n            console.log('[PRICE-BACKFILL] startup result', result);\n        }\n    })().catch(error => console.warn('Price startup backfill:', error.message));",
  "    (async () => {\n        const dryRun = await syncTournamentPriceSeries({ includeHistory: true, maxFetches: 100, dryRun: true });\n        console.log('[PRICE-BACKFILL] startup dry-run', dryRun);\n        if (Number(dryRun.missing || 0) > 0) {\n            const result = await syncTournamentPriceSeries({ includeHistory: true, maxFetches: 100 });\n            console.log('[PRICE-BACKFILL] startup result', result);\n        }\n    })()\n        .catch(error => console.warn('Price startup backfill:', error.message))\n        .finally(() => {\n            BANDWIDTH_STEADY_BASELINE = captureBandwidthBaseline();\n            console.log('[BW] Steady-state bandwidth window started after startup/backfill.');\n        });",
  'steady-state baseline after startup backfill'
);

fs.writeFileSync(indexPath, source);

const testPath = 'test/index-contract.test.js';
let testSource = fs.readFileSync(testPath, 'utf8');
testSource = replaceOnce(
  testSource,
  "    assert.match(source, /x-wave-release', 'competition-price-series-v2/);",
  "    assert.match(source, /x-wave-release', 'competition-price-series-v3/);\n    assert.match(source, /HeadObjectCommand/);\n    assert.match(source, /Tails Cache unchanged; skipped 24 MB body download/);\n    assert.match(source, /let SPOT_TICKER_SHOULD_RUN = false/);\n    assert.match(source, /let SPOT_TICKER_LAST_REQUEST_AT = 0/);\n    assert.match(source, /Demand-driven; waiting for \\/api\\/spot-tickers/);\n    assert.match(source, /steadyState/);\n    assert.match(source, /BANDWIDTH_STEADY_BASELINE = captureBandwidthBaseline/);",
  'bandwidth hotspot contracts'
);
fs.writeFileSync(testPath, testSource);
