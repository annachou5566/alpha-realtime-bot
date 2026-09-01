'use strict';

require('dotenv').config();

const {
    prepareQualificationEnv,
    installS3MutationGuard,
    installSupabaseMutationGuard,
} = require('./lib/qualification-mode');

const state = prepareQualificationEnv(process.env);

// Install write blockers before index.js creates any clients. Qualification is
// allowed to read canonical state and call exchange upstreams from the candidate
// server egress, but it must never become a second R2/Supabase writer.
const { S3Client } = require('@aws-sdk/client-s3');
installS3MutationGuard(S3Client);
installSupabaseMutationGuard(globalThis, process.env.SUPABASE_URL);

console.log('[QUALIFICATION] Wave Alpha Oracle candidate starting', state);
require('./index');
