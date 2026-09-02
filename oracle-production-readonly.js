'use strict';

require('dotenv').config();

const {
    prepareProductionReadonlyEnv,
    installS3MutationGuard,
    installSupabaseMutationGuard,
} = require('./lib/production-readonly-mode');
const {
    loadProductionReadonlyIndexWithConfigSignal,
} = require('./lib/production-readonly-config-signal-hardening');

const state = prepareProductionReadonlyEnv(process.env);
globalThis.__WAVE_PRODUCTION_READONLY_STATE = state;

// Install transport-level write blockers before index.js constructs any client.
// The runtime also receives only R2 read-only + Supabase anon credentials, so a
// missed source guard still cannot become a canonical writer.
const { S3Client } = require('@aws-sdk/client-s3');
installS3MutationGuard(S3Client, state);
installSupabaseMutationGuard(globalThis, process.env.SUPABASE_URL, state);

console.log('[PRODUCTION-READONLY] Wave Alpha Oracle candidate starting', state.snapshot());
const loaded = loadProductionReadonlyIndexWithConfigSignal(require.resolve('./index'));
console.log('[PRODUCTION-READONLY] Source hardening applied', loaded.applied);
