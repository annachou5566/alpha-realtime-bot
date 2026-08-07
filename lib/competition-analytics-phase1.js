'use strict';

const axios = require('axios');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { createClient } = require('@supabase/supabase-js');

const MINUTE_MS = 60_000;
const HALF_HOUR_MS = 30 * MINUTE_MS;
const HOUR_MS = 60 * MINUTE_MS;
const BASELINE_WINDOW_MS = 5 * MINUTE_MS;
const STATE_KEY = 'competition-analytics/phase1.json';
const ANALYTICS_METHOD = 'tournament-start-anchored-hourly-quote-volume-vwap-v4';
const MAX_TOURNAMENTS_PER_RUN = 6;
const MAX_HISTORY_PAGES_PER_TOURNAMENT = 4;
const KLINE_PAGE_SIZE = 1500;
const SYNC_INTERVAL_MS = 15 * MINUTE_MS;

const positive = value => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
};

function normalizeTime(value, fallback = '00:00:00') {
    const raw = String(value || fallback).trim();
    if (/^\d{2}:\d{2}:\d{2}$/.test(raw)) return raw;
    if (/^\d{2}:\d{2}$/.test(raw)) return `${raw}:00`;
    return fallback;
}

function parseBoundaryAt(config, dateKey, timeKey, fallbackTime) {
    const date = String(config?.[dateKey] || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
    return Date.parse(`${date}T${normalizeTime(config?.[timeKey], fallbackTime)}Z`);
}

function parseStartAt(config) {
    return parseBoundaryAt(config, 'start', 'startTime', '13:00:00');
}

function parseEndAt(config) {
    return parseBoundaryAt(config, 'end', 'endTime', '13:00:00');
}

function cleanSymbol(config, fallbackName) {
    return String(config?.symbol || config?.name || fallbackName || '').split('(')[0].trim().toUpperCase();
}

function rewardMeta(config, fallbackName) {
    const explicit = String(config?.rewardUnit ?? config?.reward_unit ?? '').trim().toUpperCase();
    return {
        unit: explicit || cleanSymbol(config, fallbackName),
        quantity: positive(config?.rewardQty ?? config?.reward_qty),
    };
}

function normalizeKlines(payload) {
    const source = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
    return source.map(row => {
        if (!Array.isArray(row)) return null;
        const raw = Number(row[0]);
        const timestamp = raw < 100_000_000_000 ? raw * 1000 : raw;
        const open = Number(row[1]);
        const high = Number(row[2]);
        const low = Number(row[3]);
        const close = Number(row[4]);
        const volume = Number(row[5]);
        const quoteVolume = Number(row[7]);
        if (!Number.isFinite(timestamp) || !(open > 0) || !(high > 0) || !(low > 0) || !(close > 0) || !(volume >= 0)) return null;
        return {
            timestamp, open, high, low, close, volume,
            quoteVolume: Number.isFinite(quoteVolume) && quoteVolume >= 0 ? quoteVolume : null,
        };
    }).filter(Boolean).sort((a, b) => a.timestamp - b.timestamp);
}

function computeVwap(rows) {
    let base = 0;
    let quote = 0;
    for (const row of rows || []) {
        const volume = positive(row?.volume);
        if (!volume) continue;
        const quoteVolume = positive(row?.quoteVolume);
        if (quoteVolume) {
            base += volume;
            quote += quoteVolume;
            continue;
        }
        const typical = (Number(row.high) + Number(row.low) + Number(row.close)) / 3;
        if (typical > 0) {
            base += volume;
            quote += typical * volume;
        }
    }
    return base > 0 ? quote / base : null;
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
    })).filter(point => positive(point.vwap)).sort((a, b) => a.hourAt - b.hourAt);
}

function historyInterval(startAt) {
    return startAt % HOUR_MS === 0
        ? { interval: '1h', stepMs: HOUR_MS, candlesPerWindow: 1 }
        : { interval: '30m', stepMs: HALF_HOUR_MS, candlesPerWindow: 2 };
}

function anchoredHourlyPoints(rows, startAt, completedThrough, candlesPerWindow) {
    return aggregateHourlyVwap(rows, startAt).filter(point =>
        point.candleCount === candlesPerWindow && point.hourAt + HOUR_MS <= completedThrough
    ).map(point => ({ ...point, method: ANALYTICS_METHOD }));
}

function hourlyVwapPoints(rows, startAt, completedThrough) {
    return anchoredHourlyPoints(rows, startAt, completedThrough, 1);
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
    const a = positive(current);
    const b = positive(start);
    return a && b ? ((a - b) / b) * 100 : null;
}

