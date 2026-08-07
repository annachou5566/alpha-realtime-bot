'use strict';

const axios = require('axios');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { createClient } = require('@supabase/supabase-js');

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const CLAIM_WINDOW_MS = 5 * MINUTE_MS;
const CLAIM_SEARCH_MS = 24 * HOUR_MS;
const STATE_KEY = 'competition-analytics/phase1.json';
const ANALYTICS_METHOD = 'hourly-quote-volume-vwap-v2';
const MAX_TOURNAMENTS_PER_RUN = 6;
const MAX_HOURLY_PAGES_PER_TOURNAMENT = 4;
const KLINE_PAGE_SIZE = 1500;
const SYNC_INTERVAL_MS = 15 * MINUTE_MS;

function finitePositive(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeTime(value, fallback) {
    const raw = String(value || fallback || '00:00:00').trim();
    if (/^\d{2}:\d{2}:\d{2}$/.test(raw)) return raw;
    if (/^\d{2}:\d{2}$/.test(raw)) return `${raw}:00`;
    return fallback || '00:00:00';
}

function parseRewardAt(config) {
    const date = String(config && config.end || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
    return Date.parse(`${date}T${normalizeTime(config.endTime, '13:00:00')}Z`);
}

function cleanSymbol(config, fallbackName) {
    return String(config && (config.symbol || config.name) || fallbackName || '')
        .split('(')[0]
        .trim()
        .toUpperCase();
}

function rewardMeta(config, fallbackName) {
    const explicit = String(config && (config.rewardUnit ?? config.reward_unit) || '').trim().toUpperCase();
    const unit = explicit || cleanSymbol(config, fallbackName);
    const quantity = finitePositive(config && (config.rewardQty ?? config.reward_qty));
    return { unit, quantity };
}

function normalizeKlines(payload) {
    const source = Array.isArray(payload)
        ? payload
        : (payload && payload.data && Array.isArray(payload.data) ? payload.data : []);
    return source.map(row => {
        if (!Array.isArray(row)) return null;
        const rawTimestamp = Number(row[0]);
        const timestamp = rawTimestamp < 100_000_000_000 ? rawTimestamp * 1000 : rawTimestamp;
        const open = Number(row[1]);
        const high = Number(row[2]);
        const low = Number(row[3]);
        const close = Number(row[4]);
        const volume = Number(row[5]);
        const quoteVolume = Number(row[7]);
        if (!Number.isFinite(timestamp) || !(open > 0) || !(high > 0) || !(low > 0) || !(close > 0) || !(volume >= 0)) return null;
        return {
            timestamp,
            open,
            high,
            low,
            close,
            volume,
            quoteVolume: Number.isFinite(quoteVolume) && quoteVolume >= 0 ? quoteVolume : null,
        };
    }).filter(Boolean).sort((a, b) => a.timestamp - b.timestamp);
}

function computeVwap(rows) {
    let numerator = 0;
    let denominator = 0;
    for (const row of rows || []) {
        const volume = Number(row && row.volume);
        if (!(volume > 0)) continue;
        const quoteVolume = Number(row && row.quoteVolume);
        if (quoteVolume > 0) {
            numerator += quoteVolume;
            denominator += volume;
            continue;
        }
        const typical = (Number(row.high) + Number(row.low) + Number(row.close)) / 3;
        if (!(typical > 0)) continue;
        numerator += typical * volume;
        denominator += volume;
    }
    return denominator > 0 ? numerator / denominator : null;
}

function hourlyVwapPoints(rows, rewardAt, completedThrough) {
    return (rows || []).map(row => {
        const timestamp = Number(row.timestamp);
        if (!Number.isFinite(timestamp) || timestamp < rewardAt || timestamp + HOUR_MS > completedThrough) return null;
        const volume = finitePositive(row.volume);
        const quoteVolume = finitePositive(row.quoteVolume);
        if (!volume || !quoteVolume) return null;
        return {
            hourAt: timestamp,
            vwap: quoteVolume / volume,
            candleCount: 1,
            method: ANALYTICS_METHOD,
        };
    }).filter(Boolean).sort((a, b) => a.hourAt - b.hourAt);
}

function aggregateHourlyVwap(rows, anchorAt = 0) {
    const groups = new Map();
    for (const row of rows || []) {
        if (row.timestamp < anchorAt) continue;
        const hourAt = anchorAt + Math.floor((row.timestamp - anchorAt) / HOUR_MS) * HOUR_MS;
        const group = groups.get(hourAt) || [];
        group.push(row);
        groups.set(hourAt, group);
    }
    return [...groups.entries()].map(([hourAt, candles]) => ({
        hourAt,
        vwap: computeVwap(candles),
        candleCount: candles.length,
    })).filter(point => finitePositive(point.vwap)).sort((a, b) => a.hourAt - b.hourAt);
}

function updateExtremes(record, points) {
    for (const point of points || []) {
        if (!record.peakVwap || point.vwap > record.peakVwap) {
            record.peakVwap = point.vwap;
            record.peakVwapAt = point.hourAt;
        }
        if (!record.lowVwap || point.vwap < record.lowVwap) {
            record.lowVwap = point.vwap;
            record.lowVwapAt = point.hourAt;
        }
    }
}

function percentChange(current, start) {
    const a = finitePositive(current);
    const b = finitePositive(start);
    return a && b ? ((a - b) / b) * 100 : null;
}

function createClients(env = process.env) {
    const required = [
        'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'R2_ENDPOINT_URL',
        'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME',
    ];
    const missing = required.filter(name => !env[name]);
    if (missing.length) throw new Error(`Competition analytics missing env: ${missing.join(', ')}`);
    return {
        supabase: createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY),
        r2: new S3Client({
            region: 'auto',
            endpoint: env.R2_ENDPOINT_URL,
            credentials: {
                accessKeyId: env.R2_ACCESS_KEY_ID,
                secretAccessKey: env.R2_SECRET_ACCESS_KEY,
            },
        }),
        bucket: env.R2_BUCKET_NAME,
    };
}

function isMissingObjectError(error) {
    const status = Number(error && error.$metadata && error.$metadata.httpStatusCode);
    return status === 404 || error?.name === 'NoSuchKey' || error?.Code === 'NoSuchKey';
}

async function readState(r2, bucket) {
    try {
        const response = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: STATE_KEY }));
        const parsed = JSON.parse(await response.Body.transformToString());
        if (!parsed || Number(parsed.version) !== 1 || !parsed.tournaments || typeof parsed.tournaments !== 'object') {
            throw new Error('Competition analytics state schema is invalid');
        }
        return parsed;
    } catch (error) {
        if (isMissingObjectError(error)) return { version: 1, updatedAt: null, totalEligible: 0, tournaments: {} };
        throw error;
    }
}

