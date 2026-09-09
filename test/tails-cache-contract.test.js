'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    stableIdsHash,
    expectedTailBoundaryDate,
    validateTailsHead,
    validateTailsHeadForSource,
    validateTailsPayload,
    currentTailValue,
    finiteNumberOrNull,
} = require('../lib/tails-cache-contract');

const NOW = Date.parse('2026-09-08T06:00:00Z');
const BOUNDARY = '2026-09-07';
const HASH_A = 'a'.repeat(64);

function goodHead() {
    return {
        ContentLength: 123,
        Metadata: {
            'wa-schema': '2',
            'boundary-date': BOUNDARY,
            'complete': 'true',
            'payload-sha256': HASH_A,
        },
    };
}

function goodPayload() {
    const idsHash = stableIdsHash(['ALPHA_1']);
    const emptyHash = stableIdsHash([]);
    return {
        schema_version: 2,
        boundary_date: BOUNDARY,
        window_start: '2026-09-07T00:00:00Z',
        window_end: '2026-09-07T23:59:59.999Z',
        generated_at: '2026-09-08T05:55:00Z',
        complete: true,
        expected_token_count: 1,
        covered_total_count: 1,
        expected_ids_hash: idsHash,
        covered_total_ids_hash: idsHash,

        limit_applicable_token_count: 1,
        classified_limit_token_count: 1,
        limit_applicable_ids_hash: idsHash,
        classified_limit_ids_hash: idsHash,

        expected_limit_token_count: 1,
        covered_limit_count: 1,
        expected_limit_ids_hash: idsHash,
        covered_limit_ids_hash: idsHash,

        unsupported_limit_token_count: 0,
        unsupported_limit_ids: [],
        unsupported_limit_ids_hash: emptyHash,

        total: { ALPHA_1: Array(1440).fill(10) },
        limit: { ALPHA_1: Array(1440).fill(4) },
    };
}

function unsupportedPayload() {
    const payload = goodPayload();
    const idsHash = stableIdsHash(['ALPHA_1']);
    const emptyHash = stableIdsHash([]);
    payload.expected_limit_token_count = 0;
    payload.covered_limit_count = 0;
    payload.expected_limit_ids_hash = emptyHash;
    payload.covered_limit_ids_hash = emptyHash;
    payload.unsupported_limit_token_count = 1;
    payload.unsupported_limit_ids = ['ALPHA_1'];
    payload.unsupported_limit_ids_hash = idsHash;
    payload.limit = {};
    return payload;
}

test('UTC boundary is always previous UTC calendar day', () => {
    assert.equal(expectedTailBoundaryDate(NOW), BOUNDARY);
    assert.equal(
        expectedTailBoundaryDate(Date.parse('2026-09-08T00:00:01Z')),
        BOUNDARY,
    );
});

test('head contract rejects legacy, stale, and incomplete artifacts', () => {
    assert.equal(validateTailsHead(goodHead(), NOW).ok, true);

    const legacy = goodHead();
    legacy.Metadata['wa-schema'] = '1';
    assert.equal(validateTailsHead(legacy, NOW).reason, 'schema');

    const stale = goodHead();
    stale.Metadata['boundary-date'] = '2026-09-06';
    assert.equal(validateTailsHead(stale, NOW).reason, 'boundary');

    const incomplete = goodHead();
    incomplete.Metadata.complete = 'false';
    assert.equal(validateTailsHead(incomplete, NOW).reason, 'incomplete');
});

