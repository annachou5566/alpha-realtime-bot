#!/usr/bin/env node
'use strict';

const axios = require('axios');
const { S3Client } = require('@aws-sdk/client-s3');
const {
    parseEndAt,
    rewardMeta,
    runCompetitionAnalyticsPhase1,
} = require('./lib/competition-analytics-phase1');

const EXPECTED_R2_ENDPOINT =
    'https://0f534c1b6f9bc097235b37c07d1dc32e.r2.cloudflarestorage.com';
const EXPECTED_R2_BUCKET = 'wave-alpha-data';
const CONFIG_URL = 'https://wave-alpha.pages.dev/api/competition-data?scope=history';

function requireValue(name) {
    const value = String(process.env[name] || '').trim();
    if (!value) throw new Error(`missing-required-env:${name}`);
    return value;
}

function requireExact(name, expected) {
    const value = String(process.env[name] || '').trim();
    if (value !== expected) throw new Error(`${name}-mismatch`);
    return value;
}

function endedRows(payload, now = Date.now()) {
    const out = new Map();
    for (const [key, config] of Object.entries(payload || {})) {
        if (!config || typeof config !== 'object') continue;
        const id = String(config.db_id ?? config.id ?? '').trim();
        const alphaId = String(config.alphaId || '').trim();
        const endAt = parseEndAt(config);
        const reward = rewardMeta(config, config.name || key);
        if (!id || id === '-1' || !alphaId || !Number.isFinite(endAt) || endAt >= now) continue;
        if (!reward.unit || reward.unit === 'USD' || !(reward.quantity > 0)) continue;
        out.set(id, {
            id,
            name: String(config.name || key),
            data: config,
        });
    }
    return [...out.values()];
}

async function main() {
    requireExact('COMP_ANALYTICS_WRITER_MODE', 'production');
    requireExact('COMP_ANALYTICS_WRITE', 'true');
    requireExact('R2_ENDPOINT_URL', EXPECTED_R2_ENDPOINT);
    requireExact('R2_BUCKET_NAME', EXPECTED_R2_BUCKET);

    const accessKeyId = requireValue('R2_ACCESS_KEY_ID');
    const secretAccessKey = requireValue('R2_SECRET_ACCESS_KEY');

    const response = await axios.get(CONFIG_URL, {
        timeout: 15_000,
        headers: { 'User-Agent': 'wave-alpha-competition-analytics/1' },
    });
    const rows = endedRows(response.data, Date.now());
    if (!rows.length) throw new Error('competition-history-config-empty');

    const r2 = new S3Client({
        region: 'auto',
        endpoint: EXPECTED_R2_ENDPOINT,
        credentials: { accessKeyId, secretAccessKey },
    });

    console.log('=== COMPETITION_ANALYTICS_ONCE_BEGIN ===');
    console.log('CONFIG_SOURCE=canonical-competition-data-history');
    console.log(`ELIGIBLE_CONFIG_ROWS=${rows.length}`);
    console.log('WRITE_TARGET=competition-analytics/phase1.json');

    const result = await runCompetitionAnalyticsPhase1({
        clients: { r2, bucket: EXPECTED_R2_BUCKET },
        rows,
    });

    console.log(`PROCESSED=${Number(result.processed || 0)}`);
    console.log(`TOTAL_ELIGIBLE=${Number(result.totalEligible || 0)}`);
    console.log(`STORED=${Number(result.stored || 0)}`);
    console.log(`READY=${Number(result.ready || 0)}`);
    console.log(`PAYLOAD_BYTES=${Number(result.bytes || 0)}`);
    console.log(`RESULTS=${JSON.stringify(result.results || [])}`);
    console.log('COMPETITION_ANALYTICS_ONCE=PASS');
    console.log('=== COMPETITION_ANALYTICS_ONCE_END ===');
}

if (require.main === module) {
    main().catch(error => {
        console.error(`COMPETITION_ANALYTICS_ONCE_ERROR=${String(error && error.message || error)}`);
        console.error('COMPETITION_ANALYTICS_ONCE=FAIL');
        process.exitCode = 1;
    });
}

module.exports = { endedRows };
