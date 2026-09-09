'use strict';

const { HeadObjectCommand } = require('@aws-sdk/client-s3');
const { validateTailsHeadForSource } = require('./tails-cache-contract');
const { runTailsProducer } = require('./tails-producer');

function isNotFoundError(error) {
    const status = Number(error && error.$metadata && error.$metadata.httpStatusCode || 0);
    const name = String(error && (error.name || error.Code || error.code) || '');
    return status === 404 || ['NoSuchKey', 'NotFound'].includes(name);
}

async function readLiveHead(s3Client, bucket) {
    try {
        return await s3Client.send(new HeadObjectCommand({
            Bucket: bucket,
            Key: 'tails_cache.json',
        }));
    } catch (error) {
        if (isNotFoundError(error)) return null;
        throw error;
    }
}

async function runTailsProductionWriter(options = {}) {
    const {
        http,
        s3Client,
        bucket,
        nowMs = Date.now(),
        concurrency = 2,
        maxRequests = 2000,
        logger = console,
        producer = runTailsProducer,
    } = options;

    if (!http || typeof http.get !== 'function') {
        throw new Error('http-client-required');
    }
    if (!s3Client || typeof s3Client.send !== 'function') {
        throw new Error('s3-client-required');
    }
    if (!bucket) {
        throw new Error('bucket-required');
    }
    if (typeof producer !== 'function') {
        throw new Error('producer-required');
    }

    const liveHead = await readLiveHead(s3Client, bucket);
    if (liveHead) {
        const current = validateTailsHeadForSource(liveHead, {
            nowMs,
            key: 'tails_cache.json',
        });
        if (current.ok) {
            logger.log(
                `TAILS_PRODUCTION_SKIP_CURRENT boundary=${current.boundary} `
                + `etag=${String(liveHead.ETag || '')}`,
            );
            return {
                skipped: true,
                boundaryDate: current.boundary,
                publication: null,
                reason: 'live-current',
            };
        }

        logger.log(
            `TAILS_PRODUCTION_LIVE_REPLACE reason=${current.reason || 'invalid-head'} `
            + `expected_boundary=${current.expectedBoundary || ''}`,
        );
    } else {
        logger.log('TAILS_PRODUCTION_LIVE_REPLACE reason=missing-live-object');
    }

    const result = await producer({
        http,
        s3Client,
        bucket,
        nowMs,
        qualificationOnly: false,
        includePayload: false,
        maxTokens: 0,
        concurrency,
        maxRequests,
        logger,
    });

    if (!result || !result.publication) {
        throw new Error('tails-production-publication-missing');
    }

    if (
        !result.boundaryDate
        || !result.publication.payloadSha256
        || !Number.isFinite(Number(result.publication.bytes))
        || Number(result.publication.bytes) <= 0
    ) {
        throw new Error('tails-production-publication-invalid');
    }

    return {
        skipped: false,
        boundaryDate: result.boundaryDate,
        supportedLimitCount: Number(result.supportedLimitCount),
        unsupportedLimitCount: Number(result.unsupportedLimitCount),
        publication: result.publication,
        http: result.http,
    };
}

module.exports = {
    isNotFoundError,
    readLiveHead,
    runTailsProductionWriter,
};
