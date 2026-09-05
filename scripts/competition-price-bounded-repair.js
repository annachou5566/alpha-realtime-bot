'use strict';

const path = require('path');

const API_BASE = 'http://127.0.0.1:3100';
const TARGETS = Object.freeze({
    '181': { targetExact: 15, initialExact: 2, initialStored: 3 },
    '182': { targetExact: 15, initialExact: 2, initialStored: 3 },
    '183': { targetExact: 15, initialExact: 1, initialStored: 1 },
    '184': { targetExact: 8, initialExact: 0, initialStored: 0 },
    '185': { targetExact: 6, initialExact: 0, initialStored: 0 },
    '186': { targetExact: 6, initialExact: 0, initialStored: 0 },
    '187': { targetExact: 4, initialExact: 0, initialStored: 0 },
    '188': { targetExact: 2, initialExact: 0, initialStored: 0 },
});
const TARGET_IDS = Object.keys(TARGETS);
const TARGET_SET = new Set(TARGET_IDS);

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
    const exactRaw = points.filter(point => point && point.quality === 'exact').length;
    const exact = points.filter(isExact).length;
    return {
        stored: points.length,
        exact,
        invalidExact: exactRaw - exact,
    };
}

function validateScopedSnapshot(data, scoped) {
    const presentTargetIds = TARGET_IDS.filter(
        id => Object.prototype.hasOwnProperty.call(data, id)
    );
    const scopedKeys = Object.keys(scoped);

    if (
        scopedKeys.some(id => !TARGET_SET.has(id))
        || scopedKeys.length !== presentTargetIds.length
        || presentTargetIds.some(id => !Object.prototype.hasOwnProperty.call(scoped, id))
    ) {
        throw new Error('scope guard: scoped publisher snapshot differs from present targets 181-188');
    }
}

function buildDynamicPasses(remainingById) {
    const maxRemaining = Math.max(
        0,
        ...TARGET_IDS.map(id => Number(remainingById[id] || 0)),
    );
    const passes = [];
    for (let round = 0; round < maxRemaining; round += 1) {
        const ids = TARGET_IDS.filter(id => Number(remainingById[id] || 0) > round);
        if (ids.length) passes.push(ids);
    }
    return passes;
}

function validateAndPlan(data) {
    const remainingById = {};
    const baselineExactById = {};

    for (const id of TARGET_IDS) {
        const counts = pointCounts(data[id]);
        const expected = TARGETS[id];

        if (counts.invalidExact !== 0) {
            throw new Error(`invalid exact point ID=${id} count=${counts.invalidExact}`);
        }
        if (
            counts.exact < expected.initialExact
            || counts.stored < expected.initialStored
        ) {
            throw new Error(
                `scope regression ID=${id} exact=${counts.exact}/min${expected.initialExact} stored=${counts.stored}/min${expected.initialStored}`
            );
        }
        if (counts.exact > expected.targetExact) {
            throw new Error(
                `scope overflow ID=${id} exact=${counts.exact}/target${expected.targetExact}`
            );
        }

        baselineExactById[id] = counts.exact;
        remainingById[id] = expected.targetExact - counts.exact;
    }

    const passes = buildDynamicPasses(remainingById);
    const budget = Object.values(remainingById).reduce((sum, value) => sum + Number(value || 0), 0);

    return { remainingById, baselineExactById, passes, budget };
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
    validateScopedSnapshot(data, scoped);

    const plan = validateAndPlan(data);
    for (const id of TARGET_IDS) {
        const counts = pointCounts(data[id]);
        console.log(
            `PREFLIGHT_ID=${id} EXACT=${counts.exact} STORED=${counts.stored} TARGET=${TARGETS[id].targetExact} REMAINING=${plan.remainingById[id]}`
        );
    }
    console.log(`REPAIR_DYNAMIC_BUDGET=${plan.budget}`);
    console.log('REPAIR_PREFLIGHT=PASS');
    return plan;
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

async function postcheck(totals, plan) {
    const payload = await requestJson(
        '/api/competition-price-series?ids=' + encodeURIComponent(TARGET_IDS.join(',')),
        {},
        30000,
    );
    const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
    const summary = [];

    for (const id of TARGET_IDS) {
        const counts = pointCounts(data[id]);
        if (counts.invalidExact !== 0) {
            throw new Error(`postcheck invalid exact ID=${id}`);
        }
        if (counts.exact < plan.baselineExactById[id]) {
            throw new Error(`postcheck exact regression ID=${id}`);
        }
        if (counts.exact > TARGETS[id].targetExact) {
            throw new Error(`postcheck exact overflow ID=${id}`);
        }
        summary.push(`${id}:${counts.exact}/${counts.stored}`);
    }

    if (totals.fetched > plan.budget) {
        throw new Error(`attempt budget exceeded: ${totals.fetched}/${plan.budget}`);
    }

    console.log(`LOCAL_FINAL=${summary.join(' ')}`);
    console.log(`TOTAL_FETCHED=${totals.fetched} TOTAL_STORED=${totals.stored} TOTAL_MIGRATED=${totals.migrated} BUDGET=${plan.budget}`);
    console.log('BOUNDED_REPAIR_SWEEP=PASS');
}

async function main() {
    const plan = await preflight();

    const totals = { fetched: 0, stored: 0, migrated: 0 };
    for (let i = 0; i < plan.passes.length; i += 1) {
        const result = await runPass(i + 1, plan.passes[i]);
        totals.fetched += result.fetched;
        totals.stored += result.stored;
        totals.migrated += result.migrated;
        if (i + 1 < plan.passes.length) await sleep(1000);
    }
    await postcheck(totals, plan);
}

if (require.main === module) {
    main().catch(error => {
        console.error('BOUNDED_REPAIR_SWEEP=FAIL');
        console.error('REASON=' + (error && error.message ? error.message : String(error)));
        process.exitCode = 1;
    });
}

module.exports = {
    TARGETS,
    validateScopedSnapshot,
    buildDynamicPasses,
    validateAndPlan,
};
