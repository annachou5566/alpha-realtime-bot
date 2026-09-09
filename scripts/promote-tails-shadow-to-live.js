#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const {
    S3Client,
    HeadObjectCommand,
    GetObjectCommand,
    PutObjectCommand,
} = require('@aws-sdk/client-s3');
const {
    validateTailsPayload,
    validateTailsHeadForSource,
} = require('../lib/tails-cache-contract');

const EXPECTED_R2_ENDPOINT =
    'https://0f534c1b6f9bc097235b37c07d1dc32e.r2.cloudflarestorage.com';
const EXPECTED_R2_BUCKET = 'wave-alpha-data';
const SHADOW_KEY = 'tails_cache.v2.candidate.json';
const LIVE_KEY = 'tails_cache.json';

function requireValue(name) {
    const value = String(process.env[name] || '').trim();
    if (!value) throw new Error(`missing-required-env:${name}`);
    return value;
}

function requireExact(name, expected) {
    const value = String(process.env[name] || '').trim();
    if (value !== expected) throw new Error(`${name}-mismatch`);
    return value;
}

async function bodyString(response) {
    if (!response || !response.Body || typeof response.Body.transformToString !== 'function') {
        throw new Error('r2-body-unavailable');
    }
    return response.Body.transformToString();
}

function sha256(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

async function main() {
    requireExact('TAILS_PROMOTION_MODE', 'production');
    requireExact('R2_ENDPOINT_URL', EXPECTED_R2_ENDPOINT);
    requireExact('R2_BUCKET_NAME', EXPECTED_R2_BUCKET);

    const expectedSha = requireValue('TAILS_PROMOTION_EXPECTED_SHA256').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expectedSha)) {
        throw new Error('expected-sha256-invalid');
    }

    const accessKeyId = requireValue('R2_ACCESS_KEY_ID');
    const secretAccessKey = requireValue('R2_SECRET_ACCESS_KEY');

    const s3 = new S3Client({
        region: 'auto',
        endpoint: EXPECTED_R2_ENDPOINT,
        credentials: { accessKeyId, secretAccessKey },
    });

    console.log('=== ALPHA_TAILS_LIVE_PROMOTION_BEGIN ===');
    console.log(`SOURCE_KEY=${SHADOW_KEY}`);
    console.log(`TARGET_KEY=${LIVE_KEY}`);

    const shadowHead = await s3.send(new HeadObjectCommand({
        Bucket: EXPECTED_R2_BUCKET,
        Key: SHADOW_KEY,
    }));
    const shadowLength = Number(shadowHead.ContentLength || 0);
    if (!Number.isFinite(shadowLength) || shadowLength <= 0) {
        throw new Error('shadow-content-length-invalid');
    }

    const shadow = await s3.send(new GetObjectCommand({
        Bucket: EXPECTED_R2_BUCKET,
        Key: SHADOW_KEY,
    }));
    const body = await bodyString(shadow);
    const bodySha = sha256(body);

    console.log(`SHADOW_BYTES=${Buffer.byteLength(body)}`);
    console.log(`SHADOW_SHA256=${bodySha}`);

    if (bodySha !== expectedSha) {
        throw new Error('shadow-sha256-mismatch');
    }
    if (Buffer.byteLength(body) !== shadowLength) {
        throw new Error('shadow-head-body-length-mismatch');
    }

    const payload = JSON.parse(body);
    const contract = validateTailsPayload(payload, Date.now());
    if (!contract.ok) {
        throw new Error(`shadow-payload-contract:${contract.reason}`);
    }

    console.log(`BOUNDARY=${contract.boundary}`);
    console.log(`SUPPORTED_LIMIT_COUNT=${Object.keys(payload.limit || {}).length}`);
    console.log(`UNSUPPORTED_LIMIT_COUNT=${(contract.unsupportedLimitIds || []).length}`);

    let liveBefore = null;
    try {
        liveBefore = await s3.send(new HeadObjectCommand({
            Bucket: EXPECTED_R2_BUCKET,
            Key: LIVE_KEY,
        }));
        console.log(`LIVE_BEFORE_ETAG=${String(liveBefore.ETag || '')}`);
        console.log(`LIVE_BEFORE_BYTES=${Number(liveBefore.ContentLength || 0)}`);
    } catch (error) {
        const status = Number(error && error.$metadata && error.$metadata.httpStatusCode || 0);
        const name = String(error && (error.name || error.Code || error.code) || '');
        if (!(status === 404 || ['NoSuchKey', 'NotFound'].includes(name))) throw error;
        console.log('LIVE_BEFORE_MISSING=YES');
    }

    await s3.send(new PutObjectCommand({
        Bucket: EXPECTED_R2_BUCKET,
        Key: LIVE_KEY,
        Body: Buffer.from(body),
        ContentType: 'application/json',
        Metadata: {
            'wa-schema': '2',
            'boundary-date': contract.boundary,
            complete: 'true',
            'payload-sha256': bodySha,
        },
    }));
    console.log('LIVE_PUT_EXECUTED=YES');

    const postHead = await s3.send(new HeadObjectCommand({
        Bucket: EXPECTED_R2_BUCKET,
        Key: LIVE_KEY,
    }));
    const headContract = validateTailsHeadForSource(postHead, {
        nowMs: Date.now(),
        key: LIVE_KEY,
    });

    if (!headContract.ok) {
        throw new Error(`live-head-contract:${headContract.reason}`);
    }
    if (headContract.payloadSha256 !== expectedSha) {
        throw new Error('live-head-sha256-mismatch');
    }

    const post = await s3.send(new GetObjectCommand({
        Bucket: EXPECTED_R2_BUCKET,
        Key: LIVE_KEY,
    }));
    const postBody = await bodyString(post);
    const postSha = sha256(postBody);

    console.log(`LIVE_POST_BYTES=${Buffer.byteLength(postBody)}`);
    console.log(`LIVE_POST_SHA256=${postSha}`);
    console.log(`LIVE_POST_SOURCE=${headContract.sourceMode}`);

    if (postSha !== expectedSha) throw new Error('live-post-sha256-mismatch');
    if (postSha !== headContract.payloadSha256) throw new Error('live-head-body-sha256-mismatch');
    if (Buffer.byteLength(postBody) !== Number(postHead.ContentLength || 0)) {
        throw new Error('live-head-body-length-mismatch');
    }

    const postPayload = validateTailsPayload(JSON.parse(postBody), Date.now());
    if (!postPayload.ok) {
        throw new Error(`live-post-payload-contract:${postPayload.reason}`);
    }

    console.log('ALPHA_TAILS_LIVE_PROMOTION=PASS');
    console.log('=== ALPHA_TAILS_LIVE_PROMOTION_END ===');
}

main().catch(error => {
    console.error(`ALPHA_TAILS_LIVE_PROMOTION_ERROR=${String(error && error.message || error)}`);
    console.error('ALPHA_TAILS_LIVE_PROMOTION=FAIL');
    process.exitCode = 1;
});
