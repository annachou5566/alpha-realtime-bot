'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
    hardenCompetitionConfigSignalSource,
} = require('../lib/production-readonly-config-signal-hardening');
const {
    hardenProductionReadonlySource,
} = require('../lib/production-readonly-source-hardening');

const INDEX_PATH = path.join(__dirname, '..', 'index.js');
const countMatches = (text, pattern) => (text.match(pattern) || []).length;

test('Alpha config signal hardening applies exact anchors and stays separate from Spot', () => {
    const original = fs.readFileSync(INDEX_PATH, 'utf8');
    const { source, applied } = hardenCompetitionConfigSignalSource(original);

    assert.deepEqual(applied, [
        'config-realtime-import',
        'config-realtime-state',
        'config-realtime-row-baselines',
        'config-realtime-telemetry',
        'alpha-market-config-signal',
        'competition-revision-headers',
        'config-realtime-startup',
    ]);
    assert.match(source, /COMPETITION_CONFIG_ROW_BASELINES/);
    assert.match(source, /configSignal:/);
    assert.match(source, /X-Wave-Competition-Revision/);
    assert.match(source, /rememberRow: waveRememberCompetitionRow/);

    // Spot exists elsewhere in the legacy runtime. Prove this transform does not
    // add any new Spot route reference by comparing occurrence counts before/after.
    assert.equal(countMatches(source, /spot-market/g), countMatches(original, /spot-market/g));
    assert.equal(countMatches(source, /spot-tickers/g), countMatches(original, /spot-tickers/g));

    // The additive transform must remain compatible with the already-proven
    // production-readonly hardener rather than replacing its safety guards.
    const baseHardened = hardenProductionReadonlySource(source);
    assert.match(baseHardened.source, /server\.listen\(PORT, LISTEN_HOST, async \(\) => \{/);
    assert.match(baseHardened.source, /writeSafety:/);
});

test('Alpha config signal hardening fails closed when an expected anchor drifts', () => {
    assert.throws(
        () => hardenCompetitionConfigSignalSource("const { createClient } = require('@supabase/supabase-js');\n"),
        /expected once, found 0/,
    );
});
