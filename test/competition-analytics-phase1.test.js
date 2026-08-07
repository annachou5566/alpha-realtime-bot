'use strict';

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
    recordFromTournament,
    chooseWorkRows,
} = require('../lib/competition-analytics-phase1');

Module._load = originalLoad;

const EXPECTED_WEIGHTED_VWAP = 40 / 3;

test('reward boundary uses exact tournament end UTC time', () => {
    assert.equal(
        parseRewardAt({ end: '2026-08-06', endTime: '13:00' }),
        Date.parse('2026-08-06T13:00:00Z'),
    );
});

test('VWAP uses typical price weighted by real volume', () => {
    const rows = [
        { high: 12, low: 9, close: 9, volume: 2 },
        { high: 24, low: 18, close: 18, volume: 1 },
    ];
    assert.equal(computeVwap(rows), EXPECTED_WEIGHTED_VWAP);
    assert.equal(computeVwap([{ high: 1, low: 1, close: 1, volume: 0 }]), null);
});

test('five-minute candles aggregate into independent hourly VWAP points', () => {
    const base = Date.parse('2026-08-06T13:00:00Z');
    const rows = normalizeKlines([
        [base, '9', '12', '9', '9', '2'],
        [base + FIVE_MIN_MS, '18', '24', '18', '18', '1'],
        [base + HOUR_MS, '3', '6', '3', '3', '4'],
    ]);
    const hourly = aggregateHourlyVwap(rows);
    assert.equal(hourly.length, 2);
    assert.equal(hourly[0].hourAt, base);
    assert.equal(hourly[0].vwap, EXPECTED_WEIGHTED_VWAP);
    assert.equal(hourly[1].vwap, 4);
});

test('peak and low VWAP remain executable volume-weighted zones, not wick highs', () => {
    const record = {};
    updateExtremes(record, [
        { hourAt: 1, vwap: 1.2 },
        { hourAt: 2, vwap: 0.8 },
        { hourAt: 3, vwap: 1.5 },
    ]);
    assert.equal(record.peakVwap, 1.5);
    assert.equal(record.peakVwapAt, 3);
    assert.equal(record.lowVwap, 0.8);
    assert.equal(record.lowVwapAt, 2);
});

test('returns compare current and peak against claim VWAP', () => {
    assert.ok(Math.abs(percentChange(1.1, 1) - 10) < 1e-10);
    assert.equal(percentChange(null, 1), null);
    assert.equal(percentChange(1, 0), null);
});

test('tournament record preserves reward and symbol metadata', () => {
    const record = recordFromTournament({
        id: 169,
        name: 'CAP (R2)',
        data: {
            alphaId: 'ALPHA_1005',
            end: '2026-08-12',
            endTime: '13:00',
            rewardUnit: 'CAP',
            rewardQty: '500',
        },
    });
    assert.equal(record.id, '169');
    assert.equal(record.symbol, 'CAP');
    assert.equal(record.alphaId, 'ALPHA_1005');
    assert.equal(record.rewardQty, 500);
});

test('work queue prioritizes least-complete records and stays bounded to two', () => {
    const rows = [{ id: 3 }, { id: 2 }, { id: 1 }];
    const state = {
        tournaments: {
            3: { completeThroughAt: 300 },
            2: { completeThroughAt: 100 },
            1: { completeThroughAt: 200 },
        },
    };
    assert.deepEqual(chooseWorkRows(rows, state).map(item => item.row.id), [2, 1]);
});
