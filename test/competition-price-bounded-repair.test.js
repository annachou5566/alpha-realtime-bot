'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { exactSnapshot } = require('../lib/competition-price-series-publisher');
const { validateScopedSnapshot } = require('../scripts/competition-price-bounded-repair');

function series(id) {
    return {
        version: 3,
        boundaryModel: 'dual',
        id: String(id),
        alphaId: 'ALPHA_' + id,
        symbol: 'T' + id,
        startAt: 1000,
        endAt: 5000,
        views: { tournamentDay: [1000, 5000], utcCalendar: [1000, 5000] },
        points: [{
            slot: 0,
            boundaryAt: 1000,
            date: '2026-09-05',
            kind: 'shared',
            owners: ['tournament-day','utc-calendar'],
            kinds: {},
            indices: {},
            observedAt: 1000,
            price: 1,
            quality: 'exact',
            driftMs: 0,
            source: 'binance-alpha',
            resolution: '1m',
        }],
    };
}

test('repair preflight allows target ids that have no stored series yet', () => {
    const data = {
        '181': series(181),
        '182': series(182),
        '183': series(183),
        '5': series(5),
    };
    const scoped = exactSnapshot(data, ['181','182','183','184','185','186','187','188']);
    assert.deepEqual(Object.keys(scoped), ['181','182','183']);
    assert.doesNotThrow(() => validateScopedSnapshot(data, scoped));
});

test('repair preflight fails if an existing target series is omitted as invalid', () => {
    const data = {
        '181': series(181),
        '184': {},
    };
    const scoped = exactSnapshot(data, ['181','182','183','184','185','186','187','188']);
    assert.throws(
        () => validateScopedSnapshot(data, scoped),
        /differs from present targets 181-188/,
    );
});

test('repair preflight fails if scoped snapshot contains an unrelated id', () => {
    const data = { '181': series(181) };
    const scoped = {
        ...exactSnapshot(data, ['181','182','183','184','185','186','187','188']),
        '5': series(5),
    };
    assert.throws(
        () => validateScopedSnapshot(data, scoped),
        /differs from present targets 181-188/,
    );
});
