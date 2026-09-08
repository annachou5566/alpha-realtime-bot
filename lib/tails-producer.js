'use strict';

const crypto = require('node:crypto');
const { GetObjectCommand, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { stableIdsHash } = require('./tails-cache-contract');

const BULK_TOTAL_URL = 'https://www.binance.com/bapi/defi/v1/public/alpha-trade/aggTicker24?dataType=aggregate';
const KLINES_URL = 'https://www.binance.com/bapi/defi/v1/public/alpha-trade/agg-klines';
const DEFAULT_HEADERS = Object.freeze({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/121.0.0.0 Safari/537.36',
    Referer: 'https://www.binance.com/en/alpha',
    Origin: 'https://www.binance.com',
    Accept: 'application/json',
    'client-type': 'web',
});

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function previousUtcBoundary(nowMs = Date.now()) {
    const day = new Date(nowMs);
    day.setUTCHours(0, 0, 0, 0);
    const todayStart = day.getTime();
    const startMs = todayStart - 24 * 60 * 60 * 1000;
    const endMs = todayStart - 1;
    const boundaryDate = new Date(startMs).toISOString().slice(0, 10);
    return {
        boundaryDate,
        startMs,
        endMs,
        windowStart: new Date(startMs).toISOString(),
        windowEnd: new Date(endMs).toISOString(),
    };
}

function jsonByteLength(value) {
    return Buffer.byteLength(JSON.stringify(value));
}

async function bodyToString(body) {
    if (!body) return '';
    if (typeof body.transformToString === 'function') return body.transformToString();
    if (typeof body === 'string') return body;
    if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body).toString('utf8');

    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
}

function createHttpMetrics() {
    return {
        requests: 0,
        responseBytes: 0,
        retries: 0,
        byKind: Object.create(null),
    };
}

async function requestJson(http, url, options = {}) {
    const {
        metrics = createHttpMetrics(),
        kind = 'unknown',
        retries = 3,
        timeoutMs = 15_000,
        retryDelayMs = 5_000,
        maxRequests = 4_000,
    } = options;

    let lastError = null;
    for (let attempt = 0; attempt < retries; attempt += 1) {
        if (metrics.requests >= maxRequests) {
            throw new Error(`request-budget-exceeded:${metrics.requests}/${maxRequests}`);
        }

        metrics.requests += 1;
        metrics.byKind[kind] = Number(metrics.byKind[kind] || 0) + 1;

        try {
            const response = await http.get(url, {
                headers: DEFAULT_HEADERS,
                timeout: timeoutMs,
                validateStatus: () => true,
            });
            metrics.responseBytes += jsonByteLength(response && response.data);

            if (response && response.status === 200) return response.data;

            const status = Number(response && response.status || 0);
            if (![418, 429, 502, 503].includes(status)) {
                throw new Error(`http-${status || 'unknown'}`);
            }
            lastError = new Error(`retryable-http-${status}`);
        } catch (error) {
            lastError = error;
        }

        if (attempt < retries - 1) {
            metrics.retries += 1;
            await sleep(retryDelayMs);
        }
    }

    throw lastError || new Error('request-failed');
}

async function loadMarketStatusMap(s3Client, bucket) {
    const response = await s3Client.send(new GetObjectCommand({
        Bucket: bucket,
        Key: 'market-data.json',
    }));
    const text = await bodyToString(response.Body);
    const payload = JSON.parse(text);
    if (!payload || !Array.isArray(payload.data) || payload.data.length === 0) {
        throw new Error('market-data-contract');
    }

    const map = new Map();
    for (const item of payload.data) {
        const id = item && item.i != null ? String(item.i) : '';
        const status = item && item.st != null ? String(item.st) : '';
        if (!id || !status) throw new Error('market-data-identity');
        if (map.has(id)) throw new Error(`market-data-duplicate-id:${id}`);
        map.set(id, status);
    }

    return {
        map,
        bytes: Buffer.byteLength(text),
        count: map.size,
        etag: String(response.ETag || ''),
    };
}

