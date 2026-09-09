'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function read(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('tails writer service is isolated oneshot with dedicated credentials only', () => {
    const unit = read('deploy/oracle/alpha-tails-production.service');

    for (const line of [
        'Type=oneshot',
        'User=wavealpha-alpha',
        'Environment=TAILS_WRITER_MODE=production',
        'Environment=TAILS_PRODUCTION_WRITE=true',
        'Environment=R2_BUCKET_NAME=wave-alpha-data',
        'LoadCredential=R2_TAILS_WRITE_ACCESS_KEY_ID:/run/wave-alpha-alpha/credentials/R2_TAILS_WRITE_ACCESS_KEY_ID',
        'LoadCredential=R2_TAILS_WRITE_SECRET_ACCESS_KEY:/run/wave-alpha-alpha/credentials/R2_TAILS_WRITE_SECRET_ACCESS_KEY',
        'ExecStart=/usr/bin/bash /opt/wave-alpha/alpha-realtime/current/scripts/oracle-tails-production-launch.sh',
    ]) {
        assert.ok(unit.split('\n').includes(line), `missing exact unit line: ${line}`);
    }

    assert.doesNotMatch(unit, /SUPABASE_/);
    assert.doesNotMatch(unit, /PRODUCTION_READ_API_SECRET_KEY/);
    assert.equal(
        unit.split('\n').filter(line => line.startsWith('WantedBy=')).length,
        0,
    );
});

test('tails scheduler preserves the old 00:15 UTC cadence and has one timer owner', () => {
    const timer = read('deploy/oracle/alpha-tails-production.timer');

    for (const line of [
        'OnCalendar=*-*-* 00:15:00 UTC',
        'AccuracySec=1s',
        'RandomizedDelaySec=0',
        'Persistent=true',
        'Unit=alpha-tails-production.service',
        'WantedBy=timers.target',
    ]) {
        assert.ok(timer.split('\n').includes(line), `missing exact timer line: ${line}`);
    }

    assert.equal(
        timer.split('\n').filter(line => line.startsWith('OnCalendar=')).length,
        1,
    );
    assert.equal(
        timer.split('\n').filter(line => line.startsWith('Unit=alpha-tails-production.service')).length,
        1,
    );
});

test('tails launcher refuses inherited credentials before mapping dedicated writer credentials', () => {
    const launcher = read('scripts/oracle-tails-production-launch.sh');

    for (const name of [
        'R2_ACCESS_KEY_ID',
        'R2_SECRET_ACCESS_KEY',
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
        'SUPABASE_SERVICE_ROLE_KEY',
        'API_SECRET_KEY',
    ]) {
        assert.match(launcher, new RegExp(name));
    }

    assert.match(launcher, /R2_TAILS_WRITE_ACCESS_KEY_ID/);
    assert.match(launcher, /R2_TAILS_WRITE_SECRET_ACCESS_KEY/);
    assert.match(launcher, /TAILS_PRODUCTION_WRITE must be true/);
    assert.match(launcher, /R2_BUCKET_NAME mismatch/);
    assert.doesNotMatch(launcher, /set -x/);
});


test('shadow-to-live promotion source pins exact canonical metadata contract', () => {
    const source = read('scripts/promote-tails-shadow-to-live.js');

    for (const fragment of [
        "const SHADOW_KEY = 'tails_cache.v2.candidate.json';",
        "const LIVE_KEY = 'tails_cache.json';",
        "'wa-schema': '2'",
        "'boundary-date': contract.boundary",
        "complete: 'true'",
        "'payload-sha256': bodySha",
        "validateTailsPayload(payload, Date.now())",
        "validateTailsHeadForSource(postHead",
        "ALPHA_TAILS_LIVE_PROMOTION=PASS",
    ]) {
        assert.ok(source.includes(fragment), `missing promotion contract fragment: ${fragment}`);
    }

    assert.doesNotMatch(source, /DeleteObjectCommand/);
    assert.doesNotMatch(source, /CopyObjectCommand/);
    assert.doesNotMatch(source, /tails_cache\.v2\.candidate\.json['"]\s*,\s*Body/);
});
