'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    expectedTailBoundaryDate,
    validateTailsHead,
    validateTailsPayload,
    currentTailValue,
    finiteNumberOrNull,
} = require('../lib/tails-cache-contract');

const NOW = Date.parse('2026-09-08T06:00:00Z');
const BOUNDARY = '2026-09-07';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

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
    return {
        schema_version: 2,
        boundary_date: BOUNDARY,
        generated_at: '2026-09-08T05:55:00Z',
        complete: true,
        expected_token_count: 1,
        covered_total_count: 1,
        expected_limit_token_count: 1,
        covered_limit_count: 1,
        expected_ids_hash: HASH_A,
        covered_total_ids_hash: HASH_A,
        expected_limit_ids_hash: HASH_B,
        covered_limit_ids_hash: HASH_B,
        total: { ALPHA_1: Array(1440).fill(10) },
        limit: { ALPHA_1: Array(1440).fill(4) },
    };
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

test('payload contract requires exact total coverage and current boundary', () => {
    assert.equal(validateTailsPayload(goodPayload(), NOW).ok, true);

    const stale = goodPayload();
    stale.boundary_date = '2026-09-06';
    assert.equal(validateTailsPayload(stale, NOW).reason, 'boundary');

    const partial = goodPayload();
    partial.covered_total_count = 0;
    assert.equal(validateTailsPayload(partial, NOW).reason, 'total-coverage');

    const malformed = goodPayload();
    malformed.total.ALPHA_1 = Array(1439).fill(10);
    assert.equal(validateTailsPayload(malformed, NOW).reason, 'total-series-shape');
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
