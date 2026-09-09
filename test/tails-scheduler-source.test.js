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

    assert.match(unit, /^Type=oneshot$/m);
    assert.match(unit, /^User=wavealpha-alpha$/m);
    assert.match(unit, /^Environment=TAILS_WRITER_MODE=production$/m);
    assert.match(unit, /^Environment=TAILS_PRODUCTION_WRITE=true$/m);
    assert.match(unit, /^Environment=R2_BUCKET_NAME=wave-alpha-data$/m);
    assert.match(
        unit,
        /^LoadCredential=R2_TAILS_WRITE_ACCESS_KEY_ID:/run/wave-alpha-alpha/credentials/R2_TAILS_WRITE_ACCESS_KEY_ID$/m,
    );
    assert.match(
        unit,
        /^LoadCredential=R2_TAILS_WRITE_SECRET_ACCESS_KEY:/run/wave-alpha-alpha/credentials/R2_TAILS_WRITE_SECRET_ACCESS_KEY$/m,
    );
    assert.doesNotMatch(unit, /SUPABASE_/);
    assert.doesNotMatch(unit, /PRODUCTION_READ_API_SECRET_KEY/);
    assert.match(
        unit,
        /^ExecStart=/usr/bin/bash /opt/wave-alpha/alpha-realtime/current/scripts/oracle-tails-production-launch.sh$/m,
    );
    assert.doesNotMatch(unit, /^WantedBy=/m);
});

test('tails scheduler preserves the old 00:15 UTC cadence and has one timer owner', () => {
    const timer = read('deploy/oracle/alpha-tails-production.timer');

    assert.match(timer, /^OnCalendar=*-*-* 00:15:00 UTC$/m);
    assert.match(timer, /^AccuracySec=1s$/m);
    assert.match(timer, /^RandomizedDelaySec=0$/m);
    assert.match(timer, /^Persistent=true$/m);
    assert.match(timer, /^Unit=alpha-tails-production.service$/m);
    assert.match(timer, /^WantedBy=timers.target$/m);
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
