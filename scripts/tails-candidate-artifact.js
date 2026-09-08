#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const axios = require('axios');
const { runTailsProducer } = require('../lib/tails-producer');
const { validateTailsPayload } = require('../lib/tails-cache-contract');

function envInt(name, fallback, min, max) {
    const parsed = Number.parseInt(process.env[name] || '', 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function requireExact(name, expected) {
    const value = String(process.env[name] || '');
    if (value !== expected) {
        throw new Error(`${name} must be exactly ${expected}`);
    }
}

async function main() {
    requireExact('TAILS_CANDIDATE_ARTIFACT_ONLY', 'true');

    const output = String(
        process.env.TAILS_CANDIDATE_OUTPUT
        || '/tmp/wa-tails-v2-candidate.json'
    );

    if (!output.startsWith('/tmp/wa-tails-v2-') || !output.endsWith('.json')) {
        throw new Error('candidate-output-must-be-bounded-tmp-json');
    }
    if (fs.existsSync(output) || fs.existsSync(`${output}.sha256`)) {
        throw new Error('candidate-output-already-exists');
    }

    const concurrency = envInt('TAILS_CANDIDATE_CONCURRENCY', 2, 1, 4);
    const maxRequests = envInt('TAILS_CANDIDATE_MAX_REQUESTS', 2000, 100, 2000);

    console.log('=== TAILS_CANDIDATE_ARTIFACT_BEGIN ===');
    console.log('MODE=QUALIFICATION_ONLY_LOCAL_ARTIFACT');
    console.log('R2_MUTATION_ALLOWED=NO');
    console.log('FULL_COHORT=YES');
    console.log(`CONCURRENCY=${concurrency}`);
    console.log(`REQUEST_BUDGET=${maxRequests}`);

    const result = await runTailsProducer({
        http: axios,
        qualificationOnly: true,
        includePayload: true,
        maxTokens: 0,
        concurrency,
        maxRequests,
        logger: console,
    });

    const payload = result.payload;
    const validation = validateTailsPayload(payload, Date.now());
    if (!validation.ok) {
        throw new Error(`candidate-payload-contract:${validation.reason}`);
    }

    const body = Buffer.from(JSON.stringify(payload));
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');

    fs.writeFileSync(output, body, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(
        `${output}.sha256`,
        `${sha256}  ${output.split('/').pop()}\n`,
        { flag: 'wx', mode: 0o600 },
    );

    console.log(`CANDIDATE_BOUNDARY=${payload.boundary_date}`);
    console.log(`CANDIDATE_TOTAL_COUNT=${payload.expected_token_count}`);
    console.log(`CANDIDATE_LIMIT_SUPPORTED=${payload.expected_limit_token_count}`);
    console.log(`CANDIDATE_LIMIT_UNSUPPORTED=${payload.unsupported_limit_token_count}`);
    console.log(`CANDIDATE_BYTES=${body.length}`);
    console.log(`CANDIDATE_SHA256=${sha256}`);
    console.log(`CANDIDATE_OUTPUT=${output}`);
    console.log('CANDIDATE_CONTRACT=PASS');
    console.log('R2_WRITE_PERFORMED=NO');
    console.log('=== TAILS_CANDIDATE_ARTIFACT_END ===');
}

main().catch(error => {
    console.error(`TAILS_CANDIDATE_ARTIFACT_ERROR=${String(error && error.message || error)}`);
    console.error('TAILS_CANDIDATE_ARTIFACT=FAIL');
    process.exitCode = 1;
});