async function writeState(r2, bucket, state) {
    const next = { ...state, updatedAt: Date.now() };
    const body = JSON.stringify(next);
    await r2.send(new PutObjectCommand({
        Bucket: bucket,
        Key: STATE_KEY,
        Body: body,
        ContentType: 'application/json',
        CacheControl: 'public, max-age=120, s-maxage=120, stale-while-revalidate=600',
    }));
    Object.assign(state, next);
    return Buffer.byteLength(body);
}

async function fetchAlphaKlines(alphaId, interval, options = {}) {
    if (!alphaId) return [];
    const params = {
        symbol: `${alphaId}USDT`,
        interval,
        limit: Math.min(KLINE_PAGE_SIZE, Math.max(1, Number(options.limit) || KLINE_PAGE_SIZE)),
    };
    if (Number.isFinite(options.startTime)) params.startTime = Math.floor(options.startTime);
    if (Number.isFinite(options.endTime)) params.endTime = Math.floor(options.endTime);
    const response = await axios.get('https://www.binance.com/bapi/defi/v1/public/alpha-trade/klines', {
        params,
        timeout: 15_000,
        headers: { 'User-Agent': 'Mozilla/5.0', 'client-type': 'web' },
    });
    if (!response.data || response.data.code !== '000000') return [];
    return normalizeKlines(response.data);
}

async function fetchClaimVwap(alphaId, rewardAt) {
    const discovery = await fetchAlphaKlines(alphaId, '1m', {
        startTime: rewardAt,
        endTime: rewardAt + CLAIM_SEARCH_MS - 1,
        limit: KLINE_PAGE_SIZE,
    });
    const firstTrade = discovery.find(row => row.volume > 0);
    if (!firstTrade) return null;
    const rows = await fetchAlphaKlines(alphaId, '1m', {
        startTime: firstTrade.timestamp,
        endTime: firstTrade.timestamp + CLAIM_WINDOW_MS - 1,
        limit: 10,
    });
    const selected = rows.filter(row => row.timestamp >= firstTrade.timestamp && row.timestamp < firstTrade.timestamp + CLAIM_WINDOW_MS);
    const vwap = computeVwap(selected);
    return vwap && selected.length === 5
        ? { vwap, observedAt: firstTrade.timestamp, candleCount: selected.length }
        : null;
}

async function fetchCurrentPrice(alphaId) {
    const rows = await fetchAlphaKlines(alphaId, '1m', { limit: 2 });
    const latest = rows.at(-1);
    return latest ? { price: latest.close, observedAt: latest.timestamp } : null;
}

