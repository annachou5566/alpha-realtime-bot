'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildTournamentBuckets,
    buildTournamentBoundaries,
    chooseBoundaryPrice,
    normalizeKlineRows,
    reconcileBoundaryPoints,
} = require('../lib/competition-price-series');

test('seven-day competition is split into eight UTC calendar buckets', () => {
    const config = {
        start: '2026-07-30', startTime: '13:00',
        end: '2026-08-06', endTime: '13:00',
        multipliers: [2, 2, 1.8, 1.8, 1.5, 1.3, 1],
    };
    const buckets = buildTournamentBuckets(config);
    assert.equal(buckets.length, 8);
    assert.deepEqual(buckets.map(bucket => bucket.date), [
        '2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02',
        '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06',
    ]);
    assert.equal(new Date(buckets[0].startAt).toISOString(), '2026-07-30T13:00:00.000Z');
    assert.equal(new Date(buckets[0].endAt).toISOString(), '2026-07-31T00:00:00.000Z');
    assert.equal(new Date(buckets[7].startAt).toISOString(), '2026-08-06T00:00:00.000Z');
    assert.equal(new Date(buckets[7].endAt).toISOString(), '2026-08-06T13:00:00.000Z');
});

test('price boundaries contain exact start plus one end boundary per calendar bucket', () => {
    const points = buildTournamentBoundaries({
        start: '2026-07-30', startTime: '13:00',
        end: '2026-08-06', endTime: '13:00',
        multipliers: [2, 2, 1.8, 1.8, 1.5, 1.3, 1],
    });
    assert.equal(points.length, 9);
    assert.deepEqual(points.map(point => point.slot), [0,1,2,3,4,5,6,7,8]);
    assert.equal(new Date(points[0].boundaryAt).toISOString(), '2026-07-30T13:00:00.000Z');
    assert.equal(new Date(points[1].boundaryAt).toISOString(), '2026-07-31T00:00:00.000Z');
    assert.equal(new Date(points[8].boundaryAt).toISOString(), '2026-08-06T13:00:00.000Z');
});

test('same-day competition has one partial calendar bucket', () => {
    const buckets = buildTournamentBuckets({
        start: '2026-08-06', startTime: '09:15',
        end: '2026-08-06', endTime: '13:00',
    });
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].date, '2026-08-06');
    assert.equal(new Date(buckets[0].startAt).toISOString(), '2026-08-06T09:15:00.000Z');
    assert.equal(new Date(buckets[0].endAt).toISOString(), '2026-08-06T13:00:00.000Z');
});

test('boundary price rejects recent candles when a historical endpoint ignores endTime', () => {
    const boundaryAt = Date.parse('2026-07-30T13:00:00Z');
    const rows = [[Date.parse('2026-08-04T13:00:00Z'), '2', '2', '2', '2']];
    assert.equal(chooseBoundaryPrice(rows, boundaryAt), null);
});

test('boundary price uses exact candle open and normalizes second timestamps', () => {
    const boundaryAt = Date.parse('2026-07-30T13:00:00Z');
    const rows = [[boundaryAt / 1000, '0.1234', '0.13', '0.12', '0.125']];
    assert.deepEqual(normalizeKlineRows(rows)[0], {
        timestamp: boundaryAt,
        open: 0.1234,
        close: 0.125,
    });
    assert.deepEqual(chooseBoundaryPrice(rows, boundaryAt), {
        price: 0.1234,
        observedAt: boundaryAt,
        driftMs: 0,
        quality: 'exact',
    });
});

test('calendar-series migration drops legacy start-plus-24h points and keeps exact UTC boundaries', () => {
    const boundaries = buildTournamentBoundaries({
        start: '2026-08-04', startTime: '13:00',
        end: '2026-08-11', endTime: '13:00',
    });
    const legacy = [
        { slot: 0, boundaryAt: Date.parse('2026-08-04T13:00:00Z'), price: 1 },
        { slot: 1, boundaryAt: Date.parse('2026-08-05T13:00:00Z'), price: 2 },
        { slot: 2, boundaryAt: Date.parse('2026-08-06T13:00:00Z'), price: 3 },
    ];
    const kept = reconcileBoundaryPoints(legacy, boundaries);
    assert.deepEqual(kept.map(point => point.slot), [0]);
    assert.equal(kept[0].kind, 'start');

    const exact = boundaries.slice(0, 3).map((boundary, index) => ({
        slot: boundary.slot,
        boundaryAt: boundary.boundaryAt,
        price: index + 1,
    }));
    assert.deepEqual(
        reconcileBoundaryPoints(exact, boundaries).map(point => point.date),
        ['2026-08-04', '2026-08-04', '2026-08-05'],
    );
});