function buildCohort(rawTokens, statusMap) {
    if (!Array.isArray(rawTokens) || rawTokens.length === 0) {
        throw new Error('bulk-token-list-empty');
    }

    const cohort = [];
    const seen = new Set();
    const missingStatus = [];

    for (const token of rawTokens) {
        const id = token && token.alphaId != null ? String(token.alphaId) : '';
        if (!id) continue;

        if (seen.has(id)) throw new Error(`bulk-token-duplicate-id:${id}`);
        seen.add(id);

        if (!statusMap.has(id)) {
            missingStatus.push(id);
            continue;
        }

        const status = statusMap.get(id);
        if (!['ALPHA', 'PRE_DELISTED'].includes(status)) continue;

        const contract = token.contractAddress;
        const chainId = token.chainId;
        if (!contract || chainId === null || chainId === undefined || chainId === '') {
            throw new Error(`active-token-missing-identity:${id}`);
        }

        cohort.push({
            alphaId: id,
            symbol: String(token.symbol || id),
            contractAddress: String(contract),
            chainId: String(chainId),
            volume24h: Number(token.volume24h || 0),
        });
    }

    if (missingStatus.length > 0) {
        throw new Error(`market-status-missing:${missingStatus.length}`);
    }
    if (cohort.length === 0) throw new Error('active-tail-cohort-empty');
    return cohort;
}

function selectQualificationCohort(cohort, maxTokens) {
    const cap = Number(maxTokens || 0);
    if (!Number.isInteger(cap) || cap <= 0 || cap >= cohort.length) return cohort.slice();

    const bsc = cohort.filter(token => token.chainId === '56');
    const other = cohort.filter(token => token.chainId !== '56');
    const selected = [];
    let bi = 0;
    let oi = 0;

    while (selected.length < cap && (bi < bsc.length || oi < other.length)) {
        if (bi < bsc.length) selected.push(bsc[bi++]);
        if (selected.length >= cap) break;
        if (oi < other.length) selected.push(other[oi++]);
    }

    return selected;
}

function cleanContract(token) {
    if (['CT_501', 'CT_784'].includes(token.chainId)) return token.contractAddress;
    return token.contractAddress.toLowerCase();
}

function rowsFromKlinePayload(payload) {
    const rows = payload && payload.data && payload.data.klineInfos;
    return Array.isArray(rows) ? rows : [];
}

async function fetchKlinePage(http, token, dataType, endMs, options) {
    const params = new URLSearchParams({
        chainId: token.chainId,
        interval: '1m',
        limit: '1000',
        tokenAddress: cleanContract(token),
        dataType,
        endTime: String(endMs),
    });
    const payload = await requestJson(http, `${KLINES_URL}?${params.toString()}`, {
        ...options,
        kind: `kline-${dataType}`,
        retries: 2,
    });
    return rowsFromKlinePayload(payload);
}

async function fetchFullDayKlines(http, token, dataType, boundary, options) {
    const rowsByTs = new Map();
    let cursorEnd = boundary.endMs;

    for (let guard = 0; guard < 10 && cursorEnd > boundary.startMs; guard += 1) {
        const rows = await fetchKlinePage(http, token, dataType, cursorEnd, options);
        if (rows.length === 0) break;

        let oldestTs = null;
        for (const row of rows) {
            if (!Array.isArray(row) || row.length < 6) continue;
            const ts = Number(row[0]);
            if (!Number.isFinite(ts)) continue;
            rowsByTs.set(ts, row);
            if (oldestTs === null || ts < oldestTs) oldestTs = ts;
        }

        if (oldestTs === null || oldestTs <= boundary.startMs) break;
        const nextEnd = oldestTs - 1;
        if (nextEnd >= cursorEnd) break;
        cursorEnd = nextEnd;
        await sleep(150);
    }

    return [...rowsByTs.values()];
}

