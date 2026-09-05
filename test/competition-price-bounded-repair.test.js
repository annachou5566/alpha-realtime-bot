'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { exactSnapshot } = require('../lib/competition-price-series-publisher');
const {
    validateScopedSnapshot,
    buildDynamicPasses,
    validateAndPlan,
} = require('../scripts/competition-price-bounded-repair');

function exactPoint(i = 0) {
    const boundaryAt = 1000 + i * 1000;
    return {
        slot: i,
        boundaryAt,
        date: '2026-09-05',
        kind: 'shared',
        owners: ['tournament-day','utc-calendar'],
        kinds: {},
        indices: {},
        observedAt: boundaryAt,
        price: 1 + i,
        quality: 'exact',
        driftMs: 0,
        source: 'binance-alpha',
        resolution: '1m',
    };
}

function nearestPoint(i = 0) {
    const point = exactPoint(i);
    return {
        ...point,
        observedAt: point.boundaryAt + 60000,
        quality: 'nearest',
        driftMs: 60000,
    };
}

function series(id, exactCount = 1, nearestCount = 0) {
    const points = [];
    for (let i = 0; i < exactCount; i += 1) points.push(exactPoint(i));
    for (let i = 0; i < nearestCount; i += 1) points.push(nearestPoint(exactCount + i));
    return {
        version: 3,
        boundaryModel: 'dual',
        id: String(id),
        alphaId: 'ALPHA_' + id,
        symbol: 'T' + id,
        startAt: 1000,
        endAt: 20000,
        views: { tournamentDay: [1000, 20000], utcCalendar: [1000, 20000] },
        points,
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

test('repair plan accepts monotonic exact progress and shrinks the attempt budget', () => {
    const data = {
        '181': series(181, 2, 1),
        '182': series(182, 2, 1),
        '183': series(183, 1),
        '184': series(184, 2),
        '185': series(185, 2),
        '186': series(186, 2),
        '187': series(187, 2),
        '188': series(188, 2),
    };

    const plan = validateAndPlan(data);
    assert.equal(plan.budget, 56);
    assert.deepEqual(plan.remainingById, {
        '181': 13,
        '182': 13,
        '183': 14,
        '184': 6,
        '185': 4,
        '186': 4,
        '187': 2,
        '188': 0,
    });
    assert.equal(plan.passes.length, 14);
    assert.deepEqual(plan.passes[0], ['181','182','183','184','185','186','187']);
    assert.deepEqual(plan.passes[13], ['183']);
});

test('dynamic pass construction never schedules more attempts than remaining boundaries', () => {
    const remaining = {
        '181': 2,
        '182': 1,
        '183': 0,
        '184': 0,
        '185': 0,
        '186': 0,
        '187': 0,
        '188': 0,
    };
    const passes = buildDynamicPasses(remaining);
    assert.deepEqual(passes, [
        ['181','182'],
        ['181'],
    ]);
    assert.equal(passes.reduce((sum, ids) => sum + ids.length, 0), 3);
});

test('repair plan fails closed on regression below the original checkpoint', () => {
    const data = {
        '181': series(181, 1, 2),
        '182': series(182, 2, 1),
        '183': series(183, 1),
    };
    assert.throws(
        () => validateAndPlan(data),
        /scope regression ID=181/,
    );
});

test('repair plan fails closed on malformed exact points', () => {
    const data = {
        '181': series(181, 2, 1),
        '182': series(182, 2, 1),
        '183': series(183, 1),
    };
    data['181'].points[0] = {
        ...data['181'].points[0],
        observedAt: data['181'].points[0].boundaryAt + 1,
        driftMs: 1,
    };
    assert.throws(
        () => validateAndPlan(data),
        /invalid exact point ID=181/,
    );
});
