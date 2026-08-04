'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../index.js'), 'utf8');

test('free-tier bandwidth safeguards remain enabled', () => {
    assert.match(source, /REALTIME_POLL_MS/);
    assert.match(source, /ENABLE_TICK_CACHE/);
    assert.match(source, /competition-price-series\.json/);
    assert.match(source, /\/api\/bandwidth-stats/);
    assert.match(source, /\/api\/competition-price-series/);
    assert.match(source, /x-wave-release', 'competition-price-series-v2/);
    assert.match(source, /`&endTime=\$\{boundaryAt \+ attempt\.maxDriftMs\}`/);
    assert.doesNotMatch(source, /`&startTime=\$\{Math\.max\(0, boundaryAt - attempt\.maxDriftMs\)\}`/);
    assert.match(source, /includeHistory: true, maxFetches: 100, dryRun: true/);
    assert.match(source, /includeHistory: true, maxFetches: 100/);
});
