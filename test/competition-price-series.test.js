'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    DAY_MS,
    getCompetitionMultipliers,
    buildTournamentBuckets,
    buildTournamentDayBuckets,
    buildViewBoundaries,
    buildTournamentBoundaries,
    chooseBoundaryPrice,
    normalizeKlineRows,
    reconcileBoundaryPoints,
} = require('../lib/competition-price-series');

const config = {
    start: '2026-07-30', startTime: '13:00',
    end: '2026-08-06', endTime: '13:00',
    multipliers: [2, 1.9, 1.8, 1.7, 1.5, 1.3, 1],
};

test('seven tournament days are exact 24-hour windows', () => {
    const buckets = buildTournamentDayBuckets(config);
    assert.equal(buckets.length, 7);
    assert.equal(buckets[0].day, 1);
    assert.equal(buckets[0].endAt - buckets[0].startAt, DAY_MS);
    assert.equal(new Date(buckets[0].startAt).toISOString(), '2026-07-30T13:00:00.000Z');
    assert.equal(new Date(buckets[0].endAt).toISOString(), '2026-07-31T13:00:00.000Z');
    assert.equal(new Date(buckets[6].endAt).toISOString(), '2026-08-06T13:00:00.000Z');
    assert.deepEqual(buckets.map(bucket => bucket.multiplier), config.multipliers);
});

test('seven tournament days span eight UTC calendar buckets', () => {
    const buckets = buildTournamentBuckets(config);
    assert.equal(buckets.length, 8);
    assert.deepEqual(buckets.map(bucket => bucket.date), [
        '2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02',
        '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06',
    ]);
    assert.equal(new Date(buckets[0].endAt).toISOString(), '2026-07-31T00:00:00.000Z');
    assert.equal(new Date(buckets[7].startAt).toISOString(), '2026-08-06T00:00:00.000Z');
});

test('view boundary metadata keeps DAY and UTC timelines separate', () => {
    const views = buildViewBoundaries(config);
    assert.equal(views.tournamentDay.length, 8);
    assert.equal(views.utcCalendar.length, 9);
    assert.equal(new Date(views.tournamentDay[1]).toISOString(), '2026-07-31T13:00:00.000Z');
    assert.equal(new Date(views.utcCalendar[1]).toISOString(), '2026-07-31T00:00:00.000Z');
});

test('dual price boundaries are a timestamp-deduplicated union', () => {
    const boundaries = buildTournamentBoundaries(config);
    assert.equal(boundaries.length, 15);
    assert.deepEqual(boundaries.map(boundary => boundary.slot), Array.from({ length: 15 }, (_, i) => i));
    assert.equal(boundaries[0].kind, 'shared');
    assert.deepEqual(boundaries[0].owners.sort(), ['tournament-day', 'utc-calendar']);
    assert.ok(boundaries.some(boundary => boundary.boundaryAt === Date.parse('2026-07-31T00:00:00Z')));
    assert.ok(boundaries.some(boundary => boundary.boundaryAt === Date.parse('2026-07-31T13:00:00Z')));
    assert.equal(boundaries.at(-1).boundaryAt, Date.parse('2026-08-06T13:00:00Z'));
    assert.equal(boundaries.at(-1).kind, 'shared');
});

test('same-day competition has one partial calendar and one partial Day bucket', () => {
    const sameDay = {
        start: '2026-08-06', startTime: '09:15',
        end: '2026-08-06', endTime: '13:00',
        multipliers: [2],
    };
    assert.equal(buildTournamentBuckets(sameDay).length, 1);
    assert.equal(buildTournamentDayBuckets(sameDay).length, 1);
    assert.equal(buildTournamentDayBuckets(sameDay)[0].endAt, Date.parse('2026-08-06T13:00:00Z'));
});

test('missing official multipliers produces no DAY series or dual boundaries', () => {
    const missing = {
        start: '2026-08-04', startTime: '13:00',
        end: '2026-08-11', endTime: '13:00',
        earlyBird: '1.4x',
    };
    assert.deepEqual(getCompetitionMultipliers(missing), []);
    assert.deepEqual(buildTournamentDayBuckets(missing), []);
    assert.equal(buildViewBoundaries(missing), null);
    assert.deepEqual(buildTournamentBoundaries(missing), []);
});

test('invalid multiplier arrays fail closed instead of coercing values to one', () => {
    const invalid = {
        start: '2026-08-04', startTime: '13:00',
        end: '2026-08-11', endTime: '13:00',
        multipliers: [2, '', null, 1],
    };
    assert.deepEqual(getCompetitionMultipliers(invalid), []);
    assert.deepEqual(buildTournamentDayBuckets(invalid), []);
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

test('migration preserves exact old DAY and UTC points by timestamp, not old slot', () => {
    const boundaries = buildTournamentBoundaries({
        start: '2026-08-04', startTime: '13:00',
        end: '2026-08-11', endTime: '13:00',
        multipliers: [3, 2, 1.8, 1.6, 1.4, 1.2, 1],
    });
    const previous = [
        { slot: 0, boundaryAt: Date.parse('2026-08-04T13:00:00Z'), price: 1 },
        { slot: 1, boundaryAt: Date.parse('2026-08-05T00:00:00Z'), price: 2 },
        { slot: 1, boundaryAt: Date.parse('2026-08-05T13:00:00Z'), price: 3 },
        { slot: 9, boundaryAt: Date.parse('2026-08-05T12:00:00Z'), price: 4 },
    ];
    const kept = reconcileBoundaryPoints(previous, boundaries);
    assert.deepEqual(kept.map(point => point.boundaryAt), [
        Date.parse('2026-08-04T13:00:00Z'),
        Date.parse('2026-08-05T00:00:00Z'),
        Date.parse('2026-08-05T13:00:00Z'),
    ]);
    assert.equal(kept[0].kind, 'shared');
    assert.deepEqual(kept[2].owners, ['tournament-day']);
});