async function fetchFuturesFirstKline(symbol) {
    if (!symbol) return { status: 'not-listed', listedAt: null };
    try {
        const response = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
            params: { symbol: `${symbol}USDT`, interval: '1d', startTime: 0, limit: 1 },
            timeout: 12_000,
            headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        const row = Array.isArray(response.data) ? response.data[0] : null;
        const timestamp = row ? Number(row[0]) : NaN;
        return Number.isFinite(timestamp)
            ? { status: 'listed', listedAt: timestamp }
            : { status: 'not-listed', listedAt: null };
    } catch (error) {
        const status = Number(error && error.response && error.response.status);
        const code = Number(error && error.response && error.response.data && error.response.data.code);
        if (status === 400 && code === -1121) return { status: 'not-listed', listedAt: null };
        throw error;
    }
}

function recordFromTournament(row, previous = {}) {
    const config = row.data || {};
    const symbol = cleanSymbol(config, row.name);
    const reward = rewardMeta(config, row.name);
    return {
        ...previous,
        id: String(row.id),
        name: String(row.name || config.name || symbol || `#${row.id}`),
        symbol,
        alphaId: config.alphaId || previous.alphaId || null,
        rewardAt: parseRewardAt(config),
        rewardUnit: reward.unit,
        rewardQty: reward.quantity,
        source: 'binance-alpha-klines',
    };
}

async function loadEndedTournaments(supabase) {
    const { data, error } = await supabase.from('tournaments').select('id,name,data').neq('id', -1).order('id', { ascending: false });
    if (error) throw error;
    const now = Date.now();
    return (data || []).filter(row => {
        const config = row.data || {};
        const rewardAt = parseRewardAt(config);
        const reward = rewardMeta(config, row.name);
        return Number.isFinite(rewardAt)
            && rewardAt < now - CLAIM_WINDOW_MS
            && config.alphaId
            && reward.unit
            && reward.unit !== 'USD'
            && reward.quantity;
    });
}

function chooseWorkRows(rows, state) {
    return rows.map(row => ({ row, existing: state.tournaments[String(row.id)] || {} }))
        .sort((a, b) => {
            const aNeedsMigration = a.existing.analyticsMethod !== ANALYTICS_METHOD ? 0 : 1;
            const bNeedsMigration = b.existing.analyticsMethod !== ANALYTICS_METHOD ? 0 : 1;
            const aReady = a.existing.status === 'ready' ? 1 : 0;
            const bReady = b.existing.status === 'ready' ? 1 : 0;
            const aAttempt = Number(a.existing.lastAttemptAt || 0);
            const bAttempt = Number(b.existing.lastAttemptAt || 0);
            return aNeedsMigration - bNeedsMigration
                || aReady - bReady
                || aAttempt - bAttempt
                || Number(b.row.id) - Number(a.row.id);
        })
        .slice(0, MAX_TOURNAMENTS_PER_RUN);
}

function resetHourlyState(record) {
    if (record.analyticsMethod === ANALYTICS_METHOD) return;
    delete record.peakVwap;
    delete record.peakVwapAt;
    delete record.lowVwap;
    delete record.lowVwapAt;
    delete record.nextHourlyStartAt;
    delete record.completeThroughAt;
    record.analyticsMethod = ANALYTICS_METHOD;
}

