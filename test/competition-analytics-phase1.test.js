'use strict';

const fs = require('node:fs');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function mockRuntimeDependencies(request, parent, isMain) {
    if (request === 'axios') return { get: async () => ({ data: null }) };
    if (request === '@aws-sdk/client-s3') {
        class Command { constructor(input) { this.input = input; } }
        return { S3Client: class { async send() { return {}; } }, GetObjectCommand: Command, PutObjectCommand: Command };
    }
    if (request === '@supabase/supabase-js') return { createClient: () => ({}) };
    return originalLoad.call(this, request, parent, isMain);
};

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    MINUTE_MS, HALF_HOUR_MS, HOUR_MS, ANALYTICS_METHOD, MAX_TOURNAMENTS_PER_RUN,
    normalizeKlines, computeVwap, aggregateHourlyVwap, historyInterval,
    anchoredHourlyPoints, hourlyVwapPoints, updateExtremes, percentChange,
    parseRewardAt, rewardMeta, recordFromTournament, chooseWorkRows, readState,
} = require('../lib/competition-analytics-phase1');
Module._load = originalLoad;

const source = fs.readFileSync('lib/competition-analytics-phase1.js', 'utf8');
const bootstrapSource = fs.readFileSync('lib/competition-price-series.js', 'utf8');
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));

test('reward boundary uses exact tournament end UTC time', () => {
    assert.equal(parseRewardAt({ end: '2026-08-06', endTime: '13:00' }), Date.parse('2026-08-06T13:00:00Z'));
    assert.equal(parseRewardAt({ end: '2026-06-15', endTime: '04:30' }), Date.parse('2026-06-15T04:30:00Z'));
});

test('token reward unit falls back to canonical symbol while USD remains explicit', () => {
    assert.deepEqual(rewardMeta({ name: 'O', rewardQty: '75' }, 'O (R2)'), { unit: 'O', quantity: 75 });
    assert.deepEqual(rewardMeta({ rewardUnit: 'USD', rewardQty: '50' }, 'CAP (R1)'), { unit: 'USD', quantity: 50 });
});

test('VWAP uses exact quote-volume divided by base-volume', () => {
    assert.equal(computeVwap([{ high: 12, low: 9, close: 9, volume: 2, quoteVolume: 22 }, { high: 24, low: 18, close: 18, volume: 1, quoteVolume: 20 }]), 14);
});

test('hour-aligned rewards use one complete 1h candle', () => {
    const rewardAt = Date.parse('2026-08-06T13:00:00Z');
    const rows = normalizeKlines([
        [rewardAt, '9', '12', '9', '10', '2', 0, '22'],
        [rewardAt + HOUR_MS, '18', '24', '18', '20', '1', 0, '20'],
    ]);
    assert.deepEqual(historyInterval(rewardAt), { interval: '1h', stepMs: HOUR_MS, candlesPerWindow: 1 });
    const points = hourlyVwapPoints(rows, rewardAt, rewardAt + 2 * HOUR_MS);
    assert.equal(points.length, 2);
    assert.equal(points[0].vwap, 11);
    assert.equal(points[0].method, ANALYTICS_METHOD);
});

test('half-hour rewards combine exactly two 30m candles into anchored hourly VWAP', () => {
    const rewardAt = Date.parse('2026-06-15T04:30:00Z');
    const rows = normalizeKlines([
        [rewardAt, '1', '2', '1', '1.5', '2', 0, '3'],
        [rewardAt + HALF_HOUR_MS, '1.5', '3', '1.5', '2.5', '4', 0, '10'],
        [rewardAt + HOUR_MS, '2.5', '4', '2', '3', '1', 0, '3'],
    ]);
    assert.deepEqual(historyInterval(rewardAt), { interval: '30m', stepMs: HALF_HOUR_MS, candlesPerWindow: 2 });
    const points = anchoredHourlyPoints(rows, rewardAt, rewardAt + 2 * HOUR_MS, 2);
    assert.equal(points.length, 1);
    assert.equal(points[0].hourAt, rewardAt);
    assert.equal(points[0].candleCount, 2);
    assert.ok(Math.abs(points[0].vwap - 13 / 6) < 1e-12);
});

