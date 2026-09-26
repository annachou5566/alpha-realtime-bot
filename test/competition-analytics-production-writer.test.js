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
    assert.match(producer, /STATE_KEY = 'competition-analytics\/phase1\.json'/);
    assert.match(producer, /MAX_TOURNAMENTS_PER_RUN = 6/);
    assert.match(producer, /\.slice\(0, MAX_TOURNAMENTS_PER_RUN\)/);
});

test('producer supports readonly Supabase auth for the standalone writer', () => {
    assert.match(producer, /env\.SUPABASE_ANON_KEY \|\| env\.SUPABASE_SERVICE_ROLE_KEY/);
    assert.match(producer, /SUPABASE_ANON_KEY\|SUPABASE_SERVICE_ROLE_KEY/);
});

test('launcher maps only dedicated credential files and rejects inherited broad env', () => {
    assert.match(launch, /R2_ANALYTICS_WRITE_ACCESS_KEY_ID/);
    assert.match(launch, /R2_ANALYTICS_WRITE_SECRET_ACCESS_KEY/);
    assert.match(launch, /SUPABASE_ANALYTICS_READ_ANON_KEY/);
    assert.match(launch, /refusing inherited credential env/);
    assert.match(launch, /SUPABASE_SERVICE_ROLE_KEY/);
});

test('service is a bounded isolated oneshot and never restarts the readonly reader', () => {
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
