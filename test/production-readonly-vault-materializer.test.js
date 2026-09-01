'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const materializer = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'oracle-production-readonly-materialize-vault.sh'),
    'utf8',
);
const cleanup = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'oracle-production-readonly-cleanup-credentials.sh'),
    'utf8',
);

test('Phase 4B materializer uses instance principal CURRENT bundles and tmpfs-only runtime files', () => {
    assert.match(materializer, /--auth instance_principal/);
    assert.match(materializer, /--stage CURRENT/);
    assert.match(materializer, /\/dev\/shm\/wa-p4b-/);
    assert.match(materializer, /\/run\/wave-alpha-alpha/);
    assert.match(materializer, /TARGET_COLLISION=YES/);
    assert.match(materializer, /NEW_DIR_COLLISION=YES/);
    assert.match(materializer, /PORT_3100_BEFORE/);
    assert.match(materializer, /SERVICE_STATE_GATE=FAIL_ACTIVE/);
    assert.match(materializer, /WRITER_CREDENTIAL_MATERIALIZED=NO/);
    assert.match(materializer, /SECRET_VALUES_PRINTED=NO/);
});

test('Phase 4B materializer requires exactly the four non-writer credential secret identities', () => {
    for (const name of [
        'R2_READ_ONLY_ACCESS_KEY_ID',
        'R2_READ_ONLY_SECRET_ACCESS_KEY',
        'SUPABASE_ANON_KEY',
        'PRODUCTION_READ_API_SECRET_KEY',
    ]) {
        assert.match(materializer, new RegExp(name));
    }
    assert.doesNotMatch(materializer, /SUPABASE_SERVICE_ROLE_KEY_SECRET_OCID/);
    assert.doesNotMatch(materializer, /R2_WRITE_/);
});

test('credential cleanup refuses to remove runtime credentials while either Alpha service is active', () => {
    assert.match(cleanup, /alpha-realtime-production-readonly\.service/);
    assert.match(cleanup, /alpha-realtime-qualification\.service/);
    assert.match(cleanup, /SERVICE_STATE_GATE=FAIL_ACTIVE/);
    assert.match(cleanup, /PORT_3100_BEFORE/);
    assert.match(cleanup, /TARGET_AFTER=ABSENT/);
    assert.match(cleanup, /SECRET_VALUES_PRINTED=NO/);
});
