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

    // This feature belongs only to the Binance Alpha control/data plane.
    // The transform must not introduce any Spot route dependency.
    const introduced = source.replace(original, '');
    assert.doesNotMatch(introduced, /spot-market|spot-tickers/);

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