function createClients(env = process.env) {
    const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'R2_ENDPOINT_URL', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'];
    const missing = required.filter(name => !env[name]);
    if (missing.length) throw new Error(`Competition analytics missing env: ${missing.join(', ')}`);
    return {
        supabase: createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY),
        r2: new S3Client({
            region: 'auto', endpoint: env.R2_ENDPOINT_URL,
            credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
        }),
        bucket: env.R2_BUCKET_NAME,
    };
}

function isMissingObjectError(error) {
    const status = Number(error?.$metadata?.httpStatusCode);
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
        Bucket: bucket, Key: STATE_KEY, Body: body, ContentType: 'application/json',
        CacheControl: 'public, max-age=120, s-maxage=120, stale-while-revalidate=600',
    }));
    Object.assign(state, next);
    return Buffer.byteLength(body);
}

async function fetchAlphaKlines(alphaId, interval, options = {}) {
    if (!alphaId) return [];
    const params = {
        symbol: `${alphaId}USDT`, interval,
        limit: Math.min(KLINE_PAGE_SIZE, Math.max(1, Number(options.limit) || KLINE_PAGE_SIZE)),
    };
    if (Number.isFinite(options.startTime)) params.startTime = Math.floor(options.startTime);
    if (Number.isFinite(options.endTime)) params.endTime = Math.floor(options.endTime);
    const response = await axios.get('https://www.binance.com/bapi/defi/v1/public/alpha-trade/klines', {
        params, timeout: 15_000, headers: { 'User-Agent': 'Mozilla/5.0', 'client-type': 'web' },
    });
    if (!response.data || response.data.code !== '000000') return [];
    return normalizeKlines(response.data);
}

async function fetchStartVwap(alphaId, startAt) {
    const rows = await fetchAlphaKlines(alphaId, '1m', {
        startTime: startAt,
        endTime: startAt + BASELINE_WINDOW_MS - 1,
        limit: 10,
    });
    const selected = rows.filter(row => row.timestamp >= startAt && row.timestamp < startAt + BASELINE_WINDOW_MS);
    const vwap = computeVwap(selected);
    return vwap && selected.length === 5 ? { vwap, observedAt: startAt, candleCount: 5 } : null;
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
            timeout: 12_000, headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        const timestamp = Number(Array.isArray(response.data) ? response.data[0]?.[0] : NaN);
        return Number.isFinite(timestamp) ? { status: 'listed', listedAt: timestamp } : { status: 'not-listed', listedAt: null };
    } catch (error) {
        if (Number(error?.response?.status) === 400 && Number(error?.response?.data?.code) === -1121) {
            return { status: 'not-listed', listedAt: null };
        }
        throw error;
    }
}

function recordFromTournament(row, previous = {}) {
    const config = row.data || {};
    const symbol = cleanSymbol(config, row.name);
    const reward = rewardMeta(config, row.name);
    return {
        ...previous,
        id: String(row.id), name: String(row.name || config.name || symbol || `#${row.id}`), symbol,
        alphaId: config.alphaId || previous.alphaId || null,
        startAt: parseStartAt(config), endAt: parseEndAt(config), rewardUnit: reward.unit, rewardQty: reward.quantity,
        source: 'binance-alpha-klines',
    };
}

async function loadEndedTournaments(supabase) {
    const { data, error } = await supabase.from('tournaments').select('id,name,data').neq('id', -1).order('id', { ascending: false });
    if (error) throw error;
    const now = Date.now();
    return (data || []).filter(row => {
        const startAt = parseStartAt(row.data || {});
        const endAt = parseEndAt(row.data || {});
        const reward = rewardMeta(row.data || {}, row.name);
        return Number.isFinite(startAt) && Number.isFinite(endAt) && endAt < now
            && row.data?.alphaId && reward.unit && reward.unit !== 'USD' && reward.quantity;
    });
}

function chooseWorkRows(rows, state) {
    return rows.map(row => ({ row, existing: state.tournaments[String(row.id)] || {} })).sort((a, b) => {
        const migration = Number(a.existing.analyticsMethod === ANALYTICS_METHOD) - Number(b.existing.analyticsMethod === ANALYTICS_METHOD);
        const readiness = Number(a.existing.status === 'ready') - Number(b.existing.status === 'ready');
        return migration || readiness || Number(a.existing.lastAttemptAt || 0) - Number(b.existing.lastAttemptAt || 0) || Number(b.row.id) - Number(a.row.id);
    }).slice(0, MAX_TOURNAMENTS_PER_RUN);
}