async function syncTournament(record, now = Date.now()) {
    record.lastAttemptAt = Date.now();
    resetHourlyState(record);

    if (!record.claimVwap || Number(record.claimCandleCount) !== 5) {
        const claim = await fetchClaimVwap(record.alphaId, record.rewardAt);
        if (claim) {
            record.claimVwap = claim.vwap;
            record.claimObservedAt = claim.observedAt;
            record.claimCandleCount = claim.candleCount;
        }
    }

    if (!record.futuresLookupStatus) {
        const futures = await fetchFuturesFirstKline(record.symbol);
        record.futuresLookupStatus = futures.status;
        record.futuresFirstKlineAt = futures.listedAt;
    }
    record.futuresListedNow = record.futuresLookupStatus === 'listed';
    record.futuresListedAtReward = Boolean(record.futuresFirstKlineAt && record.futuresFirstKlineAt <= record.rewardAt);

    const completedThrough = record.rewardAt + Math.floor((now - record.rewardAt) / HOUR_MS) * HOUR_MS;
    let cursor = Math.max(Number(record.nextHourlyStartAt || record.rewardAt), record.rewardAt);
    for (let page = 0; page < MAX_HOURLY_PAGES_PER_TOURNAMENT && cursor < completedThrough; page += 1) {
        const rows = await fetchAlphaKlines(record.alphaId, '1h', {
            startTime: cursor,
            endTime: completedThrough - 1,
            limit: KLINE_PAGE_SIZE,
        });
        if (!rows.length) break;
        const points = hourlyVwapPoints(rows, record.rewardAt, completedThrough);
        updateExtremes(record, points);
        const lastAt = Number(rows.at(-1).timestamp);
        if (!(lastAt >= cursor)) break;
        cursor = lastAt + HOUR_MS;
        record.nextHourlyStartAt = cursor;
        record.completeThroughAt = Math.min(cursor, completedThrough);
        if (rows.length < KLINE_PAGE_SIZE) break;
    }

    const current = await fetchCurrentPrice(record.alphaId);
    if (current) {
        record.currentPrice = current.price;
        record.currentObservedAt = current.observedAt;
    }

    record.holdReturnPct = percentChange(record.currentPrice, record.claimVwap);
    record.peakReturnPct = percentChange(record.peakVwap, record.claimVwap);
    record.lowReturnPct = percentChange(record.lowVwap, record.claimVwap);
    record.rewardValueAtClaim = record.rewardQty && record.claimVwap ? record.rewardQty * record.claimVwap : null;
    record.rewardValueNow = record.rewardQty && record.currentPrice ? record.rewardQty * record.currentPrice : null;
    record.updatedAt = Date.now();

    const historyComplete = Number(record.completeThroughAt || 0) >= completedThrough;
    const ready = Number(record.claimCandleCount) === 5
        && finitePositive(record.claimVwap)
        && finitePositive(record.currentPrice)
        && finitePositive(record.peakVwap)
        && finitePositive(record.lowVwap)
        && Boolean(record.futuresLookupStatus)
        && historyComplete;
    record.status = ready ? 'ready' : 'backfilling';
    delete record.lastError;
    delete record.lastRefreshError;
    return record;
}

async function runCompetitionAnalyticsPhase1(options = {}) {
    const clients = options.clients || createClients(options.env);
    const state = await readState(clients.r2, clients.bucket);
    const rows = await loadEndedTournaments(clients.supabase);
    state.totalEligible = rows.length;
    state.analyticsMethod = ANALYTICS_METHOD;
    const work = chooseWorkRows(rows, state);
    const results = [];
    let bytes = 0;

    for (const item of work) {
        const previous = item.existing;
        const record = recordFromTournament(item.row, previous);
        try {
            state.tournaments[record.id] = await syncTournament(record, options.now || Date.now());
            results.push({ id: record.id, status: state.tournaments[record.id].status });
        } catch (error) {
            const message = String(error && error.message || error).slice(0, 240);
            record.lastAttemptAt = Date.now();
            record.updatedAt = Date.now();
            if (previous.status === 'ready') {
                record.status = 'ready';
                record.lastRefreshError = message;
            } else {
                record.status = 'error';
                record.lastError = message;
            }
            state.tournaments[record.id] = record;
            results.push({ id: record.id, status: 'error' });
        }
        bytes = await writeState(clients.r2, clients.bucket, state);
    }

    return {
        processed: work.length,
        totalEligible: rows.length,
        stored: Object.keys(state.tournaments).length,
        ready: Object.values(state.tournaments).filter(row => row && row.status === 'ready').length,
        bytes,
        results,
    };
}

function startCompetitionAnalyticsPhase1(options = {}) {
    const logger = options.logger || console;
    let running = false;
    const run = async () => {
        if (running) return { skipped: 'already-running' };
        running = true;
        try {
            const result = await runCompetitionAnalyticsPhase1(options);
            logger.log('[COMP-ANALYTICS]', result);
            return result;
        } catch (error) {
            logger.warn('[COMP-ANALYTICS]', error.message);
            throw error;
        } finally {
            running = false;
        }
    };
    const startupTimer = setTimeout(() => run().catch(() => {}), Number(options.startDelayMs) || 45_000);
    const interval = setInterval(() => run().catch(() => {}), Number(options.intervalMs) || SYNC_INTERVAL_MS);
    if (startupTimer.unref) startupTimer.unref();
    if (interval.unref) interval.unref();
    return { run, startupTimer, interval };
}

module.exports = {
    MINUTE_MS,
    HOUR_MS,
    CLAIM_WINDOW_MS,
    STATE_KEY,
    ANALYTICS_METHOD,
    MAX_TOURNAMENTS_PER_RUN,
    normalizeKlines,
    computeVwap,
    hourlyVwapPoints,
    aggregateHourlyVwap,
    updateExtremes,
    percentChange,
    parseRewardAt,
    rewardMeta,
    recordFromTournament,
    chooseWorkRows,
    readState,
    runCompetitionAnalyticsPhase1,
    startCompetitionAnalyticsPhase1,
};
