'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
    hardenProductionReadonlySource,
} = require('../lib/production-readonly-source-hardening');

const INDEX_PATH = path.join(__dirname, '..', 'index.js');

test('production-readonly source hardening applies every safety anchor exactly once', () => {
    const original = fs.readFileSync(INDEX_PATH, 'utf8');
    const { source, applied } = hardenProductionReadonlySource(original);

    assert.deepEqual(applied, [
        'mode-loopback-and-state',
        'historical-refresh-guard',
        'start-offset-guard',
        'price-persistence-guard',
        'finalize-guard',
        'competition-live-write-guard',
        'inline-auto-finalize-guard',
        'tick-flush-guard',
        'admin-backfill-route-guard',
        'write-safety-telemetry',
        'loopback-bind',
    ]);

    assert.match(source, /PRODUCTION_READONLY_MODE/);
    assert.match(source, /const LISTEN_HOST = PRODUCTION_READONLY_MODE \? '127\.0\.0\.1' : undefined;/);
    assert.match(source, /Historical Binance refresh disabled/);
    assert.match(source, /Start-offset upstream scan disabled/);
    assert.match(source, /Competition price persistence disabled/);
    assert.match(source, /maxFetches: Math\.min\(2,/);
    assert.match(source, /Finalize suppressed/);
    assert.match(source, /competition-live-write/);
    assert.match(source, /const isNowFinalized = !PRODUCTION_READONLY_MODE &&/);
    assert.match(source, /tick-cache-flush/);
    assert.match(source, /Mutation unavailable in production-readonly mode/);
    assert.match(source, /writeSafety:/);
    assert.match(source, /server\.listen\(PORT, LISTEN_HOST, async \(\) => \{/);

    // Source hardening is a first-class checked-in runtime entrypoint but does not
    // rewrite the shared Render authority file in place.
    assert.equal(fs.readFileSync(INDEX_PATH, 'utf8'), original);
});

test('writer inventory is pinned so a new index mutation path reopens Phase 4A review', () => {
    const original = fs.readFileSync(INDEX_PATH, 'utf8');
    const putCount = (original.match(/new PutObjectCommand/g) || []).length;
    const deleteCount = (original.match(/new DeleteObjectCommand/g) || []).length;
    const supabaseUpdateCount = (original.match(/supabase\.from\('tournaments'\)\.update/g) || []).length;

    assert.equal(putCount, 7, 'current reviewed R2 PutObject inventory changed');
    assert.equal(deleteCount, 1, 'current reviewed R2 DeleteObject inventory changed');
    assert.equal(supabaseUpdateCount, 1, 'current reviewed Supabase update inventory changed');
});

test('production-readonly source hardening fails closed when an expected anchor drifts', () => {
    assert.throws(
        () => hardenProductionReadonlySource('const PORT = process.env.PORT || 3000;\n'),
        /expected once, found 0/,
    );
});
