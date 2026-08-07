'use strict';

const DAY_MS = 86_400_000;
const MAX_BUCKETS = 400;

function normalizeUtcTime(value, fallback = '00:00:00') {
    const raw = String(value || fallback).trim();
    if (/^\d{2}:\d{2}:\d{2}$/.test(raw)) return raw;
    if (/^\d{2}:\d{2}$/.test(raw)) return `${raw}:00`;
    return fallback;
}

function parseUtcBoundary(dateValue, timeValue, fallbackTime) {
    const date = String(dateValue || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
    return Date.parse(`${date}T${normalizeUtcTime(timeValue, fallbackTime)}Z`);
}

function competitionWindow(config) {
    const startAt = parseUtcBoundary(config && config.start, config && config.startTime, '00:00:00');
    const endAt = parseUtcBoundary(config && config.end, config && config.endTime, '23:59:59');
    return { startAt, endAt };
}

function nextUtcMidnight(timestamp) {
    const date = new Date(timestamp);
    return Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate() + 1,
        0, 0, 0, 0
    );
}

function getCompetitionMultipliers(config) {
    if (!Array.isArray(config && config.multipliers) || !config.multipliers.length) return [];
    const values = config.multipliers.map(value => Number(value));
    return values.every(value => Number.isFinite(value) && value > 0) ? values : [];
}

function buildTournamentBuckets(config) {
    const { startAt, endAt } = competitionWindow(config);
    if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) return [];

    const buckets = [];
    let cursor = startAt;
    while (cursor < endAt && buckets.length < MAX_BUCKETS) {
        const bucketEnd = Math.min(endAt, nextUtcMidnight(cursor));
        if (!(bucketEnd > cursor)) break;
        buckets.push({
            slot: buckets.length,
            date: new Date(cursor).toISOString().slice(0, 10),
            startAt: cursor,
            endAt: bucketEnd,
            partialStart: cursor !== Date.parse(`${new Date(cursor).toISOString().slice(0, 10)}T00:00:00Z`),
            partialEnd: bucketEnd === endAt && endAt !== nextUtcMidnight(endAt - 1),
        });
        cursor = bucketEnd;
    }
    return buckets;
}

function buildTournamentDayBuckets(config) {
    const { startAt, endAt } = competitionWindow(config);
    const multipliers = getCompetitionMultipliers(config);
    if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt || !multipliers.length) return [];

    const buckets = [];
    for (let index = 0; index < multipliers.length && index < MAX_BUCKETS; index += 1) {
        const bucketStart = startAt + index * DAY_MS;
        if (bucketStart >= endAt) break;
        const bucketEnd = Math.min(endAt, bucketStart + DAY_MS);
        buckets.push({
            slot: index,
            day: index + 1,
            multiplier: multipliers[index],
            date: new Date(bucketStart).toISOString().slice(0, 10),
            startAt: bucketStart,
            endAt: bucketEnd,
        });
    }
    return buckets;
}

function buildViewBoundaries(config) {
    const utcBuckets = buildTournamentBuckets(config);
    const dayBuckets = buildTournamentDayBuckets(config);
    if (!utcBuckets.length || !dayBuckets.length) return null;

    return {
        startAt: utcBuckets[0].startAt,
        endAt: utcBuckets[utcBuckets.length - 1].endAt,
        utcCalendar: [utcBuckets[0].startAt, ...utcBuckets.map(bucket => bucket.endAt)],
        tournamentDay: [dayBuckets[0].startAt, ...dayBuckets.map(bucket => bucket.endAt)],
        dayBuckets,
        utcBuckets,
    };
}

function buildTournamentBoundaries(config) {
    const views = buildViewBoundaries(config);
    if (!views) return [];

    const ownersByTimestamp = new Map();
    const add = (boundaryAt, owner, kind, index) => {
        if (!Number.isFinite(boundaryAt)) return;
        const entry = ownersByTimestamp.get(boundaryAt) || {
            boundaryAt,
            date: new Date(boundaryAt).toISOString().slice(0, 10),
            owners: [],
            kinds: {},
            indices: {},
        };
        if (!entry.owners.includes(owner)) entry.owners.push(owner);
        entry.kinds[owner] = kind;
        entry.indices[owner] = index;
        ownersByTimestamp.set(boundaryAt, entry);
    };

    views.utcCalendar.forEach((boundaryAt, index) => add(
        boundaryAt,
        'utc-calendar',
        index === 0 ? 'start' : 'bucket_end',
        index,
    ));
    views.tournamentDay.forEach((boundaryAt, index) => add(
        boundaryAt,
        'tournament-day',
        index === 0 ? 'start' : 'day_end',
        index,
    ));

    return [...ownersByTimestamp.values()]
        .sort((a, b) => a.boundaryAt - b.boundaryAt)
        .map((boundary, slot) => ({
            ...boundary,
            slot,
            kind: boundary.owners.length > 1
                ? 'shared'
                : boundary.kinds[boundary.owners[0]],
        }));
}

