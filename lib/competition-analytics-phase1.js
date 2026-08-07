'use strict';

const axios = require('axios');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { createClient } = require('@supabase/supabase-js');

const FIVE_MIN_MS = 5 * 60_000;
const HOUR_MS = 60 * 60_000;
const CLAIM_WINDOW_MS = 5 * 60_000;
const STATE_KEY = 'competition-analytics/phase1.json';
const MAX_TOURNAMENTS_PER_RUN = 2;
const MAX_KLINE_PAGES_PER_TOURNAMENT = 2;
const KLINE_PAGE_SIZE = 1500;
const SYNC_INTERVAL_MS = 6 * 60 * 60_000;

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

function rewardMeta(config) {
    const unit = String(config && (config.rewardUnit ?? config.reward_unit) || '').trim().toUpperCase();
    const quantity = finitePositive(config && (config.rewardQty ?? config.reward_qty));
    return { unit, quantity };
}

function normalizeKlines(payload) {
    const source = Array.isArray(payload)
        ? payload
        : (payload && payload.data && Array.isArray(payload.data) ? payload.data : []);
    return source.map(row => {
        if (!Array.isArray(row)) return null;
        const timestampRaw = Number(row[0]);
        const timestamp = timestampRaw < 100_000_000_000 ? timestampRaw * 1000 : timestampRaw;
        const high = Number(row[2]);
        const low = Number(row[3]);
        const close = Number(row[4]);
        const volume = Number(row[5]);
        if (!Number.isFinite(timestamp) || !(high > 0) || !(low > 0) || !(close > 0) || !(volume >= 0)) return null;
        return { timestamp, high, low, close, volume };
    }).filter(Boolean).sort((a, b) => a.timestamp - b.timestamp);
}

function computeVwap(rows) {
    let numerator = 0;
    let denominator = 0;
    for (const row of rows) {
        const volume = Number(row && row.volume);
        if (!(volume > 0)) continue;
        const typical = (Number(row.high) + Number(row.low) + Number(row.close)) / 3;
        if (!(typical > 0)) continue;
        numerator += typical * volume;
        denominator += volume;
    }
    return denominator > 0 ? numerator / denominator : null;
}