test('partial anchored hours never update analytics', () => {
    const rewardAt = Date.parse('2026-06-15T04:30:00Z');
    const rows = normalizeKlines([[rewardAt, '1', '2', '1', '1.5', '2', 0, '3']]);
    assert.equal(anchoredHourlyPoints(rows, rewardAt, rewardAt + HOUR_MS, 2).length, 0);
});

test('minute aggregation remains deterministic for claim helpers', () => {
    const rewardAt = Date.parse('2026-08-06T13:15:00Z');
    const rows = normalizeKlines([[rewardAt, '9', '12', '9', '9', '2'], [rewardAt + 5 * MINUTE_MS, '18', '24', '18', '18', '1']]);
    assert.equal(aggregateHourlyVwap(rows, rewardAt).length, 1);
});

test('peak and low remain VWAP zones rather than candle wicks', () => {
    const record = {};
    updateExtremes(record, [{ hourAt: 1, vwap: 1.2 }, { hourAt: 2, vwap: 0.8 }, { hourAt: 3, vwap: 1.5 }]);
    assert.equal(record.peakVwap, 1.5);
    assert.equal(record.lowVwap, 0.8);
});

test('returns compare current and peak against claim VWAP', () => {
    assert.ok(Math.abs(percentChange(1.1, 1) - 10) < 1e-10);
    assert.equal(percentChange(null, 1), null);
});

test('real tournament schema preserves symbol, alpha id and reward quantity', () => {
    const record = recordFromTournament({ id: 164, name: 'O (R2)', data: { alphaId: 'ALPHA_991', end: '2026-08-06', endTime: '13:00', rewardQty: '75' } });
    assert.equal(record.symbol, 'O');
    assert.equal(record.rewardUnit, 'O');
    assert.equal(record.rewardQty, 75);
});

test('work queue prioritizes method migration and stays bounded', () => {
    assert.equal(MAX_TOURNAMENTS_PER_RUN, 6);
    const rows = Array.from({ length: 8 }, (_, index) => ({ id: index + 1 }));
    const state = { tournaments: { 1: { analyticsMethod: ANALYTICS_METHOD, status: 'ready' }, 2: { analyticsMethod: 'old', status: 'ready' } } };
    const selected = chooseWorkRows(rows, state);
    assert.equal(selected.length, 6);
    assert.ok(selected.every(item => item.existing.analyticsMethod !== ANALYTICS_METHOD));
    assert.equal(selected.some(item => item.row.id === 1), false);
});

test('R2 missing object initializes empty state while transient failures abort', async () => {
    const missing = { async send() { const error = new Error('missing'); error.name = 'NoSuchKey'; throw error; } };
    assert.deepEqual(await readState(missing, 'bucket'), { version: 1, updatedAt: null, totalEligible: 0, tournaments: {} });
    const transient = { async send() { throw new Error('timeout'); } };
    await assert.rejects(() => readState(transient, 'bucket'), /timeout/);
});

test('fast backfill is bounded, durable and fail closed', () => {
    assert.match(source, /MAX_HISTORY_PAGES_PER_TOURNAMENT = 4/);
    assert.match(source, /SYNC_INTERVAL_MS = 15 \* MINUTE_MS/);
    assert.match(source, /interval: '30m'/);
    assert.match(source, /candlesPerWindow: 2/);
    assert.match(source, /selected\.length === 5/);
    assert.match(source, /for \(const item of work\)[\s\S]*bytes = await writeState\(clients\.r2, clients\.bucket, state\)/m);
    assert.match(source, /if \(running\) return \{ skipped: 'already-running' \}/);
    assert.doesNotMatch(source, /catch \(_\) \{\s*return null;\s*\}/);
});

test('Render keeps index.js as the single entry and starts analytics once', () => {
    assert.equal(packageJson.scripts.start, 'node index.js');
    assert.equal(fs.existsSync('competition-analytics-entry.js'), false);
    assert.match(bootstrapSource, /require\.main && require\.main\.filename/);
    assert.match(bootstrapSource, /Symbol\.for\('wave-alpha\.competition-analytics-phase1\.started'\)/);
    assert.match(bootstrapSource, /startCompetitionAnalyticsPhase1\(\)/);
});
