'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runTailsProductionWriter } = require('../lib/tails-production-writer');

const NOW = Date.parse('2026-09-09T12:00:00Z');
const HASH = 'a'.repeat(64);

function validHead(boundary = '2026-09-08') {
    return {
        ETag: '"etag-current"',
        ContentLength: 123,
        Metadata: {
            'wa-schema': '2',
            'boundary-date': boundary,
            complete: 'true',
            'payload-sha256': HASH,
        },
    };
}

function httpStub() {
    return { get: async () => ({ status: 200, data: {} }) };
}

test('production writer skips when live metadata already proves current boundary', async () => {
    let producerCalls = 0;
    const s3Client = {
        async send() {
            return validHead();
        },
    };

    const result = await runTailsProductionWriter({
        http: httpStub(),
        s3Client,
        bucket: 'wave-alpha-data',
        nowMs: NOW,
        logger: { log() {} },
        producer: async () => {
            producerCalls += 1;
            throw new Error('must-not-run');
        },
    });

    assert.equal(result.skipped, true);
    assert.equal(result.boundaryDate, '2026-09-08');
    assert.equal(producerCalls, 0);
});

test('production writer replaces stale live head through exactly one producer call', async () => {
    let producerCalls = 0;
    let producerOptions = null;
    const s3Client = {
        async send() {
            return validHead('2026-09-07');
        },
    };

    const result = await runTailsProductionWriter({
        http: httpStub(),
        s3Client,
        bucket: 'wave-alpha-data',
        nowMs: NOW,
        concurrency: 2,
        maxRequests: 2000,
        logger: { log() {} },
        producer: async options => {
            producerCalls += 1;
            producerOptions = options;
            return {
                boundaryDate: '2026-09-08',
                supportedLimitCount: 249,
                unsupportedLimitCount: 62,
                publication: {
                    payloadSha256: HASH,
                    bytes: 6909187,
                    etag: '"new"',
                },
                http: { requests: 1225, retries: 0 },
            };
        },
    });

    assert.equal(producerCalls, 1);
    assert.equal(producerOptions.qualificationOnly, false);
    assert.equal(producerOptions.maxTokens, 0);
    assert.equal(producerOptions.bucket, 'wave-alpha-data');
    assert.equal(result.skipped, false);
    assert.equal(result.supportedLimitCount, 249);
    assert.equal(result.unsupportedLimitCount, 62);
});

test('production writer treats missing live object as replaceable but fails on unexpected HEAD error', async () => {
    let calls = 0;
    const missing = {
        async send() {
            const error = new Error('missing');
            error.name = 'NoSuchKey';
            error.$metadata = { httpStatusCode: 404 };
            throw error;
        },
    };

    const produced = await runTailsProductionWriter({
        http: httpStub(),
        s3Client: missing,
        bucket: 'wave-alpha-data',
        nowMs: NOW,
        logger: { log() {} },
        producer: async () => {
            calls += 1;
            return {
                boundaryDate: '2026-09-08',
                supportedLimitCount: 249,
                unsupportedLimitCount: 62,
                publication: {
                    payloadSha256: HASH,
                    bytes: 6909187,
                    etag: '"new"',
                },
                http: { requests: 1, retries: 0 },
            };
        },
    });

    assert.equal(produced.skipped, false);
    assert.equal(calls, 1);

    const broken = {
        async send() {
            throw new Error('transport-failure');
        },
    };

    await assert.rejects(
        runTailsProductionWriter({
            http: httpStub(),
            s3Client: broken,
            bucket: 'wave-alpha-data',
            nowMs: NOW,
            logger: { log() {} },
            producer: async () => {
                throw new Error('must-not-run');
            },
        }),
        /transport-failure/,
    );
});

test('production writer fails closed when producer does not prove publication', async () => {
    const s3Client = {
        async send() {
            return validHead('2026-09-07');
        },
    };

    await assert.rejects(
        runTailsProductionWriter({
            http: httpStub(),
            s3Client,
            bucket: 'wave-alpha-data',
            nowMs: NOW,
            logger: { log() {} },
            producer: async () => ({
                boundaryDate: '2026-09-08',
                publication: null,
            }),
        }),
        /tails-production-publication-missing/,
    );
});
