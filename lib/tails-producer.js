'use strict';

const crypto = require('node:crypto');
const { PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
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

function tokenIdentity(token) {
    const id = token && token.alphaId != null ? String(token.alphaId) : '';
    if (!id) return null;
    const contract = token.contractAddress;
    const chainId = token.chainId;
    if (!contract || chainId === null || chainId === undefined || chainId === '') {
        throw new Error(`active-token-missing-identity:${id}`);
    }
    return {
        alphaId: id,
        symbol: String(token.symbol || id),
        contractAddress: String(contract),
        chainId: String(chainId),
        volume24h: Number(token.volume24h || 0),
        offline: token.offline === true,
        listingCex: token.listingCex === true,
        stockState: token.stockState === true || token.stockState === 1,
    };
}

function buildCohort(rawTokens) {
    if (!Array.isArray(rawTokens) || rawTokens.length === 0) {
        throw new Error('bulk-token-list-empty');
    }

    const online = [];
    const offlineProbe = [];
    const seen = new Set();
    let excludedSpot = 0;

    for (const raw of rawTokens) {
        const token = tokenIdentity(raw);
        if (!token) continue;

        if (seen.has(token.alphaId)) {
            throw new Error(`bulk-token-duplicate-id:${token.alphaId}`);
        }
        seen.add(token.alphaId);

        // Current Binance live state is authoritative. Online rows are ALPHA.
        if (!token.offline) {
            online.push({ ...token, statusSource: 'binance-live-online' });
            continue;
        }

        // Mirrors fetch_alpha.py: offline + listingCex is SPOT and not in tails.
        if (token.listingCex) {
            excludedSpot += 1;
            continue;
        }

        // Mirrors fetch_alpha.py PRE_DELISTED path. Do not trust stale cached
        // ALPHA/PRE_DELISTED status: re-qualify with the current limit source.
        offlineProbe.push(token);
    }

    Object.defineProperty(online, 'diagnostics', {
        value: { offlineProbe, excludedSpot },
        enumerable: false,
    });
    return online;
}

function cleanContract(token) {
    if (['CT_501', 'CT_784'].includes(token.chainId)) return token.contractAddress;
    return token.contractAddress.toLowerCase();
}

function parseKlinePayload(payload, tokenId, dataType) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error(`kline-payload-type:${tokenId}:${dataType}`);
    }

    const code = String(payload.code ?? '');
    if (code === '-5101') {
        return {
            capability: 'unsupported',
            code,
            rows: [],
        };
    }

    if (code && code !== '000000') {
        throw new Error(`kline-business-code:${tokenId}:${dataType}:${code}`);
    }

    const rows = payload && payload.data && payload.data.klineInfos;
    if (!Array.isArray(rows)) {
        throw new Error(`kline-rows-contract:${tokenId}:${dataType}`);
    }

    return {
        capability: 'supported',
        code: code || 'implicit-success',
        rows,
    };
}

async function fetchRecentLimitLiveness(http, token, options) {
    const params = new URLSearchParams({
        chainId: token.chainId,
        interval: '1d',
        limit: '30',
        tokenAddress: cleanContract(token),
        dataType: 'limit',
    });

    const payload = await requestJson(http, `${KLINES_URL}?${params.toString()}`, {
        ...options,
        kind: 'offline-liveness-limit',
        retries: 2,
    });
    const parsed = parseKlinePayload(payload, token.alphaId, 'limit-liveness');

    if (parsed.capability === 'unsupported') {
        return { alive: false, reason: 'limit-unsupported' };
    }

    const rows = parsed.rows;
    const latest = rows.length ? Number(rows[rows.length - 1]?.[5] || 0) : 0;
    const previous = rows.length > 1 ? Number(rows[rows.length - 2]?.[5] || 0) : 0;
    const alive = (
        (Number.isFinite(latest) && latest > 0)
        || (Number.isFinite(previous) && previous > 0)
    );
    return {
        alive,
        reason: alive ? 'positive-limit-volume' : 'no-recent-limit-volume',
    };
}

