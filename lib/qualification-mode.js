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

function requireValue(env, name) {
    const value = String(env[name] || '').trim();
    if (!value) throw new Error(`[QUALIFICATION] Missing required environment variable: ${name}`);
    return value;
}

function prepareQualificationEnv(env) {
    if (!env || typeof env !== 'object') throw new Error('[QUALIFICATION] env object is required');

    const readOnlyAccessKey = requireValue(env, 'R2_READ_ONLY_ACCESS_KEY_ID');
    const readOnlySecretKey = requireValue(env, 'R2_READ_ONLY_SECRET_ACCESS_KEY');
    const supabaseAnonKey = requireValue(env, 'SUPABASE_ANON_KEY');
    const qualificationApiKey = requireValue(env, 'QUALIFICATION_API_SECRET_KEY');

    requireValue(env, 'R2_ENDPOINT_URL');
    requireValue(env, 'R2_BUCKET_NAME');
    requireValue(env, 'SUPABASE_URL');

    // Legacy index.js expects these variable names. In qualification mode we
    // deliberately overwrite them with least-privilege credentials so a copied
    // Production environment cannot silently become a second canonical writer.
    env.R2_ACCESS_KEY_ID = readOnlyAccessKey;
    env.R2_SECRET_ACCESS_KEY = readOnlySecretKey;
    env.SUPABASE_SERVICE_ROLE_KEY = supabaseAnonKey;
    env.API_SECRET_KEY = qualificationApiKey;

    env.WAVE_RUNTIME_MODE = 'qualification';
    env.WAVE_CANONICAL_PUBLISH = 'off';
    env.ENABLE_TICK_CACHE = 'false';

    return {
        mode: env.WAVE_RUNTIME_MODE,
        canonicalPublish: false,
        tickCacheEnabled: false,
        r2CredentialMode: 'read-only',
        supabaseCredentialMode: 'anon',
        apiCredentialMode: 'qualification-only',
    };
}

function isS3MutationCommand(command) {
    const name = command && command.constructor && command.constructor.name;
    return S3_MUTATION_COMMANDS.has(String(name || ''));
}

function installS3MutationGuard(S3Client) {
    if (!S3Client || !S3Client.prototype || typeof S3Client.prototype.send !== 'function') {
        throw new Error('[QUALIFICATION] Cannot install S3 mutation guard');
    }

    const current = S3Client.prototype.send;
    if (current.__waveQualificationGuard === true) return;

    async function guardedSend(command, ...args) {
        if (isS3MutationCommand(command)) {
            const name = command && command.constructor && command.constructor.name;
            throw new Error(`[QUALIFICATION] Blocked R2 mutation: ${name}`);
        }
        return current.call(this, command, ...args);
    }
    guardedSend.__waveQualificationGuard = true;
    guardedSend.__waveQualificationOriginal = current;
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

function installSupabaseMutationGuard(globalObject, supabaseUrl) {
    if (!globalObject || typeof globalObject.fetch !== 'function') {
        throw new Error('[QUALIFICATION] Global fetch is required for Supabase mutation guard');
    }

    const targetOrigin = new URL(requireValue({ SUPABASE_URL: supabaseUrl }, 'SUPABASE_URL')).origin;
    const current = globalObject.fetch;
    if (current.__waveQualificationGuard === true) return;

    async function guardedFetch(input, init) {
        const rawUrl = requestUrl(input);
        const method = requestMethod(input, init);
        let origin = '';
        try { origin = rawUrl ? new URL(rawUrl).origin : ''; } catch (_) { origin = ''; }

        if (origin === targetOrigin && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
            throw new Error(`[QUALIFICATION] Blocked Supabase mutation: ${method}`);
        }
        return current.call(this, input, init);
    }
    guardedFetch.__waveQualificationGuard = true;
    guardedFetch.__waveQualificationOriginal = current;
    globalObject.fetch = guardedFetch;
}

module.exports = {
    S3_MUTATION_COMMANDS,
    prepareQualificationEnv,
    isS3MutationCommand,
    installS3MutationGuard,
    installSupabaseMutationGuard,
};