function resetHistoryState(record) {
    if (record.analyticsMethod === ANALYTICS_METHOD) return;
    [
        'claimVwap','claimObservedAt','claimCandleCount','rewardAt','rewardValueAtClaim','futuresListedAtReward',
        'peakVwap','peakVwapAt','lowVwap','lowVwapAt','nextHistoryStartAt','completeThroughAt',
        'startVwap','startObservedAt','startCandleCount','rewardValueAtStart','futuresListedAtStart',
    ].forEach(key => delete record[key]);
    record.analyticsMethod = ANALYTICS_METHOD;
}

async function syncTournament(record, now = Date.now()) {
    record.lastAttemptAt = Date.now();
    resetHistoryState(record);

    if (!record.startVwap || Number(record.startCandleCount) !== 5) {
        const start = await fetchStartVwap(record.alphaId, record.startAt);
        if (start) Object.assign(record, { startVwap: start.vwap, startObservedAt: start.observedAt, startCandleCount: start.candleCount });
    }

    if (!record.futuresLookupStatus) {
        const futures = await fetchFuturesFirstKline(record.symbol);
        record.futuresLookupStatus = futures.status;
        record.futuresFirstKlineAt = futures.listedAt;
    }
    record.futuresListedNow = record.futuresLookupStatus === 'listed';
    record.futuresListedAtStart = Boolean(record.futuresFirstKlineAt && record.futuresFirstKlineAt <= record.startAt);

    const completedThrough = record.startAt + Math.floor((now - record.startAt) / HOUR_MS) * HOUR_MS;
    const history = historyInterval(record.startAt);
    let cursor = Math.max(Number(record.nextHistoryStartAt || record.startAt), record.startAt);
    for (let page = 0; page < MAX_HISTORY_PAGES_PER_TOURNAMENT && cursor < completedThrough; page += 1) {
        const rows = await fetchAlphaKlines(record.alphaId, history.interval, {
            startTime: cursor, endTime: completedThrough - 1, limit: KLINE_PAGE_SIZE,
        });
        if (!rows.length) break;
        updateExtremes(record, anchoredHourlyPoints(rows, record.startAt, completedThrough, history.candlesPerWindow));
        const lastAt = Number(rows.at(-1).timestamp);
        if (!(lastAt >= cursor)) break;
        cursor = lastAt + history.stepMs;
        record.nextHistoryStartAt = cursor;
        record.completeThroughAt = Math.min(cursor, completedThrough);
        record.historyInterval = history.interval;
        if (rows.length < KLINE_PAGE_SIZE) break;
    }

    const current = await fetchCurrentPrice(record.alphaId);
    if (current) Object.assign(record, { currentPrice: current.price, currentObservedAt: current.observedAt });
    record.holdReturnPct = percentChange(record.currentPrice, record.startVwap);
    record.peakReturnPct = percentChange(record.peakVwap, record.startVwap);
    record.lowReturnPct = percentChange(record.lowVwap, record.startVwap);
    record.rewardValueAtStart = record.rewardQty && record.startVwap ? record.rewardQty * record.startVwap : null;
    record.rewardValueNow = record.rewardQty && record.currentPrice ? record.rewardQty * record.currentPrice : null;
    record.updatedAt = Date.now();

    const ready = Number(record.startCandleCount) === 5 && positive(record.startVwap) && positive(record.currentPrice)
        && positive(record.peakVwap) && positive(record.lowVwap) && Boolean(record.futuresLookupStatus)
        && Number(record.completeThroughAt || 0) >= completedThrough;
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
            const message = String(error?.message || error).slice(0, 240);
            record.lastAttemptAt = Date.now();
            record.updatedAt = Date.now();
            if (previous.status === 'ready' && previous.analyticsMethod === ANALYTICS_METHOD) {
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
        processed: work.length, totalEligible: rows.length, stored: Object.keys(state.tournaments).length,
        ready: Object.values(state.tournaments).filter(row => row?.status === 'ready' && row?.analyticsMethod === ANALYTICS_METHOD).length,
        bytes, results,
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
    startupTimer.unref?.();
    interval.unref?.();
    return { run, startupTimer, interval };
}

module.exports = {
    MINUTE_MS, HALF_HOUR_MS, HOUR_MS, BASELINE_WINDOW_MS, STATE_KEY, ANALYTICS_METHOD,
    MAX_TOURNAMENTS_PER_RUN, normalizeKlines, computeVwap, aggregateHourlyVwap,
    historyInterval, anchoredHourlyPoints, hourlyVwapPoints, updateExtremes, percentChange,
    parseStartAt, parseEndAt, rewardMeta, recordFromTournament, chooseWorkRows, readState,
    fetchStartVwap, runCompetitionAnalyticsPhase1, startCompetitionAnalyticsPhase1,
};
