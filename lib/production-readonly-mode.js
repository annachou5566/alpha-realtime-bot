'use strict';

const S3_MUTATION_COMMANDS = new Set([
    'PutObjectCommand',
    'DeleteObjectCommand',
    'DeleteObjectsCommand',
    'CopyObjectCommand',
    'CreateMultipartUploadCommand',
    'UploadPartCommand',
    'CompleteMultipartUploadCommand',
    'AbortMultipartUploadCommand',
]);

const FORBIDDEN_INHERITED_ENV = [
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'API_SECRET_KEY',
];

function requireValue(env, name) {
    const value = String(env[name] || '').trim();
    if (!value) throw new Error(`[PRODUCTION-READONLY] Missing required environment variable: ${name}`);
    return value;
}

function requireExact(env, name, expected) {
    const value = String(env[name] || '').trim().toLowerCase();
    if (value !== expected) {
        throw new Error(`[PRODUCTION-READONLY] ${name} must be exactly ${expected}`);
    }
    return value;
}

function assertNoInheritedWriterCredentials(env) {
    const present = FORBIDDEN_INHERITED_ENV.filter(name => String(env[name] || '').trim());
    if (present.length > 0) {
        throw new Error(`[PRODUCTION-READONLY] Refusing inherited legacy credential env: ${present.join(', ')}`);
    }
}

function prepareProductionReadonlyEnv(env) {
    if (!env || typeof env !== 'object') {
        throw new Error('[PRODUCTION-READONLY] env object is required');
    }

    requireExact(env, 'WAVE_RUNTIME_MODE', 'production-readonly');
    requireExact(env, 'WAVE_CANONICAL_PUBLISH', 'off');
    requireExact(env, 'ENABLE_TICK_CACHE', 'false');
    assertNoInheritedWriterCredentials(env);

    const readOnlyAccessKey = requireValue(env, 'R2_READ_ONLY_ACCESS_KEY_ID');
    const readOnlySecretKey = requireValue(env, 'R2_READ_ONLY_SECRET_ACCESS_KEY');
    const supabaseAnonKey = requireValue(env, 'SUPABASE_ANON_KEY');
    const productionReadApiKey = requireValue(env, 'PRODUCTION_READ_API_SECRET_KEY');

    requireValue(env, 'R2_ENDPOINT_URL');
    requireValue(env, 'R2_BUCKET_NAME');
    requireValue(env, 'SUPABASE_URL');

    // index.js still consumes the legacy variable names. Map only least-privilege
    // read credentials after proving no inherited writer credential was reachable.
    env.R2_ACCESS_KEY_ID = readOnlyAccessKey;
    env.R2_SECRET_ACCESS_KEY = readOnlySecretKey;
    env.SUPABASE_SERVICE_ROLE_KEY = supabaseAnonKey;
    env.API_SECRET_KEY = productionReadApiKey;

    const counters = {
        r2Blocked: 0,
        supabaseBlocked: 0,
        sourceSuppressed: Object.create(null),
    };

    const state = {
        mode: 'production-readonly',
        canonicalPublish: false,
        writerCredentialsReachable: false,
        tickCacheEnabled: false,
        r2CredentialMode: 'read-only',
        supabaseCredentialMode: 'anon',
        apiCredentialMode: 'production-read-only',
        noteSuppressed(label) {
            const key = String(label || 'unknown');
            counters.sourceSuppressed[key] = (counters.sourceSuppressed[key] || 0) + 1;
        },
        noteR2Blocked() {
            counters.r2Blocked += 1;
        },
        noteSupabaseBlocked() {
            counters.supabaseBlocked += 1;
        },
        snapshot() {
            return {
                mode: this.mode,
                canonicalPublish: false,
                writerCredentialsReachable: false,
                tickCacheEnabled: false,
                r2CredentialMode: this.r2CredentialMode,
                supabaseCredentialMode: this.supabaseCredentialMode,
                apiCredentialMode: this.apiCredentialMode,
                blocked: {
                    r2: counters.r2Blocked,
                    supabase: counters.supabaseBlocked,
                },
                sourceSuppressed: { ...counters.sourceSuppressed },
            };
        },
    };

    return state;
}

function isS3MutationCommand(command) {
    const name = command && command.constructor && command.constructor.name;
    return S3_MUTATION_COMMANDS.has(String(name || ''));
}

function installS3MutationGuard(S3Client, state) {
    if (!S3Client || !S3Client.prototype || typeof S3Client.prototype.send !== 'function') {
        throw new Error('[PRODUCTION-READONLY] Cannot install S3 mutation guard');
    }
    if (!state || typeof state.noteR2Blocked !== 'function') {
        throw new Error('[PRODUCTION-READONLY] state is required for S3 mutation guard');
    }

    const current = S3Client.prototype.send;
    if (current.__waveProductionReadonlyGuard === true) return;

    async function guardedSend(command, ...args) {
        if (isS3MutationCommand(command)) {
            const name = command && command.constructor && command.constructor.name;
            state.noteR2Blocked();
            throw new Error(`[PRODUCTION-READONLY] Blocked R2 mutation before network: ${name}`);
        }
        return current.call(this, command, ...args);
    }

    guardedSend.__waveProductionReadonlyGuard = true;
    guardedSend.__waveProductionReadonlyOriginal = current;
    S3Client.prototype.send = guardedSend;
}

function requestMethod(input, init) {
    const method = (init && init.method) || (input && typeof input === 'object' && input.method) || 'GET';
    return String(method).toUpperCase();
}

function requestUrl(input) {
    if (typeof input === 'string' || input instanceof URL) return String(input);
    if (input && typeof input.url === 'string') return input.url;
    return '';
}

function installSupabaseMutationGuard(globalObject, supabaseUrl, state) {
    if (!globalObject || typeof globalObject.fetch !== 'function') {
        throw new Error('[PRODUCTION-READONLY] Global fetch is required for Supabase mutation guard');
    }
    if (!state || typeof state.noteSupabaseBlocked !== 'function') {
        throw new Error('[PRODUCTION-READONLY] state is required for Supabase mutation guard');
    }

    const targetOrigin = new URL(requireValue({ SUPABASE_URL: supabaseUrl }, 'SUPABASE_URL')).origin;
    const current = globalObject.fetch;
    if (current.__waveProductionReadonlyGuard === true) return;

    async function guardedFetch(input, init) {
        const rawUrl = requestUrl(input);
        const method = requestMethod(input, init);
        let origin = '';
        try { origin = rawUrl ? new URL(rawUrl).origin : ''; } catch (_) { origin = ''; }

        if (origin === targetOrigin && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
            state.noteSupabaseBlocked();
            throw new Error(`[PRODUCTION-READONLY] Blocked Supabase mutation before network: ${method}`);
        }
        return current.call(this, input, init);
    }

    guardedFetch.__waveProductionReadonlyGuard = true;
    guardedFetch.__waveProductionReadonlyOriginal = current;
    globalObject.fetch = guardedFetch;
}

module.exports = {
    S3_MUTATION_COMMANDS,
    FORBIDDEN_INHERITED_ENV,
    prepareProductionReadonlyEnv,
    isS3MutationCommand,
    installS3MutationGuard,
    installSupabaseMutationGuard,
};
