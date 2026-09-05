'use strict';

const path = require('path');

const API_BASE = 'http://127.0.0.1:3100';
const TARGETS = Object.freeze({
    '181': { budget: 13, initialExact: 2, initialStored: 3 },
    '182': { budget: 13, initialExact: 2, initialStored: 3 },
    '183': { budget: 14, initialExact: 1, initialStored: 1 },
    '184': { budget: 8, initialExact: 0, initialStored: 0 },
    '185': { budget: 6, initialExact: 0, initialStored: 0 },
    '186': { budget: 6, initialExact: 0, initialStored: 0 },
    '187': { budget: 4, initialExact: 0, initialStored: 0 },
    '188': { budget: 2, initialExact: 0, initialStored: 0 },
});
const TARGET_IDS = Object.keys(TARGETS);
const TARGET_SET = new Set(TARGET_IDS);
const PASSES = Object.freeze([
    ['181','182','183','184','185','186','187','188'],
    ['181','182','183','184','185','186','187','188'],
    ['181','182','183','184','185','186','187'],
    ['181','182','183','184','185','186','187'],
    ['181','182','183','184','185','186'],
    ['181','182','183','184','185','186'],
    ['181','182','183','184'],
    ['181','182','183','184'],
    ['181','182','183'],
    ['181','182','183'],
    ['181','182','183'],
    ['181','182','183'],
    ['181','182','183'],
    ['183'],
]);

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function requestJson(pathname, options = {}, timeoutMs = 180000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(API_BASE + pathname, {
            ...options,
            headers: {
                'x-api-key': process.env.WAVE_API_KEY,
                ...(options.headers || {}),
            },
            signal: controller.signal,
        });
        const text = await response.text();
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        if (!response.ok) {
            const detail = json && json.error ? json.error : text.slice(0, 160);
            throw new Error(`HTTP ${response.status}: ${detail || 'request failed'}`);
        }
        if (!json || typeof json !== 'object') throw new Error('non-JSON response');
        return json;
    } finally {
        clearTimeout(timer);
    }
}

function isExact(point) {
    if (!point || point.quality !== 'exact') return false;
    const boundaryAt = Number(point.boundaryAt);
    return Number(point.driftMs) === 0
        && Number(point.observedAt) === boundaryAt
        && Number.isFinite(boundaryAt)
        && Number(point.price) > 0;
}

function pointCounts(series) {
    const points = series && Array.isArray(series.points) ? series.points : [];
    return {
        stored: points.length,
        exact: points.filter(isExact).length,
    };
}

async function preflight() {
    if (!process.env.WAVE_API_KEY) throw new Error('WAVE_API_KEY missing');

    const releaseRoot = process.env.WAVE_RELEASE_ROOT || '/opt/wave-alpha/alpha-realtime/current';
    const { exactSnapshot } = require(path.join(releaseRoot, 'lib/competition-price-series-publisher.js'));

    const payload = await requestJson('/api/competition-price-series', {}, 30000);
    if (Number(payload.version) !== 3 || payload.boundaryModel !== 'dual') {
        throw new Error('unexpected Price series envelope');
    }
    const data = payload.data && typeof payload.data === 'object' ? payload.data : {};

    const scoped = exactSnapshot(data, TARGET_IDS);
    const scopedKeys = Object.keys(scoped);
    if (
        scopedKeys.length !== TARGET_IDS.length
        || scopedKeys.some(id => !TARGET_SET.has(id))
        || TARGET_IDS.some(id => !Object.prototype.hasOwnProperty.call(scoped, id))
    ) {
        throw new Error('scope guard: scoped publisher snapshot is not exactly 181-188');
    }

    for (const id of TARGET_IDS) {
        const counts = pointCounts(data[id]);
        const expected = TARGETS[id];
        if (counts.exact !== expected.initialExact || counts.stored !== expected.initialStored) {
            throw new Error(
                `scope drift ID=${id} exact=${counts.exact}/${expected.initialExact} stored=${counts.stored}/${expected.initialStored}`
            );
        }
    }

    console.log('REPAIR_PREFLIGHT=PASS');
}

async function runPass(passNumber, ids) {
    const body = JSON.stringify({
        ids,
        includeHistory: true,
        maxFetches: ids.length,
        dryRun: false,
    });

    for (let collision = 0; collision < 3; collision += 1) {
        const result = await requestJson('/api/admin/backfill-competition-prices', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
        });

        if (result.skipped === true && result.reason === 'already-running') {
            if (collision === 2) throw new Error(`PASS=${passNumber} sync collision limit exceeded`);
            await sleep(2000);
            continue;
        }
        if (result.skipped === true) throw new Error(`PASS=${passNumber} unexpected skip`);

        const requested = Array.isArray(result.requestedIds) ? result.requestedIds.map(String) : [];
        if (requested.length !== ids.length || requested.some((id, i) => id !== ids[i])) {
            throw new Error(`PASS=${passNumber} scope echo mismatch`);
        }

        const fetched = Number(result.fetched || 0);
        const stored = Number(result.stored || 0);
        const migrated = Number(result.migrated || 0);
        if (!Number.isFinite(fetched) || fetched < 0 || fetched > ids.length) {
            throw new Error(`PASS=${passNumber} invalid fetched=${fetched}`);
        }
        if (!Number.isFinite(stored) || stored < 0 || stored > fetched) {
            throw new Error(`PASS=${passNumber} invalid stored=${stored}`);
        }

        console.log(
            `PASS=${passNumber} IDS=${ids.join(',')} FETCHED=${fetched} STORED=${stored} MIGRATED=${migrated} MISSING_REPORTED=${Number(result.missing || 0)}`
        );
        return { fetched, stored, migrated };
    }
    throw new Error(`PASS=${passNumber} unreachable`);
}

async function postcheck(totals) {
    const payload = await requestJson(
        '/api/competition-price-series?ids=' + encodeURIComponent(TARGET_IDS.join(',')),
        {},
        30000,
    );
    const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
    const summary = [];
    for (const id of TARGET_IDS) {
        const counts = pointCounts(data[id]);
        if (counts.exact < TARGETS[id].initialExact) {
            throw new Error(`postcheck exact regression ID=${id}`);
        }
        summary.push(`${id}:${counts.exact}/${counts.stored}`);
    }

    if (totals.fetched > 66) throw new Error(`attempt budget exceeded: ${totals.fetched}`);
    console.log(`LOCAL_FINAL=${summary.join(' ')}`);
    console.log(`TOTAL_FETCHED=${totals.fetched} TOTAL_STORED=${totals.stored} TOTAL_MIGRATED=${totals.migrated}`);
    console.log('BOUNDED_REPAIR_SWEEP=PASS');
}

async function main() {
    await preflight();

    const totals = { fetched: 0, stored: 0, migrated: 0 };
    for (let i = 0; i < PASSES.length; i += 1) {
        const result = await runPass(i + 1, PASSES[i]);
        totals.fetched += result.fetched;
        totals.stored += result.stored;
        totals.migrated += result.migrated;
        if (i + 1 < PASSES.length) await sleep(1000);
    }
    await postcheck(totals);
}

main().catch(error => {
    console.error('BOUNDED_REPAIR_SWEEP=FAIL');
    console.error('REASON=' + (error && error.message ? error.message : String(error)));
    process.exitCode = 1;
});
