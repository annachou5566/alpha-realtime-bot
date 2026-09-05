'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeScopeIds,
    exactSnapshot,
    createCompetitionPriceSeriesPublisher,
} = require('../lib/competition-price-series-publisher');

function series(id, points) {
    return {
        version: 3,
        boundaryModel: 'dual',
        id: String(id),
        alphaId: 'ALPHA_' + id,
        symbol: 'T' + id,
        startAt: 1000,
        endAt: 5000,
        views: { tournamentDay: [1000, 5000], utcCalendar: [1000, 5000] },
        points,
    };
}

function exact(boundaryAt, price) {
    return {
        slot: 0,
        boundaryAt,
        date: '2026-09-05',
        kind: 'shared',
        owners: ['tournament-day','utc-calendar'],
        kinds: {},
        indices: {},
        observedAt: boundaryAt,
        price,
        quality: 'exact',
        driftMs: 0,
        source: 'binance-alpha',
        resolution: '1m',
    };
}

function nearest(boundaryAt, observedAt, price) {
    return {
        ...exact(boundaryAt, price),
        observedAt,
        driftMs: Math.abs(observedAt - boundaryAt),
        quality: 'nearest',
    };
}

test('scope ids are numeric, unique, ordered by request, and fail closed over the bound', () => {
    assert.deepEqual(normalizeScopeIds(['181','182','181']), ['181','182']);
    assert.deepEqual(normalizeScopeIds(null), []);
    assert.throws(() => normalizeScopeIds(['181','bad']), /must be numeric/);
    assert.throws(
        () => normalizeScopeIds(Array.from({length:33}, (_,i)=>String(i+1))),
        /exceeds 32 ids/,
    );
});

test('exactSnapshot with scope excludes every unrelated series and nearest point', () => {
    const cache = {
        '5': series(5, [nearest(1000, 1060, 1)]),
        '181': series(181, [exact(1000, 2), nearest(5000, 4999, 3)]),
        '182': series(182, [exact(1000, 4)]),
    };
    const scoped = exactSnapshot(cache, ['181','182']);
    assert.deepEqual(Object.keys(scoped), ['181','182']);
    assert.equal(scoped['181'].points.length, 1);
    assert.equal(scoped['181'].points[0].quality, 'exact');
    assert.equal(scoped['182'].points.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(scoped, '5'), false);
});

test('explicit empty scope never falls back to a whole snapshot', () => {
    const cache = {
        '5': series(5, [exact(1000, 1)]),
        '181': series(181, [exact(1000, 2)]),
    };
    assert.deepEqual(exactSnapshot(cache, []), {});
});

test('scoped publisher sends merge envelope containing only scope ids', async () => {
    let captured = null;
    const publisher = createCompetitionPriceSeriesPublisher({
        livePublishUrl: 'https://wave-alpha.pages.dev/api/alpha-live-publish',
        key: 'k'.repeat(32),
        now: () => 1788575000000,
        fetchImpl: async (url, options) => {
            captured = { url, options };
            return { ok: true, status: 204 };
        },
        logger: { warn() {} },
    });

    const cache = {
        '5': series(5, [nearest(1000, 1060, 1)]),
        '181': series(181, [exact(1000, 2)]),
        '182': series(182, [exact(1000, 4)]),
    };

    assert.equal(await publisher.publishSnapshot(cache, { scopeIds: ['181','182'] }), true);
    const body = JSON.parse(captured.options.body);
    assert.equal(body.mode, 'merge');
    assert.deepEqual(body.scopeIds, ['181','182']);
    assert.deepEqual(Object.keys(body.data), ['181','182']);
    assert.equal(Object.prototype.hasOwnProperty.call(body.data, '5'), false);
    assert.match(String(captured.options.headers['x-wave-signature']), /^sha256=[0-9a-f]{64}$/);
});

test('scoped publisher fails closed if requested series is absent', async () => {
    const publisher = createCompetitionPriceSeriesPublisher({
        livePublishUrl: 'https://wave-alpha.pages.dev/api/alpha-live-publish',
        key: 'k'.repeat(32),
        fetchImpl: async () => ({ ok: true, status: 204 }),
        logger: { warn() {} },
    });
    await assert.rejects(
        publisher.publishSnapshot({ '181': series(181, [exact(1000, 2)]) }, { scopeIds: ['181','182'] }),
        /missing requested series/,
    );
});

test('scoped publisher never truncates or downgrades an invalid scope into replace mode', async () => {
    let requests = 0;
    const publisher = createCompetitionPriceSeriesPublisher({
        livePublishUrl: 'https://wave-alpha.pages.dev/api/alpha-live-publish',
        key: 'k'.repeat(32),
        fetchImpl: async () => {
            requests += 1;
            return { ok: true, status: 204 };
        },
        logger: { warn() {} },
    });
    const cache = { '181': series(181, [exact(1000, 2)]) };
    await assert.rejects(publisher.publishSnapshot(cache, { scopeIds: [] }), /requires at least one id/);
    await assert.rejects(
        publisher.publishSnapshot(cache, { scopeIds: Array.from({length:33}, (_,i)=>String(i+1)) }),
        /exceeds 32 ids/,
    );
    assert.equal(requests, 0);
});