function aggregateHourlyVwap(rows) {
    const groups = new Map();
    for (const row of rows) {
        const hourAt = Math.floor(row.timestamp / HOUR_MS) * HOUR_MS;
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

function updateExtremes(record, hourlyPoints) {
    for (const point of hourlyPoints) {
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

async function readState(r2, bucket) {
    try {
        const response = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: STATE_KEY }));
        const parsed = JSON.parse(await response.Body.transformToString());
        if (parsed && Number(parsed.version) === 1 && parsed.tournaments) return parsed;
    } catch (_) { /* first run or invalid old object */ }
    return { version: 1, updatedAt: null, tournaments: {} };
}

async function writeState(r2, bucket, state) {
    state.updatedAt = Date.now();
    const body = JSON.stringify(state);
    await r2.send(new PutObjectCommand({
        Bucket: bucket,
        Key: STATE_KEY,
        Body: body,
        ContentType: 'application/json',
        CacheControl: 'public, max-age=900, s-maxage=900, stale-while-revalidate=3600',
    }));
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
    const response = await axios.get(
        'https://www.binance.com/bapi/defi/v1/public/alpha-trade/klines',
        {
            params,
            timeout: 15_000,
            headers: { 'User-Agent': 'Mozilla/5.0', 'client-type': 'web' },
        },
    );
    if (!response.data || response.data.code !== '000000') return [];
    return normalizeKlines(response.data);
}

async function fetchClaimVwap(alphaId, rewardAt) {
    const rows = await fetchAlphaKlines(alphaId, '1m', {
        startTime: rewardAt,
        endTime: rewardAt + CLAIM_WINDOW_MS - 1,
        limit: 10,
    });
    const firstTrade = rows.find(row => row.volume > 0);
    if (!firstTrade) return null;
    const windowEnd = firstTrade.timestamp + CLAIM_WINDOW_MS - 1;
    const selected = rows.filter(row => row.timestamp >= firstTrade.timestamp && row.timestamp <= windowEnd);
    const vwap = computeVwap(selected);
    return vwap ? { vwap, observedAt: firstTrade.timestamp, candleCount: selected.length } : null;
}

async function fetchCurrentPrice(alphaId) {
    const rows = await fetchAlphaKlines(alphaId, '1m', { limit: 2 });
    const latest = rows.at(-1);
    return latest ? { price: latest.close, observedAt: latest.timestamp } : null;
}

async function fetchFuturesFirstKline(symbol) {
    if (!symbol) return null;
    try {
        const response = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
            params: { symbol: `${symbol}USDT`, interval: '1d', startTime: 0, limit: 1 },
            timeout: 12_000,
            headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        const row = Array.isArray(response.data) ? response.data[0] : null;
        const timestamp = row ? Number(row[0]) : NaN;
        return Number.isFinite(timestamp) ? timestamp : null;
    } catch (_) {
        return null;
    }
}

function recordFromTournament(row, previous = {}) {
    const config = row.data || {};
    const rewardAt = parseRewardAt(config);
    const reward = rewardMeta(config);
    const symbol = cleanSymbol(config, row.name);
    return {
        ...previous,
        id: String(row.id),
        name: String(row.name || config.name || symbol || `#${row.id}`),
        symbol,
        alphaId: config.alphaId || previous.alphaId || null,
        rewardAt,
        rewardUnit: reward.unit,
        rewardQty: reward.quantity,
        source: 'binance-alpha-klines',
    };
}

async function loadEndedTournaments(supabase) {
    const { data, error } = await supabase
        .from('tournaments')
        .select('id,name,data')
        .neq('id', -1)
        .order('id', { ascending: false });
    if (error) throw error;
    const now = Date.now();
    return (data || []).filter(row => {
        const config = row.data || {};
        const rewardAt = parseRewardAt(config);
        const reward = rewardMeta(config);
        return Number.isFinite(rewardAt)
            && rewardAt < now - CLAIM_WINDOW_MS
            && config.alphaId
            && reward.unit !== 'USD'
            && reward.quantity;
    });
}

function chooseWorkRows(rows, state) {
    return rows
        .map(row => ({ row, existing: state.tournaments[String(row.id)] || {} }))
        .sort((a, b) => {
            const aDone = Number(a.existing.completeThroughAt || 0);
            const bDone = Number(b.existing.completeThroughAt || 0);
            return aDone - bDone || Number(b.row.id) - Number(a.row.id);
        })
        .slice(0, MAX_TOURNAMENTS_PER_RUN);
}

async function syncTournament(record, now = Date.now()) {
    if (!record.claimVwap) {
        const claim = await fetchClaimVwap(record.alphaId, record.rewardAt);
        if (claim) {
            record.claimVwap = claim.vwap;
            record.claimObservedAt = claim.observedAt;
            record.claimCandleCount = claim.candleCount;
        }
    }

    if (!Object.prototype.hasOwnProperty.call(record, 'futuresFirstKlineAt')) {
        record.futuresFirstKlineAt = await fetchFuturesFirstKline(record.symbol);
    }
    record.futuresListedNow = Boolean(record.futuresFirstKlineAt);
    record.futuresListedAtReward = Boolean(record.futuresFirstKlineAt && record.futuresFirstKlineAt <= record.rewardAt);

    let cursor = Math.max(
        Number(record.next5mStartAt || record.rewardAt),
        record.rewardAt,
    );
    const endTarget = Math.floor(now / FIVE_MIN_MS) * FIVE_MIN_MS;
    for (let page = 0; page < MAX_KLINE_PAGES_PER_TOURNAMENT && cursor < endTarget; page += 1) {
        const rows = await fetchAlphaKlines(record.alphaId, '5m', {
            startTime: cursor,
            endTime: endTarget,
            limit: KLINE_PAGE_SIZE,
        });
        if (!rows.length) break;
        updateExtremes(record, aggregateHourlyVwap(rows));
        const lastAt = rows.at(-1).timestamp;
        if (!(lastAt >= cursor)) break;
        cursor = lastAt + FIVE_MIN_MS;
        record.next5mStartAt = cursor;
        record.completeThroughAt = lastAt;
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
    record.rewardValueAtClaim = record.rewardQty && record.claimVwap
        ? record.rewardQty * record.claimVwap
        : null;
    record.rewardValueNow = record.rewardQty && record.currentPrice
        ? record.rewardQty * record.currentPrice
        : null;
    record.updatedAt = Date.now();
    record.status = record.claimVwap ? 'ready' : 'missing-claim-price';
    return record;
}

async function runCompetitionAnalyticsPhase1(options = {}) {
    const clients = options.clients || createClients(options.env);
    const state = await readState(clients.r2, clients.bucket);
    const rows = await loadEndedTournaments(clients.supabase);
    const work = chooseWorkRows(rows, state);
    const results = [];

    for (const item of work) {
        const record = recordFromTournament(item.row, item.existing);
        try {
            state.tournaments[record.id] = await syncTournament(record, options.now || Date.now());
            results.push({ id: record.id, status: state.tournaments[record.id].status });
        } catch (error) {
            record.status = 'error';
            record.lastError = String(error && error.message || error).slice(0, 240);
            record.updatedAt = Date.now();
            state.tournaments[record.id] = record;
            results.push({ id: record.id, status: 'error' });
        }
    }

    const bytes = work.length ? await writeState(clients.r2, clients.bucket, state) : 0;
    return {
        processed: work.length,
        totalEligible: rows.length,
        stored: Object.keys(state.tournaments).length,
        bytes,
        results,
    };
}

function startCompetitionAnalyticsPhase1(options = {}) {
    const logger = options.logger || console;
    const run = () => runCompetitionAnalyticsPhase1(options)
        .then(result => logger.log('[COMP-ANALYTICS]', result))
        .catch(error => logger.warn('[COMP-ANALYTICS]', error.message));
    const startupTimer = setTimeout(run, Number(options.startDelayMs) || 45_000);
    const interval = setInterval(run, Number(options.intervalMs) || SYNC_INTERVAL_MS);
    if (startupTimer.unref) startupTimer.unref();
    if (interval.unref) interval.unref();
    return { run, startupTimer, interval };
}

module.exports = {
    FIVE_MIN_MS,
    HOUR_MS,
    CLAIM_WINDOW_MS,
    STATE_KEY,
    normalizeKlines,
    computeVwap,
    aggregateHourlyVwap,
    updateExtremes,
    percentChange,
    parseRewardAt,
    recordFromTournament,
    chooseWorkRows,
    runCompetitionAnalyticsPhase1,
    startCompetitionAnalyticsPhase1,
};