function normalizeKlineRows(payload) {
    const source = Array.isArray(payload)
        ? payload
        : (payload && payload.data && Array.isArray(payload.data.klineInfos)
            ? payload.data.klineInfos
            : []);

    return source.map(row => {
        if (Array.isArray(row)) {
            const timestamp = Number(row[0]);
            return {
                timestamp: timestamp < 100_000_000_000 ? timestamp * 1000 : timestamp,
                open: Number(row[1]),
                close: Number(row[4]),
            };
        }
        const rawTimestamp = Number(row && (row.timestamp ?? row.time ?? row.t));
        return {
            timestamp: rawTimestamp < 100_000_000_000 ? rawTimestamp * 1000 : rawTimestamp,
            open: Number(row && (row.openPrice ?? row.open)),
            close: Number(row && (row.closePrice ?? row.close)),
        };
    }).filter(row => Number.isFinite(row.timestamp) && row.timestamp > 0 && Number.isFinite(row.open) && row.open > 0)
      .sort((a, b) => a.timestamp - b.timestamp);
}

function chooseBoundaryPrice(rows, boundaryAt, maxDriftMs = 120_000) {
    const normalized = normalizeKlineRows(rows);
    if (!normalized.length || !Number.isFinite(boundaryAt)) return null;

    let best = null;
    for (const row of normalized) {
        const driftMs = Math.abs(row.timestamp - boundaryAt);
        if (!best || driftMs < best.driftMs || (driftMs === best.driftMs && row.timestamp >= boundaryAt)) {
            best = { row, driftMs };
        }
    }
    if (!best || best.driftMs > maxDriftMs) return null;

    return {
        price: best.row.open,
        observedAt: best.row.timestamp,
        driftMs: best.driftMs,
        quality: best.driftMs === 0 ? 'exact' : 'nearest',
    };
}

function reconcileBoundaryPoints(points, boundaries, toleranceMs = 1000) {
    const expected = Array.isArray(boundaries) ? boundaries : [];
    return (Array.isArray(points) ? points : [])
        .map(point => {
            const boundaryAt = Number(point && point.boundaryAt);
            const price = Number(point && point.price);
            if (!Number.isFinite(boundaryAt) || !(price > 0)) return null;
            const boundary = expected.find(candidate => Math.abs(candidate.boundaryAt - boundaryAt) <= toleranceMs);
            if (!boundary) return null;
            return {
                ...point,
                slot: boundary.slot,
                boundaryAt: boundary.boundaryAt,
                date: boundary.date,
                owners: boundary.owners,
                kinds: boundary.kinds,
                indices: boundary.indices,
                kind: boundary.owners.length > 1 ? 'shared' : boundary.kinds[boundary.owners[0]],
            };
        })
        .filter(Boolean)
        .sort((a, b) => Number(a.boundaryAt) - Number(b.boundaryAt));
}

function stableJsonHash(value) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function bootstrapCompetitionAnalyticsFromIndex() {
    const mainFile = require.main && require.main.filename;
    if (!mainFile || !/[\\/]index\.js$/.test(mainFile)) return false;

    const guard = Symbol.for('wave-alpha.competition-analytics-phase1.started');
    if (globalThis[guard]) return false;
    globalThis[guard] = true;

    setImmediate(() => {
        try {
            const { startCompetitionAnalyticsPhase1 } = require('./competition-analytics-phase1');
            startCompetitionAnalyticsPhase1();
        } catch (error) {
            console.warn('[COMP-ANALYTICS] bootstrap failed:', error && error.message || error);
        }
    });
    return true;
}

bootstrapCompetitionAnalyticsFromIndex();

module.exports = {
    DAY_MS,
    normalizeUtcTime,
    parseUtcBoundary,
    getCompetitionMultipliers,
    buildTournamentBuckets,
    buildTournamentDayBuckets,
    buildViewBoundaries,
    buildTournamentBoundaries,
    normalizeKlineRows,
    chooseBoundaryPrice,
    reconcileBoundaryPoints,
    stableJsonHash,
    bootstrapCompetitionAnalyticsFromIndex,
};