async function mapLimit(items, concurrency, worker) {
    if (!Array.isArray(items) || items.length === 0) return [];
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

async function resolveLiveCohort(http, rawTokens, options = {}) {
    const {
        metrics = createHttpMetrics(),
        maxRequests = 4_000,
        concurrency = 2,
    } = options;

    const online = buildCohort(rawTokens);
    const pending = online.diagnostics?.offlineProbe || [];
    const probeResults = await mapLimit(
        pending,
        Math.min(Math.max(1, concurrency), 2),
        async token => ({
            token,
            ...(await fetchRecentLimitLiveness(http, token, { metrics, maxRequests })),
        }),
    );

    const revived = [];
    let excludedOffline = 0;
    let unsupportedOffline = 0;
    for (const result of probeResults) {
        if (result.alive) {
            revived.push({
                ...result.token,
                statusSource: 'binance-live-offline-requalified',
            });
        } else {
            excludedOffline += 1;
            if (result.reason === 'limit-unsupported') unsupportedOffline += 1;
        }
    }

    const cohort = [...online, ...revived];
    if (cohort.length === 0) throw new Error('active-tail-cohort-empty');

    Object.defineProperty(cohort, 'diagnostics', {
        value: {
            online: online.length,
            offlineProbed: pending.length,
            offlineRevived: revived.length,
            offlineExcluded: excludedOffline,
            offlineUnsupported: unsupportedOffline,
            excludedSpot: Number(online.diagnostics?.excludedSpot || 0),
        },
        enumerable: false,
    });
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
    return parseKlinePayload(payload, token.alphaId, dataType);
}

async function fetchFullDayKlines(http, token, dataType, boundary, options) {
    const rowsByTs = new Map();
    let cursorEnd = boundary.endMs;
    let capability = null;

    for (let guard = 0; guard < 10 && cursorEnd > boundary.startMs; guard += 1) {
        const page = await fetchKlinePage(http, token, dataType, cursorEnd, options);
        if (capability && page.capability !== capability) {
            throw new Error(`kline-capability-drift:${token.alphaId}:${dataType}`);
        }
        capability = page.capability;

        if (page.capability === 'unsupported') {
            return { capability: 'unsupported', rows: [] };
        }

        const rows = page.rows;
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

    return {
        capability: capability || 'supported',
        rows: [...rowsByTs.values()],
    };
}

function buildSuffixSum(rows, boundaryDate, options = {}) {
    if (!Array.isArray(rows)) return null;

    const allowExplicitEmpty = options.allowExplicitEmpty === true;
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
            // Malformed rows are ignored; caller still requires a source-success
            // envelope and an exact 1440-point output.
        }
    }

    if (matched === 0 && !allowExplicitEmpty) return null;

    const suffix = Array(1440).fill(0);
    let running = 0;
    for (let i = 1439; i >= 0; i -= 1) {
        running += minuteMap[i];
        suffix[i] = Math.round(running * 100) / 100;
    }
    return suffix;
}

async function fetchTokenTail(http, token, boundary, options) {
    const totalResult = await fetchFullDayKlines(http, token, 'aggregate', boundary, options);
    if (totalResult.capability !== 'supported') {
        throw new Error(`aggregate-tail-unsupported:${token.alphaId}`);
    }
    const total = buildSuffixSum(totalResult.rows, boundary.boundaryDate, {
        allowExplicitEmpty: true,
    });
    if (!total) throw new Error(`total-tail-unavailable:${token.alphaId}`);

    const limitApplicable = token.chainId === '56';
    let limit = null;
    let limitSupported = false;

    if (limitApplicable) {
        const limitResult = await fetchFullDayKlines(http, token, 'limit', boundary, options);
        if (limitResult.capability === 'supported') {
            limit = buildSuffixSum(limitResult.rows, boundary.boundaryDate, {
                allowExplicitEmpty: true,
            });
            if (!limit) throw new Error(`limit-tail-unavailable:${token.alphaId}`);
            limitSupported = true;
        }
    }

    return {
        id: token.alphaId,
        total,
        limit,
        limitApplicable,
        limitSupported,
    };
}

