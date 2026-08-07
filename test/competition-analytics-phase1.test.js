'use strict';

const fs = require('node:fs');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function mockRuntimeDependencies(request, parent, isMain) {
    if (request === 'axios') return { get: async () => ({ data: null }) };
    if (request === '@aws-sdk/client-s3') {
        class Command { constructor(input) { this.input = input; } }
        return {
            S3Client: class { async send() { return {}; } },
            GetObjectCommand: Command,
            PutObjectCommand: Command,
        };
    }
    if (request === '@supabase/supabase-js') return { createClient: () => ({}) };
    return originalLoad.call(this, request, parent, isMain);
};

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    FIVE_MIN_MS,
    HOUR_MS,
    normalizeKlines,
    computeVwap,
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
const EXPECTED_WEIGHTED_VWAP = 40 / 3;

test('reward boundary uses exact tournament end UTC time', () => {
    assert.equal(parseRewardAt({ end: '2026-08-06', endTime: '13:00' }), Date.parse('2026-08-06T13:00:00Z'));
});

test('token reward unit falls back to the canonical token symbol but USD remains explicit', () => {
    assert.deepEqual(rewardMeta({ name: 'O', rewardQty: '75' }, 'O (R2)'), { unit: 'O', quantity: 75 });
    assert.deepEqual(rewardMeta({ rewardUnit: 'USD', rewardQty: '50' }, 'CAP (R1)'), { unit: 'USD', quantity: 50 });
});

test('VWAP uses typical price weighted by real volume', () => {
    const rows = [
        { high: 12, low: 9, close: 9, volume: 2 },
        { high: 24, low: 18, close: 18, volume: 1 },
    ];
    assert.equal(computeVwap(rows), EXPECTED_WEIGHTED_VWAP);
    assert.equal(computeVwap([{ high: 1, low: 1, close: 1, volume: 0 }]), null);
});

test('hourly VWAP windows are anchored to reward time', () => {
    const rewardAt = Date.parse('2026-08-06T13:15:00Z');
    const rows = normalizeKlines([
        [rewardAt, '9', '12', '9', '9', '2'],
        [rewardAt + FIVE_MIN_MS, '18', '24', '18', '18', '1'],
        [rewardAt + HOUR_MS, '3', '6', '3', '3', '4'],
    ]);
    const hourly = aggregateHourlyVwap(rows, rewardAt);
    assert.equal(hourly.length, 2);
    assert.equal(hourly[0].hourAt, rewardAt);
    assert.equal(hourly[0].vwap, EXPECTED_WEIGHTED_VWAP);
    assert.equal(hourly[1].hourAt, rewardAt + HOUR_MS);
});

test('peak and low remain executable VWAP zones, not candle wicks', () => {
    const record = {};
    updateExtremes(record, [
        { hourAt: 1, vwap: 1.2 },
        { hourAt: 2, vwap: 0.8 },
        { hourAt: 3, vwap: 1.5 },
    ]);
    assert.equal(record.peakVwap, 1.5);
    assert.equal(record.lowVwap, 0.8);
});

test('returns compare current and peak against claim VWAP', () => {
    assert.ok(Math.abs(percentChange(1.1, 1) - 10) < 1e-10);
    assert.equal(percentChange(null, 1), null);
});

test('real tournament schema preserves symbol, alpha id and reward quantity', () => {
    const record = recordFromTournament({
        id: 164,
        name: 'O (R2)',
        data: { alphaId: 'ALPHA_991', end: '2026-08-06', endTime: '13:00', rewardQty: '75' },
    });
    assert.equal(record.symbol, 'O');
    assert.equal(record.rewardUnit, 'O');
    assert.equal(record.rewardQty, 75);
});

test('work queue rotates by oldest attempt and remains bounded to two', () => {
    const rows = [{ id: 3 }, { id: 2 }, { id: 1 }];
    const state = { tournaments: {
        3: { lastAttemptAt: 300, completeThroughAt: 0 },
        2: { lastAttemptAt: 100, completeThroughAt: 0 },
        1: { lastAttemptAt: 200, completeThroughAt: 0 },
    } };
    assert.deepEqual(chooseWorkRows(rows, state).map(item => item.row.id), [2, 1]);
});

test('R2 missing object initializes empty state but transient failures abort', async () => {
    const missing = { async send() { const error = new Error('missing'); error.name = 'NoSuchKey'; throw error; } };
    assert.deepEqual(await readState(missing, 'bucket'), { version: 1, updatedAt: null, tournaments: {} });
    const transient = { async send() { throw new Error('timeout'); } };
    await assert.rejects(() => readState(transient, 'bucket'), /timeout/);
});

test('claim, Futures and complete-hour contracts fail closed', () => {
    assert.match(source, /CLAIM_SEARCH_MS = 24 \* HOUR_MS/);
    assert.match(source, /startTime: firstTrade\.timestamp[\s\S]*firstTrade\.timestamp \+ CLAIM_WINDOW_MS - 1/);
    assert.match(source, /status === 400 && code === -1121/);
    assert.match(source, /throw error/);
    assert.match(source, /completedThrough = record\.rewardAt \+ Math\.floor/);
    assert.match(source, /point\.hourAt \+ HOUR_MS <= completedThrough/);
    assert.doesNotMatch(source, /catch \(_\) \{\s*return null;\s*\}/);
});

test('Render keeps index.js as the only entry and starts analytics exactly once', () => {
    assert.equal(packageJson.scripts.start, 'node index.js');
    assert.equal(fs.existsSync('competition-analytics-entry.js'), false);
    assert.match(bootstrapSource, /require\.main && require\.main\.filename/);
    assert.match(bootstrapSource, /\[\\\\\/\]index\\\.js\$/);
    assert.match(bootstrapSource, /Symbol\.for\('wave-alpha\.competition-analytics-phase1\.started'\)/);
    assert.match(bootstrapSource, /setImmediate\(\(\) =>/);
    assert.match(bootstrapSource, /startCompetitionAnalyticsPhase1\(\)/);
});
