'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildTournamentBoundaries,
    chooseBoundaryPrice,
    normalizeKlineRows,
} = require('../lib/competition-price-series');

test('seven-day competition has one start price plus seven period-end prices', () => {
    const points = buildTournamentBoundaries({
        start: '2026-07-30', startTime: '13:00',
        end: '2026-08-06', endTime: '13:00',
        multipliers: [2, 2, 1.8, 1.8, 1.5, 1.3, 1],
    });
    assert.equal(points.length, 8);
    assert.deepEqual(points.map(point => point.slot), [0,1,2,3,4,5,6,7]);
    assert.equal(new Date(points[0].boundaryAt).toISOString(), '2026-07-30T13:00:00.000Z');
    assert.equal(new Date(points[7].boundaryAt).toISOString(), '2026-08-06T13:00:00.000Z');
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
