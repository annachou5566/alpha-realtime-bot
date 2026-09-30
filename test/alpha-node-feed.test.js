'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    ALPHA_NODE_READ_RPC,
    createAlphaNodeFeedHandler,
    mapAlphaNodeReceipt,
    parseAlphaNodeQuery,
    projectAlphaNodeRpcResponse,
} = require('../lib/alpha-node-feed');

function poolRow(overrides = {}) {
    return {
        receiptId: 400,
        immutableRecordId: 'alpha-forecast-receipt:400',
        receiptKind: 'POOL_SCHEDULE_CAPTURE',
        sourceClass: 'APPROVED_POOL_SCHEDULE_CAPTURE_RECEIPT',
        serverRecordedAt: '2026-09-30T10:00:00Z',
        data: {
            scheduleAction: 'POOL_SCHEDULE_SET_OR_RESCHEDULED',
            poolId: '0x' + '11'.repeat(32),
            emitter: '0x' + '22'.repeat(20),
            operator: '0x' + '33'.repeat(20),
            txHash: '0x' + '44'.repeat(32),
            blockNumber: 124900000,
            logIndex: 7,
            chainEventAt: '2026-09-30T09:59:50Z',
            eventAt: '2026-09-30T12:00:00Z',
        },
        ...overrides,
    };
}

test('query parsing is bounded and cursor is optional', () => {
    assert.deepEqual(parseAlphaNodeQuery({}), {
        limit: 30,
        beforeId: null,
        rpcArgs: { p_limit: 30, p_before_id: null },
    });
    assert.deepEqual(parseAlphaNodeQuery({ limit: '50', before: '399' }), {
        limit: 50,
        beforeId: 399,
        rpcArgs: { p_limit: 50, p_before_id: 399 },
    });
    assert.throws(() => parseAlphaNodeQuery({ limit: '51' }), /limit invalid/);
    assert.throws(() => parseAlphaNodeQuery({ before: '0' }), /before invalid/);
});

test('Pool Schedule projection uses only canonical fields and computes receipt-time lead', () => {
    const item = mapAlphaNodeReceipt(poolRow());
    assert.equal(item.eventType, 'POOL_SCHEDULED_OR_RESCHEDULED');
    assert.equal(item.observedAt, '2026-09-30T10:00:00.000Z');
    assert.equal(item.eventAt, '2026-09-30T12:00:00.000Z');
    assert.equal(item.leadTimeSeconds, 7200);
    assert.equal(item.tokenContract, null);
    assert.equal(item.evidence.blockNumber, 124900000);
    assert.equal(item.evidence.logIndex, 7);
});

test('Pool clear refuses a fabricated eventAt', () => {
    const row = poolRow();
    row.data = {
        ...row.data,
        scheduleAction: 'POOL_SCHEDULE_CLEARED',
        eventAt: '2026-09-30T12:00:00Z',
    };
    assert.throws(() => mapAlphaNodeReceipt(row), /eventAt must be null/);
});

test('WATCH_ONLY artifact is explicitly not presented as a prediction', () => {
    const item = mapAlphaNodeReceipt({
        receiptId: 399,
        immutableRecordId: 'alpha-forecast-receipt:399',
        receiptKind: 'FORECAST_ARTIFACT',
        sourceClass: 'APPROVED_PERSISTENCE_SERVER_RECEIPT',
        serverRecordedAt: '2026-09-30T10:00:05Z',
        data: {
            chainId: '56',
            tokenContract: '0x' + '55'.repeat(20),
            rank: 'WATCH_ONLY',
            revisionNumber: 0,
            evidenceObservedThrough: '2026-09-30T10:00:04Z',
        },
    });
    assert.equal(item.waveForecastRank, 'WATCH_ONLY');
    assert.match(item.whyItMatters, /not a prediction/i);
});

