'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    previousUtcBoundary,
    buildCohort,
    resolveLiveCohort,
    selectQualificationCohort,
    parseKlinePayload,
    buildSuffixSum,
    buildPayload,
    runTailsProducer,
} = require('../lib/tails-producer');

const NOW = Date.parse('2026-09-08T06:00:00Z');
const BOUNDARY = previousUtcBoundary(NOW);

function token(alphaId, chainId, contractAddress, extra = {}) {
    return {
        alphaId,
        symbol: alphaId,
        chainId,
        contractAddress,
        volume24h: 100,
        offline: false,
        listingCex: false,
        ...extra,
    };
}

function createHttpMock() {
    const calls = [];
    return {
        calls,
        async get(url) {
            calls.push(url);
            if (url.includes('aggTicker24')) {
                return {
                    status: 200,
                    data: {
                        success: true,
                        data: [
                            token('A', 56, '0xA'),
                            token('B', 'CT_501', 'CaseSensitive'),
                            token('C', 56, '0xC'),
                            token('D', 56, '0xD', { offline: true }),
                            token('E', 56, '0xE', { offline: true }),
                            token('F', 56, '0xF', { offline: true }),
                            token('S', 56, '0xS', { offline: true, listingCex: true }),
                        ],
                    },
                };
            }

            const parsed = new URL(url);
            const dataType = parsed.searchParams.get('dataType');
            const interval = parsed.searchParams.get('interval');
            const addr = parsed.searchParams.get('tokenAddress');

            if (interval === '1d' && dataType === 'limit') {
                if (addr === '0xd') {
                    return {
                        status: 200,
                        data: {
                            code: '-5101',
                            message: 'current token not support limit data source',
                            data: null,
                        },
                    };
                }
                if (addr === '0xf') {
                    return {
                        status: 200,
                        data: {
                            code: '-5095',
                            message: 'bad token address',
                            data: null,
                        },
                    };
                }
                if (addr === '0xe') {
                    return {
                        status: 200,
                        data: {
                            code: '000000',
                            data: {
                                klineInfos: [
                                    [BOUNDARY.startMs - 86400000, 0, 0, 0, 0, 0],
                                    [BOUNDARY.startMs, 0, 0, 0, 0, 7],
                                ],
                            },
                        },
                    };
                }
            }

            if (interval === '1m' && dataType === 'limit' && addr === '0xc') {
                return {
                    status: 200,
                    data: {
                        code: '-5101',
                        message: 'current token not support limit data source',
                        data: null,
                    },
                };
            }

            const volume = dataType === 'limit'
                ? 4
                : addr === 'CaseSensitive'
                    ? 7
                    : 10;
            return {
                status: 200,
                data: {
                    code: '000000',
                    data: {
                        klineInfos: [[BOUNDARY.startMs, 0, 0, 0, 0, volume]],
                    },
                },
            };
        },
    };
}

test('previous UTC boundary is exact to the millisecond', () => {
    assert.equal(BOUNDARY.boundaryDate, '2026-09-07');
    assert.equal(BOUNDARY.windowStart, '2026-09-07T00:00:00.000Z');
    assert.equal(BOUNDARY.windowEnd, '2026-09-07T23:59:59.999Z');
});

test('cohort uses live state and stages offline non-CEX rows for requalification', () => {
    const cohort = buildCohort([
        token('A', 56, '0xA'),
        token('D', 56, '0xD', { offline: true }),
        token('S', 56, '0xS', { offline: true, listingCex: true }),
    ]);
    assert.deepEqual(cohort.map(x => x.alphaId), ['A']);
    assert.equal(cohort.diagnostics.offlineProbe.length, 1);
    assert.equal(cohort.diagnostics.offlineProbe[0].alphaId, 'D');
    assert.equal(cohort.diagnostics.excludedSpot, 1);
});

test('offline liveness excludes -5101/-5095 and revives only positive recent limit volume', async () => {
    const http = createHttpMock();
    const cohort = await resolveLiveCohort(http, [
        token('A', 56, '0xA'),
        token('D', 56, '0xD', { offline: true }),
        token('E', 56, '0xE', { offline: true }),
        token('F', 56, '0xF', { offline: true }),
    ], {
        concurrency: 2,
        maxRequests: 20,
    });

    assert.deepEqual(cohort.map(x => x.alphaId), ['A', 'E']);
    assert.equal(cohort.diagnostics.online, 1);
    assert.equal(cohort.diagnostics.offlineProbed, 3);
    assert.equal(cohort.diagnostics.offlineRevived, 1);
    assert.equal(cohort.diagnostics.offlineExcluded, 2);
    assert.equal(cohort.diagnostics.offlineUnsupported, 1);
    assert.equal(cohort.diagnostics.offlineInvalidAddress, 1);
});

test('kline -5095 is explicit invalid-address evidence, not a fabricated zero', () => {
    const parsed = parseKlinePayload({
        code: '-5095',
        message: 'bad token address',
    }, 'ALPHA_798', 'limit-liveness');
    assert.equal(parsed.capability, 'invalid-address');
    assert.deepEqual(parsed.rows, []);
});

test('kline -5101 is explicit unsupported capability, not missing zero', () => {
    const parsed = parseKlinePayload({
        code: '-5101',
        message: 'current token not support limit data source',
    }, 'ALPHA_994', 'limit');
    assert.equal(parsed.capability, 'unsupported');
    assert.deepEqual(parsed.rows, []);
});

