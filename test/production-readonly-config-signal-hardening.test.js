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
    assert.match(source, /canonicalDailyTotal/);
    assert.match(source, /canonicalDailyLimit/);
    assert.match(source, /canonicalAccumulatedTotal/);
    assert.match(source, /canonicalAccumulatedLimit/);
    assert.match(source, /const prospectiveTotalDelta = rawTotalDelta !== null && rawLimitDelta !== null/);
    assert.match(source, /Math\.max\(rawTotalDelta, rawLimitDelta\)/);
    assert.doesNotMatch(source, /liveAccumulatedTotal|liveAccumulatedLimit/);
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

test('Alpha live cumulative is derived from canonical daily delta and ignores legacy accumulated drift', () => {
    const original = fs.readFileSync(INDEX_PATH, 'utf8');
    const { source } = hardenCompetitionConfigSignalSource(original);

    const start = source.indexOf('function waveFiniteLiveNumber(value) {');
    const end = source.indexOf('function waveBuildAlphaLiveState() {', start);
    assert.ok(start >= 0 && end > start);

    const context = {
        ACTIVE_CONFIG: {
            alpha: {
                db_id: 7,
                real_alpha_volume: 20,
                limit_daily_volume: 10,
                total_accumulated_volume: 100,
                limit_accumulated_volume: 40,
                onchain_accumulated_volume: 60,
            },
        },
        GLOBAL_MARKET: {
            alpha: {
                effectiveTodayVol: 25,
                totalAccumulated: 101,
                limitAccumulated: 80,
                v: { dl: 20 },
                tx: 12,
            },
        },
        ALPHA_LIVE_VOLUME_OBSERVED_AT: 123456,
        ALPHA_LIVE_VOLUME_REVISION: 9,
        LIMIT_MAP_CACHE: { ts: 123450 },
    };

    vm.runInNewContext(source.slice(start, end), context);
    const snapshot = context.waveBuildAlphaLiveVolumeSnapshot();

    assert.equal(snapshot.items.alpha.dailyTotal, 25);
    assert.equal(snapshot.items.alpha.dailyLimit, 20);
    assert.equal(snapshot.items.alpha.accumulatedTotal, 110);
    assert.equal(snapshot.items.alpha.accumulatedLimit, 50);
    assert.equal(snapshot.items.alpha.accumulatedOnchain, 60);
});

test('Alpha live cumulative adds prospective onchain only when total delta exceeds limit delta', () => {
    const original = fs.readFileSync(INDEX_PATH, 'utf8');
    const { source } = hardenCompetitionConfigSignalSource(original);

    const start = source.indexOf('function waveFiniteLiveNumber(value) {');
    const end = source.indexOf('function waveBuildAlphaLiveState() {', start);
    assert.ok(start >= 0 && end > start);

    const context = {
        ACTIVE_CONFIG: {
            alpha: {
                db_id: 7,
                real_alpha_volume: 20,
                limit_daily_volume: 10,
                total_accumulated_volume: 100,
                limit_accumulated_volume: 40,
                onchain_accumulated_volume: 60,
            },
        },
        GLOBAL_MARKET: {
            alpha: {
                effectiveTodayVol: 35,
                v: { dl: 15 },
                tx: 12,
            },
        },
        ALPHA_LIVE_VOLUME_OBSERVED_AT: 123456,
        ALPHA_LIVE_VOLUME_REVISION: 9,
        LIMIT_MAP_CACHE: { ts: 123450 },
    };

    vm.runInNewContext(source.slice(start, end), context);
    const snapshot = context.waveBuildAlphaLiveVolumeSnapshot();

    assert.equal(snapshot.items.alpha.accumulatedTotal, 115);
    assert.equal(snapshot.items.alpha.accumulatedLimit, 45);
    assert.equal(snapshot.items.alpha.accumulatedOnchain, 70);
});

test('Alpha config signal hardening fails closed when an expected anchor drifts', () => {
    assert.throws(
        () => hardenCompetitionConfigSignalSource("const { createClient } = require('@supabase/supabase-js');\n"),
        /expected once, found 0/,
    );
});