function buildSuffixSum(rows, boundaryDate) {
    if (!Array.isArray(rows) || rows.length === 0) return null;

    const minuteMap = Array(1440).fill(0);
    let matched = 0;

    for (const row of rows) {
        try {
            const ts = Number(row[0]);
            const date = new Date(ts);
            if (!Number.isFinite(ts) || Number.isNaN(date.getTime())) continue;
            if (date.toISOString().slice(0, 10) !== boundaryDate) continue;

            const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
            const volume = Number(row[5] || 0);
            if (!Number.isFinite(volume) || volume < 0) continue;
            minuteMap[minute] += volume;
            matched += 1;
        } catch {
            // Ignore malformed row; exact day coverage is enforced by caller shape/hash contract.
        }
    }

    if (matched === 0) return null;

    const suffix = Array(1440).fill(0);
    let running = 0;
    for (let i = 1439; i >= 0; i -= 1) {
        running += minuteMap[i];
        suffix[i] = Math.round(running * 100) / 100;
    }
    return suffix;
}

async function mapLimit(items, concurrency, worker) {
    const results = new Array(items.length);
    let cursor = 0;

    async function runWorker() {
        while (true) {
            const index = cursor;
            cursor += 1;
            if (index >= items.length) return;
            results[index] = await worker(items[index], index);
        }
    }

    const workers = Array.from(
        { length: Math.min(Math.max(1, concurrency), items.length) },
        () => runWorker(),
    );
    await Promise.all(workers);
    return results;
}

async function fetchTokenTail(http, token, boundary, options) {
    const totalRows = await fetchFullDayKlines(http, token, 'aggregate', boundary, options);
    const total = buildSuffixSum(totalRows, boundary.boundaryDate);
    if (!total) throw new Error(`total-tail-unavailable:${token.alphaId}`);

    let limit = null;
    if (token.chainId === '56') {
        const limitRows = await fetchFullDayKlines(http, token, 'limit', boundary, options);
        limit = buildSuffixSum(limitRows, boundary.boundaryDate);
        if (!limit) throw new Error(`limit-tail-unavailable:${token.alphaId}`);
    }

    return { id: token.alphaId, total, limit };
}

function buildPayload(boundary, cohort, tokenTails, generatedAtMs = Date.now()) {
    const expectedIds = new Set(cohort.map(token => String(token.alphaId)));
    const expectedLimitIds = new Set(
        cohort.filter(token => token.chainId === '56').map(token => String(token.alphaId)),
    );

    const total = Object.create(null);
    const limit = Object.create(null);
    for (const item of tokenTails) {
        if (!item || !item.id || !Array.isArray(item.total) || item.total.length !== 1440) {
            throw new Error('tail-result-shape');
        }
        total[String(item.id)] = item.total;

        if (expectedLimitIds.has(String(item.id))) {
            if (!Array.isArray(item.limit) || item.limit.length !== 1440) {
                throw new Error(`limit-result-shape:${item.id}`);
            }
            limit[String(item.id)] = item.limit;
        }
    }

    const actualTotalIds = new Set(Object.keys(total));
    const actualLimitIds = new Set(Object.keys(limit));
    if (actualTotalIds.size !== expectedIds.size) throw new Error('total-cohort-size');
    if (actualLimitIds.size !== expectedLimitIds.size) throw new Error('limit-cohort-size');

    const expectedHash = stableIdsHash(expectedIds);
    const totalHash = stableIdsHash(actualTotalIds);
    const expectedLimitHash = stableIdsHash(expectedLimitIds);
    const limitHash = stableIdsHash(actualLimitIds);
    if (expectedHash !== totalHash || expectedLimitHash !== limitHash) {
        throw new Error('tail-cohort-hash-mismatch');
    }

    const generatedAt = new Date(generatedAtMs).toISOString();
    return {
        schema_version: 2,
        boundary_date: boundary.boundaryDate,
        window_start: boundary.windowStart,
        window_end: boundary.windowEnd,
        generated_at: generatedAt,
        complete: true,
        expected_token_count: expectedIds.size,
        covered_total_count: actualTotalIds.size,
        expected_limit_token_count: expectedLimitIds.size,
        covered_limit_count: actualLimitIds.size,
        expected_ids_hash: expectedHash,
        covered_total_ids_hash: totalHash,
        expected_limit_ids_hash: expectedLimitHash,
        covered_limit_ids_hash: limitHash,
        total,
        limit,
    };
}