test('qualification sampling exercises BSC and non-BSC paths', () => {
    const cohort = [
        { alphaId: 'A', chainId: '56' },
        { alphaId: 'B', chainId: 'CT_501' },
        { alphaId: 'C', chainId: '56' },
        { alphaId: 'D', chainId: 'CT_784' },
    ];
    const selected = selectQualificationCohort(cohort, 2);
    assert.deepEqual(selected.map(x => x.alphaId), ['A', 'B']);
});

test('suffix sum preserves a real zero and exact 1440-point shape', () => {
    const rows = [
        [BOUNDARY.startMs, 0, 0, 0, 0, 0],
        [BOUNDARY.startMs + 60_000, 0, 0, 0, 0, 5],
    ];
    const series = buildSuffixSum(rows, BOUNDARY.boundaryDate);
    assert.equal(series.length, 1440);
    assert.equal(series[0], 5);
    assert.equal(series[1], 5);
    assert.equal(series[2], 0);
});

test('explicit successful empty kline response may produce a zero tail, but missing rows may not', () => {
    const explicit = buildSuffixSum([], BOUNDARY.boundaryDate, { allowExplicitEmpty: true });
    assert.equal(explicit.length, 1440);
    assert.equal(explicit.every(v => v === 0), true);
    assert.equal(buildSuffixSum([], BOUNDARY.boundaryDate), null);
});

test('payload partitions BSC limit capability into supported and unsupported sets', () => {
    const cohort = [
        { alphaId: 'A', chainId: '56' },
        { alphaId: 'B', chainId: 'CT_501' },
        { alphaId: 'C', chainId: '56' },
    ];
    const tails = [
        { id: 'A', total: Array(1440).fill(10), limitApplicable: true, limitSupported: true, limit: Array(1440).fill(4) },
        { id: 'B', total: Array(1440).fill(7), limitApplicable: false, limitSupported: false, limit: null },
        { id: 'C', total: Array(1440).fill(9), limitApplicable: true, limitSupported: false, limit: null },
    ];
    const payload = buildPayload(BOUNDARY, cohort, tails, NOW);
    assert.equal(payload.limit_applicable_token_count, 2);
    assert.equal(payload.classified_limit_token_count, 2);
    assert.equal(payload.expected_limit_token_count, 1);
    assert.equal(payload.unsupported_limit_token_count, 1);
    assert.deepEqual(payload.unsupported_limit_ids, ['C']);
    assert.deepEqual(Object.keys(payload.limit), ['A']);
});

test('qualification-only producer is Binance-only and performs no R2 mutation', async () => {
    const http = createHttpMock();

    const result = await runTailsProducer({
        http,
        nowMs: NOW,
        qualificationOnly: true,
        maxTokens: 0,
        concurrency: 2,
        maxRequests: 30,
        logger: { log() {} },
    });

    assert.equal(result.qualificationOnly, true);
    assert.equal(result.fullCohortCount, 4);
    assert.equal(result.onlineCount, 3);
    assert.equal(result.offlineProbedCount, 3);
    assert.equal(result.offlineRevivedCount, 1);
    assert.equal(result.offlineExcludedCount, 2);
    assert.equal(result.offlineInvalidAddressCount, 1);
    assert.equal(result.selectedCohortCount, 4);
    assert.equal(result.selectedBscCount, 3);
    assert.equal(result.supportedLimitCount, 2);
    assert.equal(result.unsupportedLimitCount, 1);
    assert.equal(result.publication, null);
    assert.equal(result.http.requests, 11);
    assert.equal(result.http.byKind['bulk-total'], 1);
    assert.equal(result.http.byKind['offline-liveness-limit'], 3);
    assert.equal(result.http.byKind['kline-aggregate'], 4);
    assert.equal(result.http.byKind['kline-limit'], 3);
});

test('active tail fetch fails closed if Binance returns -5095 invalid address', async () => {
    const http = createHttpMock();
    const baseGet = http.get.bind(http);
    http.get = async url => {
        const parsed = new URL(url);
        if (
            parsed.pathname.includes('agg-klines')
            && parsed.searchParams.get('interval') === '1m'
            && parsed.searchParams.get('dataType') === 'limit'
            && parsed.searchParams.get('tokenAddress') === '0xa'
        ) {
            return {
                status: 200,
                data: {
                    code: '-5095',
                    message: 'bad token address',
                    data: null,
                },
            };
        }
        return baseGet(url);
    };

    await assert.rejects(
        runTailsProducer({
            http,
            nowMs: NOW,
            qualificationOnly: true,
            maxTokens: 0,
            concurrency: 2,
            maxRequests: 40,
            logger: { log() {} },
        }),
        /kline-invalid-address:A:limit/,
    );
});

test('write mode is blocked unless explicit production-write authorization exists', async () => {
    const old = process.env.TAILS_PRODUCTION_WRITE;
    delete process.env.TAILS_PRODUCTION_WRITE;
    try {
        await assert.rejects(
            runTailsProducer({
                http: createHttpMock(),
                qualificationOnly: false,
            }),
            /production-write-not-authorized/,
        );
    } finally {
        if (old === undefined) delete process.env.TAILS_PRODUCTION_WRITE;
        else process.env.TAILS_PRODUCTION_WRITE = old;
    }
});
