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
    MINUTE_MS,
    HOUR_MS,
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
} = require('../lib/competition-analytics-phase1');
Module._load = originalLoad;

const source = fs.readFileSync('lib/competition-analytics-phase1.js', 'utf8');
const bootstrapSource = fs.readFileSync('lib/competition-price-series.js', 'utf8');
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));

test('reward boundary uses exact tournament end UTC time', () => {
    assert.equal(parseRewardAt({ end: '2026-08-06', endTime: '13:00' }), Date.parse('2026-08-06T13:00:00Z'));
});

test('token reward unit falls back to the canonical symbol while USD remains explicit', () => {
    assert.deepEqual(rewardMeta({ name: 'O', rewardQty: '75' }, 'O (R2)'), { unit: 'O', quantity: 75 });
    assert.deepEqual(rewardMeta({ rewardUnit: 'USD', rewardQty: '50' }, 'CAP (R1)'), { unit: 'USD', quantity: 50 });
});

test('claim VWAP prefers exact quote-volume divided by base-volume', () => {
    const rows = [{ high: 12, low: 9, close: 9, volume: 2, quoteVolume: 22 }, { high: 24, low: 18, close: 18, volume: 1, quoteVolume: 20 }];
    assert.equal(computeVwap(rows), 14);
});

test('hourly analytics uses complete one-hour quote-volume VWAP and rejects partial hours', () => {
    const rewardAt = Date.parse('2026-08-06T13:00:00Z');
    const rows = normalizeKlines([
        [rewardAt, '9', '12', '9', '10', '2', rewardAt + HOUR_MS - 1, '22'],
        [rewardAt + HOUR_MS, '18', '24', '18', '20', '1', rewardAt + 2 * HOUR_MS - 1, '20'],
    ]);
    const complete = hourlyVwapPoints(rows, rewardAt, rewardAt + 2 * HOUR_MS);
    assert.equal(complete.length, 2);
    assert.equal(complete[0].vwap, 11);
    assert.equal(complete[1].vwap, 20);
    assert.equal(complete[0].method, ANALYTICS_METHOD);
    assert.equal(hourlyVwapPoints(rows, rewardAt, rewardAt + HOUR_MS + 30 * MINUTE_MS).length, 1);
});

test('legacy five-minute aggregation remains deterministic for claim-related helpers', () => {
    const rewardAt = Date.parse('2026-08-06T13:15:00Z');
    const rows = normalizeKlines([
        [rewardAt, '9', '12', '9', '9', '2'],
        [rewardAt + 5 * MINUTE_MS, '18', '24', '18', '18', '1'],
    ]);
    const hourly = aggregateHourlyVwap(rows, rewardAt);
    assert.equal(hourly.length, 1);
    assert.equal(hourly[0].hourAt, rewardAt);
});

test('peak and low remain executable VWAP zones, not candle wicks', () => {
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

test('work queue prioritizes method migration, rotates attempts and remains bounded', () => {
    assert.equal(MAX_TOURNAMENTS_PER_RUN, 6);
    const rows = Array.from({ length: 8 }, (_, index) => ({ id: index + 1 }));
    const state = { tournaments: {
        1: { analyticsMethod: ANALYTICS_METHOD, status: 'ready', lastAttemptAt: 1 },
        2: { analyticsMethod: 'old', status: 'ready', lastAttemptAt: 500 },
        3: { analyticsMethod: ANALYTICS_METHOD, status: 'backfilling', lastAttemptAt: 300 },
    } };
    const selected = chooseWorkRows(rows, state);
    assert.equal(selected.length, 6);
    assert.equal(selected[0].row.id, 8);
    assert.ok(selected.some(item => item.row.id === 2));
});

test('R2 missing object initializes empty state but transient failures abort', async () => {
    const missing = { async send() { const error = new Error('missing'); error.name = 'NoSuchKey'; throw error; } };
    assert.deepEqual(await readState(missing, 'bucket'), { version: 1, updatedAt: null, totalEligible: 0, tournaments: {} });
    const transient = { async send() { throw new Error('timeout'); } };
    await assert.rejects(() => readState(transient, 'bucket'), /timeout/);
});

test('fast backfill remains bounded, durable and fail closed', () => {
    assert.match(source, /MAX_HOURLY_PAGES_PER_TOURNAMENT = 4/);
    assert.match(source, /SYNC_INTERVAL_MS = 15 \* MINUTE_MS/);
    assert.match(source, /interval, '1h'|fetchAlphaKlines\(record\.alphaId, '1h'/);
    assert.match(source, /quoteVolume \/ volume/);
    assert.match(source, /selected\.length === 5/);
    assert.match(source, /bytes = await writeState[\s\S]*for \(const item of work\)/m);
    assert.match(source, /if \(running\) return \{ skipped: 'already-running' \}/);
    assert.doesNotMatch(source, /catch \(_\) \{\s*return null;\s*\}/);
});

test('Render keeps index.js as the only entry and starts analytics exactly once', () => {
    assert.equal(packageJson.scripts.start, 'node index.js');
    assert.equal(fs.existsSync('competition-analytics-entry.js'), false);
    assert.match(bootstrapSource, /require\.main && require\.main\.filename/);
    assert.match(bootstrapSource, /Symbol\.for\('wave-alpha\.competition-analytics-phase1\.started'\)/);
    assert.match(bootstrapSource, /startCompetitionAnalyticsPhase1\(\)/);
});
