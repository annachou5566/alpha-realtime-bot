'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    prepareQualificationEnv,
    isS3MutationCommand,
    installS3MutationGuard,
    installSupabaseMutationGuard,
} = require('../lib/qualification-mode');

function qualificationEnv() {
    return {
        R2_READ_ONLY_ACCESS_KEY_ID: 'read-only-id',
        R2_READ_ONLY_SECRET_ACCESS_KEY: 'read-only-secret',
        R2_ENDPOINT_URL: 'https://example.r2.cloudflarestorage.com',
        R2_BUCKET_NAME: 'wave-alpha-data',
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_ANON_KEY: 'anon-key',
        QUALIFICATION_API_SECRET_KEY: 'qualification-key',
        R2_ACCESS_KEY_ID: 'production-id-must-be-overwritten',
        R2_SECRET_ACCESS_KEY: 'production-secret-must-be-overwritten',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-must-be-overwritten',
        API_SECRET_KEY: 'production-api-key-must-be-overwritten',
        ENABLE_TICK_CACHE: 'true',
    };
}

test('qualification env fails closed when read-only credentials are missing', () => {
    const env = qualificationEnv();
    delete env.R2_READ_ONLY_SECRET_ACCESS_KEY;
    assert.throws(() => prepareQualificationEnv(env), /R2_READ_ONLY_SECRET_ACCESS_KEY/);
});

test('qualification env overwrites writer credentials and disables publishing features', () => {
    const env = qualificationEnv();
    const state = prepareQualificationEnv(env);

    assert.equal(env.R2_ACCESS_KEY_ID, 'read-only-id');
    assert.equal(env.R2_SECRET_ACCESS_KEY, 'read-only-secret');
    assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, 'anon-key');
    assert.equal(env.API_SECRET_KEY, 'qualification-key');
    assert.equal(env.ENABLE_TICK_CACHE, 'false');
    assert.equal(env.WAVE_RUNTIME_MODE, 'qualification');
    assert.equal(env.WAVE_CANONICAL_PUBLISH, 'off');
    assert.equal(state.canonicalPublish, false);
});

test('S3 mutation classifier blocks canonical object mutations but allows reads', () => {
    class PutObjectCommand {}
    class DeleteObjectCommand {}
    class GetObjectCommand {}
    assert.equal(isS3MutationCommand(new PutObjectCommand()), true);
    assert.equal(isS3MutationCommand(new DeleteObjectCommand()), true);
    assert.equal(isS3MutationCommand(new GetObjectCommand()), false);
});

test('S3 guard rejects writes before client send reaches the network', async () => {
    class FakeS3Client {
        async send(command) { return { command: command.constructor.name }; }
    }
    installS3MutationGuard(FakeS3Client);

    class PutObjectCommand {}
    class GetObjectCommand {}
    const client = new FakeS3Client();

    await assert.rejects(client.send(new PutObjectCommand()), /Blocked R2 mutation/);
    assert.deepEqual(await client.send(new GetObjectCommand()), { command: 'GetObjectCommand' });
});

test('Supabase guard allows reads and blocks mutations only for the Supabase origin', async () => {
    const calls = [];
    const fakeGlobal = {
        fetch: async (input, init) => {
            calls.push({ input: String(input), method: String((init && init.method) || 'GET').toUpperCase() });
            return { ok: true };
        },
    };

    installSupabaseMutationGuard(fakeGlobal, 'https://example.supabase.co');

    await fakeGlobal.fetch('https://example.supabase.co/rest/v1/tournaments?select=*');
    await assert.rejects(
        fakeGlobal.fetch('https://example.supabase.co/rest/v1/tournaments?id=eq.1', { method: 'PATCH' }),
        /Blocked Supabase mutation: PATCH/,
    );
    await fakeGlobal.fetch('https://www.binance.com/bapi/test', { method: 'POST' });

    assert.deepEqual(calls, [
        { input: 'https://example.supabase.co/rest/v1/tournaments?select=*', method: 'GET' },
        { input: 'https://www.binance.com/bapi/test', method: 'POST' },
    ]);
});