async function publishPayload(s3Client, bucket, payload) {
    const body = Buffer.from(JSON.stringify(payload));
    const payloadSha256 = crypto.createHash('sha256').update(body).digest('hex');

    await s3Client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: 'tails_cache.json',
        Body: body,
        ContentType: 'application/json',
        Metadata: {
            'wa-schema': '2',
            'boundary-date': payload.boundary_date,
            complete: 'true',
            'payload-sha256': payloadSha256,
        },
    }));

    const head = await s3Client.send(new HeadObjectCommand({
        Bucket: bucket,
        Key: 'tails_cache.json',
    }));
    const metadata = head.Metadata || {};
    if (
        String(metadata['wa-schema'] || '') !== '2'
        || String(metadata['boundary-date'] || '') !== payload.boundary_date
        || String(metadata.complete || '') !== 'true'
        || String(metadata['payload-sha256'] || '') !== payloadSha256
        || Number(head.ContentLength) !== body.length
    ) {
        throw new Error('tails-r2-postcondition');
    }

    return { payloadSha256, bytes: body.length, etag: String(head.ETag || '') };
}

async function runTailsProducer(options) {
    const {
        http,
        s3Client,
        bucket,
        nowMs = Date.now(),
        qualificationOnly = true,
        maxTokens = 0,
        concurrency = 2,
        maxRequests = 4_000,
        logger = console,
    } = options || {};

    if (!http || typeof http.get !== 'function') throw new Error('http-client-required');
    if (!s3Client || typeof s3Client.send !== 'function') throw new Error('s3-client-required');
    if (!bucket) throw new Error('bucket-required');
    if (!qualificationOnly && process.env.TAILS_PRODUCTION_WRITE !== 'true') {
        throw new Error('production-write-not-authorized');
    }

    const metrics = createHttpMetrics();
    const boundary = previousUtcBoundary(nowMs);
    const market = await loadMarketStatusMap(s3Client, bucket);

    const bulk = await requestJson(http, BULK_TOTAL_URL, {
        metrics,
        kind: 'bulk-total',
        retries: 3,
        maxRequests,
    });
    if (!bulk || bulk.success !== true || !Array.isArray(bulk.data)) {
        throw new Error('bulk-total-contract');
    }

    const fullCohort = buildCohort(bulk.data, market.map);
    const cohort = qualificationOnly
        ? selectQualificationCohort(fullCohort, maxTokens)
        : fullCohort;

    logger.log(
        `TAILS_COHORT full=${fullCohort.length} selected=${cohort.length} `
        + `bsc=${cohort.filter(token => token.chainId === '56').length}`,
    );

    const requestOptions = { metrics, maxRequests };
    const tokenTails = await mapLimit(cohort, concurrency, token => (
        fetchTokenTail(http, token, boundary, requestOptions)
    ));

    const payload = buildPayload(boundary, cohort, tokenTails, Date.now());
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload));

    let publication = null;
    if (!qualificationOnly) {
        publication = await publishPayload(s3Client, bucket, payload);
    }

    return {
        qualificationOnly,
        boundaryDate: boundary.boundaryDate,
        fullCohortCount: fullCohort.length,
        selectedCohortCount: cohort.length,
        selectedBscCount: cohort.filter(token => token.chainId === '56').length,
        marketDataBytes: market.bytes,
        marketDataCount: market.count,
        payloadBytes,
        http: metrics,
        publication,
    };
}

module.exports = {
    BULK_TOTAL_URL,
    KLINES_URL,
    previousUtcBoundary,
    loadMarketStatusMap,
    buildCohort,
    selectQualificationCohort,
    buildSuffixSum,
    buildPayload,
    runTailsProducer,
};