test('direct-chain V1 projection never invents token, tx, transfer or amount details', () => {
    const item = mapAlphaNodeReceipt({
        receiptId: 398,
        immutableRecordId: 'alpha-forecast-receipt:398',
        receiptKind: 'DIRECT_CHAIN_CAPTURE',
        sourceClass: 'APPROVED_DIRECT_CHAIN_CAPTURE_RECEIPT',
        serverRecordedAt: '2026-09-30T10:00:03Z',
        data: {
            providerId: 'ankr-bsc-freemium-candidate',
            chainKey: 'bsc',
            chainEventAt: '2026-09-30T09:59:00Z',
            finality: 'BSC_FINALIZED_TAG_CONFIRMED',
        },
    });
    assert.equal(item.eventType, 'DIRECT_CHAIN_CAPTURED');
    assert.equal(item.tokenContract, null);
    assert.equal(item.poolId, null);
    assert.deepEqual(Object.keys(item.evidence).sort(), ['chainKey', 'finality', 'providerId']);
    assert.match(item.whyItMatters, /not inferred/i);
});

test('external advisory remains attributed external evidence', () => {
    const item = mapAlphaNodeReceipt({
        receiptId: 397,
        immutableRecordId: 'alpha-forecast-receipt:397',
        receiptKind: 'EXTERNAL_ADVISORY_OBSERVATION',
        sourceClass: 'APPROVED_EXTERNAL_ADVISORY_RECEIPT',
        serverRecordedAt: '2026-09-30T10:00:10Z',
        data: {
            sourceChannel: 'alpha123en',
            sourceObservationId: 'alpha123en:999',
            sourceUrl: 'https://t.me/alpha123en/999',
            sourcePublishedAt: '2026-09-30T09:50:00Z',
            waveObservedAt: '2026-09-30T09:50:05Z',
            sourceMessageType: 'FORECAST',
            projectName: 'Example',
            symbol: 'EX',
            contract: '0x' + '66'.repeat(20),
            eventAt: '2026-09-30T11:00:00Z',
            externalPrediction: true,
        },
    });
    assert.equal(item.eventType, 'EXTERNAL_ADVISORY_OBSERVED');
    assert.equal(item.source, 'EXTERNAL_ADVISORY');
    assert.match(item.whyItMatters, /not a Wave independent prediction/i);
});

test('RPC response requires descending unique immutable receipt IDs and bounded item count', () => {
    const a = poolRow();
    const b = {
        ...poolRow(),
        receiptId: 399,
        immutableRecordId: 'alpha-forecast-receipt:399',
    };
    const out = projectAlphaNodeRpcResponse({
        schemaVersion: 1,
        items: [a, b],
        hasMore: true,
        nextBeforeId: 399,
    }, 2);
    assert.equal(out.items.length, 2);
    assert.equal(out.nextBeforeId, 399);

    assert.throws(() => projectAlphaNodeRpcResponse({
        schemaVersion: 1,
        items: [b, a],
        hasMore: false,
        nextBeforeId: null,
    }, 2), /ordering invalid/);
});

test('route invokes only the frozen read RPC and returns projected payload', async () => {
    const calls = [];
    const supabase = {
        async rpc(name, args) {
            calls.push({ name, args });
            return {
                data: {
                    schemaVersion: 1,
                    items: [poolRow()],
                    hasMore: false,
                    nextBeforeId: null,
                },
                error: null,
            };
        },
    };
    const headers = {};
    let statusCode = 200;
    let body = null;
    const res = {
        setHeader(name, value) { headers[name] = value; },
        status(code) { statusCode = code; return this; },
        json(value) { body = value; return value; },
    };
    const handler = createAlphaNodeFeedHandler({
        supabase,
        logger: { error() {} },
    });

    await handler({ query: { limit: '10', before: '450' } }, res);

    assert.deepEqual(calls, [{
        name: ALPHA_NODE_READ_RPC,
        args: { p_limit: 10, p_before_id: 450 },
    }]);
    assert.equal(statusCode, 200);
    assert.equal(body.success, true);
    assert.equal(body.items[0].eventType, 'POOL_SCHEDULED_OR_RESCHEDULED');
    assert.match(headers['Cache-Control'], /s-maxage=30/);
});

test('route fails closed on malformed RPC data', async () => {
    const supabase = {
        async rpc() {
            return { data: { schemaVersion: 1, items: [{ bad: true }], hasMore: false }, error: null };
        },
    };
    let statusCode = 200;
    let body = null;
    const handler = createAlphaNodeFeedHandler({ supabase, logger: { error() {} } });
    const res = {
        setHeader() {},
        status(code) { statusCode = code; return this; },
        json(value) { body = value; return value; },
    };

    await handler({ query: {} }, res);
    assert.equal(statusCode, 503);
    assert.deepEqual(body, { success: false, error: 'Alpha Node feed unavailable' });
});