test('live key preserves strict metadata head contract', () => {
    const result = validateTailsHeadForSource(goodHead(), {
        nowMs: NOW,
        key: 'tails_cache.json',
    });
    assert.equal(result.ok, true);
    assert.equal(result.sourceMode, 'live-metadata');

    const missingMetadata = { ContentLength: 123, Metadata: {} };
    const failed = validateTailsHeadForSource(missingMetadata, {
        nowMs: NOW,
        key: 'tails_cache.json',
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, 'schema');
});

test('shadow key requires exact pinned body hash and may tolerate absent custom metadata', () => {
    const missingMetadata = { ContentLength: 123, Metadata: {} };

    const missingPin = validateTailsHeadForSource(missingMetadata, {
        nowMs: NOW,
        key: 'tails_cache.v2.candidate.json',
    });
    assert.equal(missingPin.ok, false);
    assert.equal(missingPin.reason, 'pinned-payload-hash-required');

    const pinned = validateTailsHeadForSource(missingMetadata, {
        nowMs: NOW,
        key: 'tails_cache.v2.candidate.json',
        expectedPayloadSha256: HASH_A,
    });
    assert.equal(pinned.ok, true);
    assert.equal(pinned.sourceMode, 'pinned-shadow');
    assert.equal(pinned.metadataValidated, false);
    assert.equal(pinned.payloadSha256, HASH_A);

    const metadataMismatch = goodHead();
    const mismatch = validateTailsHeadForSource(metadataMismatch, {
        nowMs: NOW,
        key: 'tails_cache.v2.candidate.json',
        expectedPayloadSha256: 'b'.repeat(64),
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.reason, 'pinned-payload-hash-mismatch');
});

test('payload contract requires exact window, key hashes, and coverage', () => {
    assert.equal(validateTailsPayload(goodPayload(), NOW).ok, true);

    const stale = goodPayload();
    stale.boundary_date = '2026-09-06';
    assert.equal(validateTailsPayload(stale, NOW).reason, 'boundary');

    const wrongWindow = goodPayload();
    wrongWindow.window_start = '2026-09-07T00:01:00Z';
    assert.equal(validateTailsPayload(wrongWindow, NOW).reason, 'window');

    const partial = goodPayload();
    partial.covered_total_count = 0;
    assert.equal(validateTailsPayload(partial, NOW).reason, 'total-coverage');

    const wrongTotalKeys = goodPayload();
    wrongTotalKeys.total = { ALPHA_2: Array(1440).fill(10) };
    wrongTotalKeys.limit = { ALPHA_2: Array(1440).fill(4) };
    wrongTotalKeys.limit_applicable_ids_hash = stableIdsHash(['ALPHA_2']);
    wrongTotalKeys.classified_limit_ids_hash = stableIdsHash(['ALPHA_2']);
    wrongTotalKeys.expected_limit_ids_hash = stableIdsHash(['ALPHA_2']);
    wrongTotalKeys.covered_limit_ids_hash = stableIdsHash(['ALPHA_2']);
    assert.equal(validateTailsPayload(wrongTotalKeys, NOW).reason, 'total-keys-hash');

    const wrongLimitKeys = goodPayload();
    wrongLimitKeys.total = {
        ALPHA_1: Array(1440).fill(10),
        ALPHA_2: Array(1440).fill(10),
    };
    wrongLimitKeys.expected_token_count = 2;
    wrongLimitKeys.covered_total_count = 2;
    const wrongLimitTotalHash = stableIdsHash(['ALPHA_1', 'ALPHA_2']);
    wrongLimitKeys.expected_ids_hash = wrongLimitTotalHash;
    wrongLimitKeys.covered_total_ids_hash = wrongLimitTotalHash;
    wrongLimitKeys.limit = { ALPHA_2: Array(1440).fill(4) };
    wrongLimitKeys.limit_applicable_ids_hash = stableIdsHash(['ALPHA_2']);
    wrongLimitKeys.classified_limit_ids_hash = stableIdsHash(['ALPHA_2']);
    wrongLimitKeys.expected_limit_ids_hash = stableIdsHash(['ALPHA_1']);
    wrongLimitKeys.covered_limit_ids_hash = stableIdsHash(['ALPHA_1']);
    assert.equal(validateTailsPayload(wrongLimitKeys, NOW).reason, 'limit-keys-hash');

    const malformed = goodPayload();
    malformed.total.ALPHA_1 = Array(1439).fill(10);
    assert.equal(validateTailsPayload(malformed, NOW).reason, 'total-series-shape');

    const malformedLimit = goodPayload();
    malformedLimit.limit.ALPHA_1 = Array(1439).fill(4);
    assert.equal(validateTailsPayload(malformedLimit, NOW).reason, 'limit-series-shape');
});

test('payload contract accepts explicit unsupported limit capability without fabricating a series', () => {
    const result = validateTailsPayload(unsupportedPayload(), NOW);
    assert.equal(result.ok, true);
    assert.deepEqual(result.unsupportedLimitIds, ['ALPHA_1']);
});

test('payload contract rejects overlapping supported and unsupported limit capability', () => {
    const payload = goodPayload();
    payload.unsupported_limit_token_count = 1;
    payload.unsupported_limit_ids = ['ALPHA_1'];
    payload.unsupported_limit_ids_hash = stableIdsHash(['ALPHA_1']);
    payload.limit_applicable_token_count = 2;
    payload.classified_limit_token_count = 2;
    payload.limit_applicable_ids_hash = stableIdsHash(['ALPHA_1', 'ALPHA_1']);
    payload.classified_limit_ids_hash = stableIdsHash(['ALPHA_1', 'ALPHA_1']);
    const result = validateTailsPayload(payload, NOW);
    assert.equal(result.ok, false);
});

test('missing or stale tail is null, never zero', () => {
    const map = { ALPHA_1: Array(1440).fill(10) };
    const current = { available: true, boundaryDate: BOUNDARY };
    assert.equal(currentTailValue(current, map, 'ALPHA_1', 360, NOW), 10);

    assert.equal(
        currentTailValue({ available: false, boundaryDate: BOUNDARY }, map, 'ALPHA_1', 360, NOW),
        null,
    );
    assert.equal(
        currentTailValue({ available: true, boundaryDate: '2026-09-06' }, map, 'ALPHA_1', 360, NOW),
        null,
    );
    assert.equal(currentTailValue(current, {}, 'ALPHA_1', 360, NOW), null);
});

test('finiteNumberOrNull preserves true zero but rejects missing values', () => {
    assert.equal(finiteNumberOrNull(0), 0);
    assert.equal(finiteNumberOrNull('0'), 0);
    assert.equal(finiteNumberOrNull(null), null);
    assert.equal(finiteNumberOrNull(undefined), null);
    assert.equal(finiteNumberOrNull(''), null);
    assert.equal(finiteNumberOrNull('bad'), null);
});
