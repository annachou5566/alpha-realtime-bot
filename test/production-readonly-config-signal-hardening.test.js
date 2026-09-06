'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

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
        'alpha-live-volume-publish',
        'config-realtime-startup',
    ]);
    assert.match(source, /COMPETITION_CONFIG_ROW_BASELINES/);
    assert.match(source, /configSignal:/);
    assert.match(source, /X-Wave-Competition-Revision/);
    assert.match(source, /rememberRow: waveRememberCompetitionRow/);
    assert.match(source, /canonicalAccumulatedTotal/);
    assert.match(source, /canonicalAccumulatedLimit/);
    assert.match(source, /Math\.max\(liveAccumulatedTotal, canonicalAccumulatedTotal\)/);
    assert.match(source, /Math\.max\(liveAccumulatedLimit, canonicalAccumulatedLimit\)/);
    assert.match(source, /const cumulativeReady = accumulatedTotal !== null && accumulatedLimit !== null && accumulatedOnchain !== null && accumulatedLimit <= accumulatedTotal/);

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

test('Alpha live cumulative onchain preserves canonical baseline and adds only prospective delta', () => {
    const original = fs.readFileSync(INDEX_PATH, 'utf8');
    const { source } = hardenCompetitionConfigSignalSource(original);

    const start = source.indexOf('function waveFiniteLiveNumber(value) {');
    const end = source.indexOf('function waveBuildAlphaLiveState() {', start);
    assert.ok(start >= 0 && end > start);

    const context = {
        ACTIVE_CONFIG: {
            alpha: {
                db_id: 7,
                total_accumulated_volume: 100,
                limit_accumulated_volume: 40,
                onchain_accumulated_volume: 70,
            },
        },
        GLOBAL_MARKET: {
            alpha: {
                effectiveTodayVol: 10,
                totalAccumulated: 110,
                limitAccumulated: 45,
                v: { dl: 5 },
                tx: 12,
            },
        },
        ALPHA_LIVE_VOLUME_OBSERVED_AT: 123456,
        ALPHA_LIVE_VOLUME_REVISION: 9,
        LIMIT_MAP_CACHE: { ts: 123450 },
    };

    vm.runInNewContext(source.slice(start, end), context);
    const snapshot = context.waveBuildAlphaLiveVolumeSnapshot();

    assert.equal(snapshot.items.alpha.accumulatedTotal, 110);
    assert.equal(snapshot.items.alpha.accumulatedLimit, 45);
    assert.equal(snapshot.items.alpha.accumulatedOnchain, 75);
});

test('Alpha config signal hardening fails closed when an expected anchor drifts', () => {
    assert.throws(
        () => hardenCompetitionConfigSignalSource("const { createClient } = require('@supabase/supabase-js');\n"),
        /expected once, found 0/,
    );
});
