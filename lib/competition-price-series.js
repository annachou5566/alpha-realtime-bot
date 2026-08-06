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

function nextUtcMidnight(timestamp) {
    const date = new Date(timestamp);
    return Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate() + 1,
        0, 0, 0, 0
    );
}

function buildTournamentBuckets(config) {
    const startAt = parseUtcBoundary(config && config.start, config && config.startTime, '00:00:00');
    const endAt = parseUtcBoundary(config && config.end, config && config.endTime, '23:59:59');
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

function buildTournamentBoundaries(config) {
    const buckets = buildTournamentBuckets(config);
    if (!buckets.length) return [];

    const boundaries = [{
        slot: 0,
        boundaryAt: buckets[0].startAt,
        date: buckets[0].date,
        kind: 'start',
    }];
    buckets.forEach((bucket, index) => {
        boundaries.push({
            slot: index + 1,
            boundaryAt: bucket.endAt,
            date: bucket.date,
            kind: 'bucket_end',
        });
    });
    return boundaries;
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

function stableJsonHash(value) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

module.exports = {
    DAY_MS,
    normalizeUtcTime,
    parseUtcBoundary,
    buildTournamentBuckets,
    buildTournamentBoundaries,
    normalizeKlineRows,
    chooseBoundaryPrice,
    stableJsonHash,
};
