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
    assert.match(source, /x-wave-release', 'competition-price-series-v4/);
    assert.ok(source.includes("REALTIME_POLL_MS', 5 * 60_000"));
    assert.ok(source.includes("CONFIG_SYNC_MS', 30 * 60_000"));
    assert.ok(source.includes("TOKEN_LIST_SYNC_MS', 6 * 60 * 60_000"));
    assert.match(source, /Base History unchanged; skipped body download/);
    assert.ok(source.includes('syncBaseData({ force: true })'));
    assert.match(source, /HeadObjectCommand/);
    assert.match(source, /Tails Cache unchanged; skipped 24 MB body download/);
    assert.match(source, /let SPOT_TICKER_SHOULD_RUN = false/);
    assert.match(source, /let SPOT_TICKER_LAST_REQUEST_AT = 0/);
    assert.match(source, /Demand-driven; waiting for \/api\/spot-tickers/);
    assert.match(source, /steadyState/);
    assert.match(source, /BANDWIDTH_STEADY_BASELINE = captureBandwidthBaseline/);
    assert.match(source, /`&endTime=\$\{boundaryAt \+ attempt\.maxDriftMs\}`/);
    assert.doesNotMatch(source, /`&startTime=\$\{Math\.max\(0, boundaryAt - attempt\.maxDriftMs\)\}`/);
    assert.match(source, /includeHistory: false, maxFetches: 40, dryRun: true/);
    assert.match(source, /includeHistory: false, maxFetches: 40/);
    assert.doesNotMatch(source, /includeHistory: true, maxFetches: 100/);
    assert.match(source, /async function ensurePriceSeriesBackup\(\)/);
    assert.match(source, /backups\/competition-price-series\/\$\{sourceHash\}\.json/);
    assert.match(source, /await ensurePriceSeriesBackup\(\);/);
    assert.match(source, /if \(!dryRun\) PRICE_SERIES_CACHE\[id\] = existing;/);
    assert.match(source, /Number\(dryRun\.missing \|\| 0\) > 0 \|\| Number\(dryRun\.migrated \|\| 0\) > 0/);
});


test('UTC rollover preserves last-good tail baselines and empty RAM cannot be hidden by an unchanged ETag', () => {
    assert.match(source, /const tailCacheReady =/);
    assert.match(
        source,
        /nextEtag && nextEtag === TAILS_CACHE_ETAG && tailCacheReady/
    );

    const rolloverStart = source.indexOf('let lastHistoryDay = new Date().getUTCDate();');
    const rolloverEnd = source.indexOf('// ==========================================\n// 2. LOGIC TÍNH TOÁN AI PREDICTION', rolloverStart);
    assert.ok(rolloverStart >= 0 && rolloverEnd > rolloverStart);

    const rollover = source.slice(rolloverStart, rolloverEnd);
    assert.doesNotMatch(rollover, /SNAPSHOT_TAIL_TOTAL\s*=\s*\{\}/);
    assert.doesNotMatch(rollover, /SNAPSHOT_TAIL_LIMIT\s*=\s*\{\}/);
    assert.match(rollover, /Preserve the last-good per-minute 24h tail baselines across UTC rollover/);

    assert.match(source, /const tailTot = SNAPSHOT_TAIL_TOTAL\[id\]\?\.\[currentMinute\] \|\| 0/);
    assert.match(source, /let dailyTot = Math\.max\(0, rollVolTot - tailTot\)/);
});

// Canonical CI trigger for the final reviewed rollout head.
