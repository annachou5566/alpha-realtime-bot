'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

function replaceExactlyOnce(source, from, to, label) {
    const pieces = source.split(from);
    const count = pieces.length - 1;
    if (count !== 1) {
        throw new Error(`[PRODUCTION-READONLY] Source hardening anchor ${label} expected once, found ${count}`);
    }
    return {
        source: pieces[0] + to + pieces[1],
        label,
    };
}

function hardenProductionReadonlySource(input) {
    if (typeof input !== 'string' || !input.trim()) {
        throw new Error('[PRODUCTION-READONLY] index source is required');
    }

    let source = input;
    const applied = [];
    const apply = (from, to, label) => {
        const result = replaceExactlyOnce(source, from, to, label);
        source = result.source;
        applied.push(result.label);
    };

    apply(
        "const PORT = process.env.PORT || 3000;\n",
        "const PORT = process.env.PORT || 3000;\n" +
        "const PRODUCTION_READONLY_MODE =\n" +
        "    String(process.env.WAVE_RUNTIME_MODE || '').toLowerCase() === 'production-readonly';\n" +
        "const LISTEN_HOST = PRODUCTION_READONLY_MODE ? '127.0.0.1' : undefined;\n" +
        "const PRODUCTION_READONLY_STATE = globalThis.__WAVE_PRODUCTION_READONLY_STATE || null;\n" +
        "const PRODUCTION_PRICE_REPAIR_WINDOW =\n" +
        "    PRODUCTION_READONLY_MODE &&\n" +
        "    String(process.env.WAVE_COMPETITION_PRICE_REPAIR_WINDOW || '') === '181-188-2026-09-05';\n" +
        "const PRODUCTION_PRICE_REPAIR_IDS = new Set(['181','182','183','184','185','186','187','188']);\n" +
        "function productionPriceRepairScopeAllowed(ids, maxFetches) {\n" +
        "    if (!PRODUCTION_PRICE_REPAIR_WINDOW || !Array.isArray(ids) || ids.length === 0) return false;\n" +
        "    const normalized = ids.map(value => String(value));\n" +
        "    if (new Set(normalized).size !== normalized.length) return false;\n" +
        "    if (normalized.some(id => !PRODUCTION_PRICE_REPAIR_IDS.has(id))) return false;\n" +
        "    return Number(maxFetches) === normalized.length;\n" +
        "}\n" +
        "function noteProductionReadonlySuppressed(label) {\n" +
        "    if (PRODUCTION_READONLY_MODE && PRODUCTION_READONLY_STATE &&\n" +
        "        typeof PRODUCTION_READONLY_STATE.noteSuppressed === 'function') {\n" +
        "        PRODUCTION_READONLY_STATE.noteSuppressed(label);\n" +
        "    }\n" +
        "}\n",
        'mode-loopback-and-state',
    );

    apply(
        "async function fetch14DaysHistoryBapi() {\n    // [BW FIX]",
        "async function fetch14DaysHistoryBapi() {\n" +
        "    if (PRODUCTION_READONLY_MODE) {\n" +
        "        noteProductionReadonlySuppressed('historical-bapi-refresh');\n" +
        "        console.warn(\n" +
        "            '[PRODUCTION-READONLY] Historical Binance refresh disabled; ' +\n" +
        "            'loading existing R2 market history without a freshness claim.'\n" +
        "        );\n" +
        "        await syncMarketHistory();\n" +
        "        return;\n" +
        "    }\n\n" +
        "    // [BW FIX]",
        'historical-refresh-guard',
    );

    apply(
        "async function checkStartOffsets() {\n",
        "async function checkStartOffsets() {\n" +
        "    if (PRODUCTION_READONLY_MODE) {\n" +
        "        noteProductionReadonlySuppressed('start-offset-scan');\n" +
        "        console.log('[PRODUCTION-READONLY] Start-offset upstream scan disabled.');\n" +
        "        return;\n" +
        "    }\n",
        'start-offset-guard',
    );

    apply(
        "async function syncTournamentPriceSeries(options = {}) {\n",
        "async function syncTournamentPriceSeries(options = {}) {\n" +
        "    if (PRODUCTION_READONLY_MODE) {\n" +
        "        const requestedIds = normalizePriceSeriesIds(options.ids);\n" +
        "        const repairAllowed = options.includeHistory === true\n" +
        "            && options.dryRun !== true\n" +
        "            && Array.isArray(options.ids)\n" +
        "            && requestedIds.length === options.ids.length\n" +
        "            && productionPriceRepairScopeAllowed(requestedIds, options.maxFetches);\n" +
        "        if (options.includeHistory === true && !repairAllowed) {\n" +
        "            noteProductionReadonlySuppressed('competition-price-history-repair');\n" +
        "            console.log('[PRODUCTION-READONLY] Historical Competition Price repair unavailable outside approved window.');\n" +
        "            return {\n" +
        "                skipped: true,\n" +
        "                reason: 'production-readonly',\n" +
        "                fetched: 0,\n" +
        "                stored: 0,\n" +
        "                migrated: 0,\n" +
        "                missing: 0,\n" +
        "                requestedIds: Array.isArray(options.ids) ? requestedIds : null,\n" +
        "                series: Object.keys(PRICE_SERIES_CACHE).length,\n" +
        "            };\n" +
        "        }\n" +
        "        if (!repairAllowed) {\n" +
        "            options = {\n" +
        "                ...options,\n" +
        "                includeHistory: false,\n" +
        "                maxFetches: Math.min(6, Math.max(0, Number(options.maxFetches) || 6)),\n" +
        "            };\n" +
        "        }\n" +
        "    }\n",
        'price-machine-persistence-guard',
    );

    apply(
        "async function finalizeTournament(alphaId, finalData, predictionResult) {\n",
        "async function finalizeTournament(alphaId, finalData, predictionResult) {\n" +
        "    if (PRODUCTION_READONLY_MODE) {\n" +
        "        noteProductionReadonlySuppressed('finalize-tournament');\n" +
        "        console.warn(`[PRODUCTION-READONLY] Finalize suppressed for ${alphaId}.`);\n" +
        "        return;\n" +
        "    }\n",
        'finalize-guard',
    );

    apply(
        "async function writeCompetitionLive() {\n",
        "async function writeCompetitionLive() {\n" +
        "    if (PRODUCTION_READONLY_MODE) {\n" +
        "        noteProductionReadonlySuppressed('competition-live-write');\n" +
        "        return;\n" +
        "    }\n",
        'competition-live-write-guard',
    );

    apply(
        "const isNowFinalized = existingAi?.status_label === 'FINALIZED' || isTimeUp;\n",
        "const isNowFinalized = !PRODUCTION_READONLY_MODE &&\n" +
        "                    (existingAi?.status_label === 'FINALIZED' || isTimeUp);\n" +
        "                if (PRODUCTION_READONLY_MODE && isTimeUp) {\n" +
        "                    noteProductionReadonlySuppressed('inline-auto-finalize');\n" +
        "                }\n",
        'inline-auto-finalize-guard',
    );

    apply(
        "async function flushTickToR2() {\n",
        "async function flushTickToR2() {\n" +
        "    if (PRODUCTION_READONLY_MODE) {\n" +
        "        noteProductionReadonlySuppressed('tick-cache-flush');\n" +
        "        return;\n" +
        "    }\n",
        'tick-flush-guard',
    );

    apply(
        "        const ids = normalizePriceSeriesIds(body.ids);\n",
        "        const ids = normalizePriceSeriesIds(body.ids);\n" +
        "        if (PRODUCTION_READONLY_MODE) {\n" +
        "            const repairAllowed = body.includeHistory === true\n" +
        "                && body.dryRun === false\n" +
        "                && Array.isArray(body.ids)\n" +
        "                && ids.length === body.ids.length\n" +
        "                && productionPriceRepairScopeAllowed(ids, body.maxFetches);\n" +
        "            if (!repairAllowed) {\n" +
        "                noteProductionReadonlySuppressed('admin-price-backfill');\n" +
        "                return res.status(503).json({ error: 'Mutation unavailable in production-readonly mode' });\n" +
        "            }\n" +
        "        }\n",
        'admin-backfill-route-guard',
    );

    apply(
        "        runtime: RUNTIME,\n",
        "        runtime: RUNTIME,\n" +
        "        writeSafety: PRODUCTION_READONLY_STATE &&\n" +
        "            typeof PRODUCTION_READONLY_STATE.snapshot === 'function'\n" +
        "            ? PRODUCTION_READONLY_STATE.snapshot()\n" +
        "            : null,\n",
        'write-safety-telemetry',
    );

    apply(
        "server.listen(PORT, async () => {\n",
        "server.listen(PORT, LISTEN_HOST, async () => {\n",
        'loopback-bind',
    );

    return { source, applied };
}

function loadProductionReadonlyIndex(filename) {
    const resolved = path.resolve(filename);
    const original = fs.readFileSync(resolved, 'utf8');
    const hardened = hardenProductionReadonlySource(original);

    const child = new Module(resolved, module.parent || module);
    child.filename = resolved;
    child.paths = Module._nodeModulePaths(path.dirname(resolved));
    child._compile(hardened.source, resolved);

    return { module: child, applied: hardened.applied };
}

module.exports = {
    replaceExactlyOnce,
    hardenProductionReadonlySource,
    loadProductionReadonlyIndex,
};
