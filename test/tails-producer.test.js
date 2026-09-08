'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    previousUtcBoundary,
    buildCohort,
    selectQualificationCohort,
    buildSuffixSum,
    runTailsProducer,
} = require('../lib/tails-producer');

const NOW = Date.parse('2026-09-08T06:00:00Z');
const BOUNDARY = previousUtcBoundary(NOW);

function marketPayload() {
    return JSON.stringify({
        data: [
            { i: 'A', st: 'ALPHA' },
            { i: 'B', st: 'ALPHA' },
            { i: 'C', st: 'SPOT' },
        ],
    });
}

function createS3Mock() {
    const calls = [];
    return {
        calls,
        async send(command) {
            const name = command && command.constructor && command.constructor.name;
            calls.push(name);
            if (name === 'GetObjectCommand') {
                return {
                    ETag: '"market-etag"',
                    Body: {
                        async transformToString() {
                            return marketPayload();
                        },
                    },
                };
            }
            throw new Error('unexpected-s3-command:' + name);
        },
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
                            { alphaId: 'A', symbol: 'AAA', chainId: 56, contractAddress: '0xAAA', volume24h: 100 },
                            { alphaId: 'B', symbol: 'BBB', chainId: 'CT_501', contractAddress: 'CaseSensitive', volume24h: 90 },
                            { alphaId: 'C', symbol: 'CCC', chainId: 56, contractAddress: '0xCCC', volume24h: 80 },
                        ],
                    },
                };
            }

            const parsed = new URL(url);
            const dataType = parsed.searchParams.get('dataType');
            const tokenAddress = parsed.searchParams.get('tokenAddress');
            const volume = dataType === 'limit' ? 4 : tokenAddress === 'CaseSensitive' ? 7 : 10;
            return {
                status: 200,
                data: {
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

test('cohort fails closed when canonical status is missing', () => {
    const raw = [
        { alphaId: 'A', chainId: 56, contractAddress: '0xA' },
        { alphaId: 'B', chainId: 56, contractAddress: '0xB' },
    ];
    const statuses = new Map([['A', 'ALPHA']]);
    assert.throws(() => buildCohort(raw, statuses), /market-status-missing:1/);
});

test('qualification sampling exercises BSC limit and non-BSC paths', () => {
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

test('qualification-only producer performs no R2 mutation', async () => {
    const s3 = createS3Mock();
    const http = createHttpMock();

    const result = await runTailsProducer({
        http,
        s3Client: s3,
        bucket: 'wave-alpha-data',
        nowMs: NOW,
        qualificationOnly: true,
        maxTokens: 2,
        concurrency: 2,
        maxRequests: 20,
        logger: { log() {} },
    });

    assert.equal(result.qualificationOnly, true);
    assert.equal(result.fullCohortCount, 2);
    assert.equal(result.selectedCohortCount, 2);
    assert.equal(result.selectedBscCount, 1);
    assert.equal(result.publication, null);
    assert.equal(result.http.requests, 4);
    assert.deepEqual(s3.calls, ['GetObjectCommand']);
    assert.equal(result.http.byKind['bulk-total'], 1);
    assert.equal(result.http.byKind['kline-aggregate'], 2);
    assert.equal(result.http.byKind['kline-limit'], 1);
});

test('write mode is blocked unless explicit production-write authorization exists', async () => {
    const old = process.env.TAILS_PRODUCTION_WRITE;
    delete process.env.TAILS_PRODUCTION_WRITE;
    try {
        await assert.rejects(
            runTailsProducer({
                http: createHttpMock(),
                s3Client: createS3Mock(),
                bucket: 'wave-alpha-data',
                nowMs: NOW,
                qualificationOnly: false,
            }),
            /production-write-not-authorized/,
        );
    } finally {
        if (old === undefined) delete process.env.TAILS_PRODUCTION_WRITE;
        else process.env.TAILS_PRODUCTION_WRITE = old;
    }
});
