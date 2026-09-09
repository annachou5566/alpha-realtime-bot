#!/usr/bin/env node
'use strict';

const axios = require('axios');
const { S3Client } = require('@aws-sdk/client-s3');
const { runTailsProductionWriter } = require('./lib/tails-production-writer');

const EXPECTED_R2_ENDPOINT =
    'https://0f534c1b6f9bc097235b37c07d1dc32e.r2.cloudflarestorage.com';
const EXPECTED_R2_BUCKET = 'wave-alpha-data';

function requireValue(name) {
    const value = String(process.env[name] || '').trim();
    if (!value) throw new Error(`missing-required-env:${name}`);
    return value;
}

function requireExact(name, expected) {
    const value = String(process.env[name] || '').trim();
    if (value !== expected) {
        throw new Error(`${name}-mismatch`);
    }
    return value;
}

function envInt(name, fallback, min, max) {
    const parsed = Number.parseInt(process.env[name] || '', 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

async function main() {
    requireExact('TAILS_WRITER_MODE', 'production');
    requireExact('TAILS_PRODUCTION_WRITE', 'true');
    requireExact('R2_ENDPOINT_URL', EXPECTED_R2_ENDPOINT);
    requireExact('R2_BUCKET_NAME', EXPECTED_R2_BUCKET);

    const accessKeyId = requireValue('R2_ACCESS_KEY_ID');
    const secretAccessKey = requireValue('R2_SECRET_ACCESS_KEY');

    const concurrency = envInt('TAILS_PRODUCTION_CONCURRENCY', 2, 1, 4);
    const maxRequests = envInt('TAILS_PRODUCTION_MAX_REQUESTS', 2000, 100, 2000);

    const s3Client = new S3Client({
        region: 'auto',
        endpoint: EXPECTED_R2_ENDPOINT,
        credentials: {
            accessKeyId,
            secretAccessKey,
        },
    });

    console.log('=== ALPHA_TAILS_PRODUCTION_WRITER_BEGIN ===');
    console.log('TAILS_WRITER_MODE=production');
    console.log('WRITE_TARGET=tails_cache.json');
    console.log(`CONCURRENCY=${concurrency}`);
    console.log(`REQUEST_BUDGET=${maxRequests}`);

    const result = await runTailsProductionWriter({
        http: axios,
        s3Client,
        bucket: EXPECTED_R2_BUCKET,
        concurrency,
        maxRequests,
        logger: console,
    });

    console.log(`BOUNDARY=${result.boundaryDate}`);
    console.log(`SKIPPED=${result.skipped === true}`);

    if (result.skipped) {
        console.log('TAILS_PRODUCTION_WRITE_EXECUTED=NO');
        console.log('TAILS_PRODUCTION_WRITER=PASS');
        console.log('=== ALPHA_TAILS_PRODUCTION_WRITER_END ===');
        return;
    }

    console.log(`LIMIT_SUPPORTED=${result.supportedLimitCount}`);
    console.log(`LIMIT_UNSUPPORTED=${result.unsupportedLimitCount}`);
    console.log(`PAYLOAD_BYTES=${result.publication.bytes}`);
    console.log(`PAYLOAD_SHA256=${result.publication.payloadSha256}`);
    console.log(`HTTP_REQUESTS=${Number(result.http && result.http.requests || 0)}`);
    console.log(`HTTP_RETRIES=${Number(result.http && result.http.retries || 0)}`);
    console.log('TAILS_PRODUCTION_WRITE_EXECUTED=YES');
    console.log('TAILS_PRODUCTION_WRITER=PASS');
    console.log('=== ALPHA_TAILS_PRODUCTION_WRITER_END ===');
}

main().catch(error => {
    console.error(`TAILS_PRODUCTION_WRITER_ERROR=${String(error && error.message || error)}`);
    console.error('TAILS_PRODUCTION_WRITER=FAIL');
    process.exitCode = 1;
});