function buildPayload(boundary, cohort, tokenTails, generatedAtMs = Date.now()) {
    const expectedIds = new Set(cohort.map(token => String(token.alphaId)));
    const limitApplicableIds = new Set(
        cohort.filter(token => token.chainId === '56').map(token => String(token.alphaId)),
    );

    const total = Object.create(null);
    const limit = Object.create(null);
    const unsupportedLimitIds = new Set();

    for (const item of tokenTails) {
        if (!item || !item.id || !Array.isArray(item.total) || item.total.length !== 1440) {
            throw new Error('tail-result-shape');
        }
        const id = String(item.id);
        total[id] = item.total;

        if (item.limitApplicable) {
            if (item.limitSupported) {
                if (!Array.isArray(item.limit) || item.limit.length !== 1440) {
                    throw new Error(`limit-result-shape:${id}`);
                }
                limit[id] = item.limit;
            } else {
                unsupportedLimitIds.add(id);
            }
        }
    }

    const actualTotalIds = new Set(Object.keys(total));
    const supportedLimitIds = new Set(Object.keys(limit));
    const classifiedLimitIds = new Set([
        ...supportedLimitIds,
        ...unsupportedLimitIds,
    ]);

    if (actualTotalIds.size !== expectedIds.size) throw new Error('total-cohort-size');
    if (classifiedLimitIds.size !== limitApplicableIds.size) {
        throw new Error('limit-capability-coverage');
    }
    if (
        [...classifiedLimitIds].some(id => !limitApplicableIds.has(id))
        || [...supportedLimitIds].some(id => unsupportedLimitIds.has(id))
    ) {
        throw new Error('limit-capability-partition');
    }

    const expectedHash = stableIdsHash(expectedIds);
    const totalHash = stableIdsHash(actualTotalIds);
    const applicableLimitHash = stableIdsHash(limitApplicableIds);
    const classifiedLimitHash = stableIdsHash(classifiedLimitIds);
    const supportedLimitHash = stableIdsHash(supportedLimitIds);
    const unsupportedLimitHash = stableIdsHash(unsupportedLimitIds);

    if (
        expectedHash !== totalHash
        || applicableLimitHash !== classifiedLimitHash
    ) {
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
        expected_ids_hash: expectedHash,
        covered_total_ids_hash: totalHash,

        limit_applicable_token_count: limitApplicableIds.size,
        limit_applicable_ids_hash: applicableLimitHash,
        classified_limit_token_count: classifiedLimitIds.size,
        classified_limit_ids_hash: classifiedLimitHash,

        expected_limit_token_count: supportedLimitIds.size,
        covered_limit_count: supportedLimitIds.size,
        expected_limit_ids_hash: supportedLimitHash,
        covered_limit_ids_hash: supportedLimitHash,

        unsupported_limit_token_count: unsupportedLimitIds.size,
        unsupported_limit_ids: [...unsupportedLimitIds].sort(),
        unsupported_limit_ids_hash: unsupportedLimitHash,

        total,
        limit,
    };
}

async function publishPayload(s3Client, bucket, payload) {
    if (!s3Client || typeof s3Client.send !== 'function') {
        throw new Error('s3-client-required-for-write');
    }
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
        s3Client = null,
        bucket = null,
        nowMs = Date.now(),
        qualificationOnly = true,
        maxTokens = 0,
        concurrency = 2,
        maxRequests = 4_000,
        logger = console,
    } = options || {};

    if (!http || typeof http.get !== 'function') throw new Error('http-client-required');
    if (!qualificationOnly && process.env.TAILS_PRODUCTION_WRITE !== 'true') {
        throw new Error('production-write-not-authorized');
    }
    if (!qualificationOnly && (!bucket || !s3Client)) {
        throw new Error('production-write-storage-required');
    }

    const metrics = createHttpMetrics();
    const boundary = previousUtcBoundary(nowMs);

    const bulk = await requestJson(http, BULK_TOTAL_URL, {
        metrics,
        kind: 'bulk-total',
        retries: 3,
        maxRequests,
    });
    if (!bulk || bulk.success !== true || !Array.isArray(bulk.data)) {
        throw new Error('bulk-total-contract');
    }

    const fullCohort = await resolveLiveCohort(http, bulk.data, {
        metrics,
        maxRequests,
        concurrency,
    });
    const cohort = qualificationOnly
        ? selectQualificationCohort(fullCohort, maxTokens)
        : fullCohort;

    logger.log(
        `TAILS_COHORT full=${fullCohort.length} selected=${cohort.length} `
        + `bsc=${cohort.filter(token => token.chainId === '56').length} `
        + `online=${Number(fullCohort.diagnostics?.online || 0)} `
        + `offline_probed=${Number(fullCohort.diagnostics?.offlineProbed || 0)} `
        + `offline_revived=${Number(fullCohort.diagnostics?.offlineRevived || 0)} `
        + `offline_excluded=${Number(fullCohort.diagnostics?.offlineExcluded || 0)}`,
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
        onlineCount: Number(fullCohort.diagnostics?.online || 0),
        offlineProbedCount: Number(fullCohort.diagnostics?.offlineProbed || 0),
        offlineRevivedCount: Number(fullCohort.diagnostics?.offlineRevived || 0),
        offlineExcludedCount: Number(fullCohort.diagnostics?.offlineExcluded || 0),
        selectedCohortCount: cohort.length,
        selectedBscCount: cohort.filter(token => token.chainId === '56').length,
        supportedLimitCount: Number(payload.expected_limit_token_count),
        unsupportedLimitCount: Number(payload.unsupported_limit_token_count),
        payloadBytes,
        http: metrics,
        publication,
    };
}

module.exports = {
    BULK_TOTAL_URL,
    KLINES_URL,
    previousUtcBoundary,
    buildCohort,
    resolveLiveCohort,
    selectQualificationCohort,
    parseKlinePayload,
    buildSuffixSum,
    buildPayload,
    runTailsProducer,
};
