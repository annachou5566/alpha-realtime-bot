'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const entry = fs.readFileSync('oracle-competition-analytics-once.js', 'utf8');
const producer = fs.readFileSync('lib/competition-analytics-phase1.js', 'utf8');
const launch = fs.readFileSync('scripts/oracle-competition-analytics-launch.sh', 'utf8');
const service = fs.readFileSync('deploy/oracle/competition-analytics-production.service', 'utf8');
const timer = fs.readFileSync('deploy/oracle/competition-analytics-production.timer', 'utf8');

test('standalone entrypoint reuses the canonical bounded producer', () => {
    assert.match(entry, /runCompetitionAnalyticsPhase1/);
    assert.match(entry, /competition-data\?scope=history/);
    assert.match(entry, /WRITE_TARGET=competition-analytics\/phase1\.json/);
    assert.match(producer, /STATE_KEY = 'competition-analytics\/phase1\.json'/);
    assert.match(producer, /MAX_TOURNAMENTS_PER_RUN = 6/);
    assert.match(producer, /\.slice\(0, MAX_TOURNAMENTS_PER_RUN\)/);
});

test('standalone path injects ended public config rows and needs no Supabase credential', () => {
    assert.match(entry, /function endedRows/);
    assert.match(entry, /parseEndAt/);
    assert.match(entry, /rewardMeta/);
    assert.match(producer, /Array\.isArray\(options\.rows\)/);
    assert.doesNotMatch(entry, /SUPABASE_|createClient/);
});

test('launcher maps only dedicated aliases of the existing encrypted R2 writer credential', () => {
    assert.match(launch, /R2_ANALYTICS_WRITE_ACCESS_KEY_ID/);
    assert.match(launch, /R2_ANALYTICS_WRITE_SECRET_ACCESS_KEY/);
    assert.match(launch, /refusing inherited credential env/);
    assert.doesNotMatch(launch, /SUPABASE_ANON_KEY/);
    assert.doesNotMatch(launch, /SUPABASE_SERVICE_ROLE_KEY=.*cat/);
});

test('service reuses existing bucket writer ciphertext and remains isolated from reader', () => {
    assert.match(service, /wave-alpha-tails-r2-access-key-id\.cred/);
    assert.match(service, /wave-alpha-tails-r2-secret-access-key\.cred/);
    assert.match(service, /Type=oneshot/);
    assert.match(service, /MemoryMax=192M/);
    assert.match(service, /CPUQuota=25%/);
    assert.match(service, /TimeoutStartSec=10min/);
    assert.doesNotMatch(service, /alpha-realtime-production-readonly\.service/);
});

test('timer is the only intended recurring owner and does not catch up after downtime', () => {
    assert.match(timer, /OnCalendar=\*-\*-\* \*:00\/15:00 UTC/);
    assert.match(timer, /Persistent=false/);
    assert.match(timer, /Unit=competition-analytics-production\.service/);
    assert.doesNotMatch(timer, /Requires=|Wants=/);
});
