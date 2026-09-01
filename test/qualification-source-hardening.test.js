'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
    hardenQualificationSource,
} = require('../lib/qualification-source-hardening');

const INDEX_PATH = path.join(__dirname, '..', 'index.js');

test('qualification source hardening applies every safety anchor exactly once', () => {
    const original = fs.readFileSync(INDEX_PATH, 'utf8');
    const { source, applied } = hardenQualificationSource(original);

    assert.deepEqual(applied, [
        'mode-and-loopback-host',
        'historical-scrape-guard',
        'start-offset-guard',
        'price-backfill-guard',
        'finalize-guard',
        'competition-live-write-guard',
        'auto-finalize-guard',
        'loopback-bind',
    ]);

    assert.match(source, /const LISTEN_HOST = QUALIFICATION_MODE \? '127\.0\.0\.1' : undefined;/);
    assert.match(source, /Historical Binance backfill disabled/);
    assert.match(source, /Start-offset upstream scan disabled/);
    assert.match(source, /Competition price backfill disabled/);
    assert.match(source, /Finalize suppressed/);
    assert.match(source, /async function writeCompetitionLive\(\) \{\n    if \(QUALIFICATION_MODE\) return;/);
    assert.match(source, /const isNowFinalized = !QUALIFICATION_MODE &&/);
    assert.match(source, /server\.listen\(PORT, LISTEN_HOST, async \(\) => \{/);

    // The transform is qualification-only and does not rewrite the repository file.
    assert.equal(fs.readFileSync(INDEX_PATH, 'utf8'), original);
});

test('qualification source hardening fails closed when an expected anchor drifts', () => {
    assert.throws(
        () => hardenQualificationSource('const PORT = process.env.PORT || 3000;\n'),
        /expected once, found 0/,
    );
});
