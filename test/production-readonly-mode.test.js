'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    prepareProductionReadonlyEnv,
    isS3MutationCommand,
    installS3MutationGuard,
    installSupabaseMutationGuard,
} = require('../lib/production-readonly-mode');

function readonlyEnv() {
    return {
        WAVE_RUNTIME_MODE: 'production-readonly',
        WAVE_CANONICAL_PUBLISH: 'off',
        ENABLE_TICK_CACHE: 'false',
        R2_READ_ONLY_ACCESS_KEY_ID: 'read-only-id',
        R2_READ_ONLY_SECRET_ACCESS_KEY: 'read-only-secret',
        R2_ENDPOINT_URL: 'https://example.r2.cloudflarestorage.com',
        R2_BUCKET_NAME: 'wave-alpha-data',
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_ANON_KEY: 'anon-key',
        PRODUCTION_READ_API_SECRET_KEY: 'read-api-key',
    };
}

test('production-readonly env requires explicit fail-closed mode flags', () => {
    const env = readonlyEnv();
    delete env.WAVE_CANONICAL_PUBLISH;
    assert.throws(() => prepareProductionReadonlyEnv(env), /WAVE_CANONICAL_PUBLISH/);
});

test('production-readonly refuses inherited legacy credentials instead of overwriting them silently', () => {
    const env = readonlyEnv();
    env.SUPABASE_SERVICE_ROLE_KEY = 'writer-capable-key';
    assert.throws(() => prepareProductionReadonlyEnv(env), /refusing inherited legacy credential env/i);
});

test('production-readonly maps only least-privilege read credentials into legacy index names', () => {
    const env = readonlyEnv();
    const state = prepareProductionReadonlyEnv(env);

    assert.equal(env.R2_ACCESS_KEY_ID, 'read-only-id');
    assert.equal(env.R2_SECRET_ACCESS_KEY, 'read-only-secret');
    assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, 'anon-key');
    assert.equal(env.API_SECRET_KEY, 'read-api-key');
    assert.deepEqual(state.snapshot(), {
        mode: 'production-readonly',
        canonicalPublish: false,
        writerCredentialsReachable: false,
        tickCacheEnabled: false,
        r2CredentialMode: 'read-only',
        supabaseCredentialMode: 'anon',
        apiCredentialMode: 'production-read-only',
        blocked: { r2: 0, supabase: 0 },
        sourceSuppressed: {},
    });
});

test('S3 guard blocks canonical mutations before network and counts them', async () => {
    class FakeS3Client {
        async send(command) { return { command: command.constructor.name }; }
    }
    class PutObjectCommand {}
    class DeleteObjectCommand {}
    class GetObjectCommand {}

    const state = prepareProductionReadonlyEnv(readonlyEnv());
    installS3MutationGuard(FakeS3Client, state);
    const client = new FakeS3Client();

    assert.equal(isS3MutationCommand(new PutObjectCommand()), true);
    assert.equal(isS3MutationCommand(new DeleteObjectCommand()), true);
    assert.equal(isS3MutationCommand(new GetObjectCommand()), false);
    await assert.rejects(client.send(new PutObjectCommand()), /Blocked R2 mutation before network/);
    assert.deepEqual(await client.send(new GetObjectCommand()), { command: 'GetObjectCommand' });
    assert.equal(state.snapshot().blocked.r2, 1);
});

test('Supabase guard allows reads, blocks mutation methods before network and counts them', async () => {
    const calls = [];
    const fakeGlobal = {
        fetch: async (input, init) => {
            calls.push({ input: String(input), method: String((init && init.method) || 'GET').toUpperCase() });
            return { ok: true };
        },
    };
    const state = prepareProductionReadonlyEnv(readonlyEnv());
    installSupabaseMutationGuard(fakeGlobal, 'https://example.supabase.co', state);

    await fakeGlobal.fetch('https://example.supabase.co/rest/v1/tournaments?select=*');
    await assert.rejects(
        fakeGlobal.fetch('https://example.supabase.co/rest/v1/tournaments?id=eq.1', { method: 'PATCH' }),
        /Blocked Supabase mutation before network: PATCH/,
    );
    await fakeGlobal.fetch('https://www.binance.com/bapi/test', { method: 'POST' });

    assert.deepEqual(calls, [
        { input: 'https://example.supabase.co/rest/v1/tournaments?select=*', method: 'GET' },
        { input: 'https://www.binance.com/bapi/test', method: 'POST' },
    ]);
    assert.equal(state.snapshot().blocked.supabase, 1);
});
