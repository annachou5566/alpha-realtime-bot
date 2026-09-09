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
        'LoadCredentialEncrypted=R2_TAILS_WRITE_ACCESS_KEY_ID:/etc/credstore.encrypted/wave-alpha-tails-r2-access-key-id.cred',
        'LoadCredentialEncrypted=R2_TAILS_WRITE_SECRET_ACCESS_KEY:/etc/credstore.encrypted/wave-alpha-tails-r2-secret-access-key.cred',
        'ExecStart=/usr/bin/bash /opt/wave-alpha/alpha-tails-writer/current/scripts/oracle-tails-production-launch.sh',
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



test('writer release root is isolated from the production-readonly consumer release', () => {
    const unit = read('deploy/oracle/alpha-tails-production.service');
    const launcher = read('scripts/oracle-tails-production-launch.sh');

    assert.match(unit, /WorkingDirectory=\/opt\/wave-alpha\/alpha-tails-writer\/current/);
    assert.match(unit, /WAVE_ALPHA_APP_DIR=\/opt\/wave-alpha\/alpha-tails-writer\/current/);
    assert.match(unit, /ExecStart=\/usr\/bin\/bash \/opt\/wave-alpha\/alpha-tails-writer\/current\/scripts\/oracle-tails-production-launch\.sh/);
    assert.match(launcher, /\/opt\/wave-alpha\/alpha-tails-writer\/current/);

    assert.doesNotMatch(unit, /alpha-realtime\/current/);
    assert.doesNotMatch(launcher, /alpha-realtime\/current/);
});


test('timer has no eager service dependency and encrypted writer credentials survive reboot', () => {
    const service = read('deploy/oracle/alpha-tails-production.service');
    const timer = read('deploy/oracle/alpha-tails-production.timer');

    assert.doesNotMatch(timer, /^Requires=alpha-tails-production\.service$/m);
    assert.doesNotMatch(timer, /^Wants=alpha-tails-production\.service$/m);
    assert.match(timer, /^Unit=alpha-tails-production\.service$/m);

    assert.match(
        service,
        /^LoadCredentialEncrypted=R2_TAILS_WRITE_ACCESS_KEY_ID:\/etc\/credstore\.encrypted\/wave-alpha-tails-r2-access-key-id\.cred$/m,
    );
    assert.match(
        service,
        /^LoadCredentialEncrypted=R2_TAILS_WRITE_SECRET_ACCESS_KEY:\/etc\/credstore\.encrypted\/wave-alpha-tails-r2-secret-access-key\.cred$/m,
    );
    assert.doesNotMatch(service, /\/run\/wave-alpha-alpha\/credentials\/R2_TAILS_WRITE_/);
});
