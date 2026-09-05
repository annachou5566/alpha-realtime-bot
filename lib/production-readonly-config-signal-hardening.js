'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const {
    replaceExactlyOnce,
    hardenProductionReadonlySource,
} = require('./production-readonly-source-hardening');

function hardenCompetitionConfigSignalSource(input) {
    if (typeof input !== 'string' || !input.trim()) {
        throw new Error('[CONFIG-REALTIME] index source is required');
    }

    let source = input;
    const applied = [];
    const apply = (from, to, label) => {
        const result = replaceExactlyOnce(source, from, to, label);
        source = result.source;
        applied.push(label);
    };

    apply(
        "const { createClient } = require('@supabase/supabase-js');\n",
        "const { createClient } = require('@supabase/supabase-js');\n" +
        "const { createCompetitionConfigRealtimeControl } = require('./lib/competition-config-realtime');\n" +
        "const { createAlphaLivePublisher } = require('./lib/alpha-live-publisher');\n",
        'config-realtime-import',
    );

    apply(
        "let ACTIVE_CONFIG = {};      \n",
        "let ACTIVE_CONFIG = {};      \n" +
        "let COMPETITION_CONFIG_REALTIME = null;\n" +
        "let COMPETITION_CONFIG_ROW_BASELINES = new Map();\n" +
        "let ALPHA_LIVE_PUBLISHER = null;\n" +
        "let ALPHA_LIVE_VOLUME_REVISION = 0;\n" +
        "let ALPHA_LIVE_VOLUME_OBSERVED_AT = 0;\n",
        'config-realtime-state',
    );

    apply(
        "        if (data) {\n            BANDWIDTH.supabaseReadBytes += byteLength(data);\n            const newActive = {};\n",
        "        if (data) {\n" +
        "            BANDWIDTH.supabaseReadBytes += byteLength(data);\n" +
        "            COMPETITION_CONFIG_ROW_BASELINES = new Map(data.map(row => [\n" +
        "                Number(row.id),\n" +
        "                {\n" +
        "                    id: row.id,\n" +
        "                    name: row.name,\n" +
        "                    contract: row.contract,\n" +
        "                    data: row.data && typeof row.data === 'object'\n" +
        "                        ? JSON.parse(JSON.stringify(row.data))\n" +
        "                        : row.data,\n" +
        "                },\n" +
        "            ]));\n" +
        "            const newActive = {};\n",
        'config-realtime-row-baselines',
    );

    apply(
        "        steadyState,\n        runtime: RUNTIME,\n",
        "        steadyState,\n" +
        "        competitionConfigRealtime: COMPETITION_CONFIG_REALTIME &&\n" +
        "            typeof COMPETITION_CONFIG_REALTIME.telemetry === 'function'\n" +
        "            ? COMPETITION_CONFIG_REALTIME.telemetry()\n" +
        "            : null,\n" +
        "        alphaLivePublisher: ALPHA_LIVE_PUBLISHER &&\n" +
        "            typeof ALPHA_LIVE_PUBLISHER.telemetry === 'function'\n" +
        "            ? ALPHA_LIVE_PUBLISHER.telemetry()\n" +
        "            : null,\n" +
        "        runtime: RUNTIME,\n",
        'config-realtime-telemetry',
    );

    apply(
        "    res.json({ success: true, count: Object.keys(GLOBAL_MARKET).length, data: GLOBAL_MARKET });\n",
        "    res.json({\n" +
        "        success: true,\n" +
        "        count: Object.keys(GLOBAL_MARKET).length,\n" +
        "        configSignal: COMPETITION_CONFIG_REALTIME &&\n" +
        "            typeof COMPETITION_CONFIG_REALTIME.snapshot === 'function'\n" +
        "            ? COMPETITION_CONFIG_REALTIME.snapshot()\n" +
        "            : null,\n" +
        "        data: GLOBAL_MARKET,\n" +
        "    });\n",
        'alpha-market-config-signal',
    );

    apply(
        "app.get('/api/competition-data', (req, res) => {\n    const scope = ['running', 'history', 'all'].includes(req.query.scope) ? req.query.scope : 'all';\n    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=300');\n",
        "app.get('/api/competition-data', (req, res) => {\n" +
        "    const scope = ['running', 'history', 'all'].includes(req.query.scope) ? req.query.scope : 'all';\n" +
        "    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=300');\n" +
        "    if (COMPETITION_CONFIG_REALTIME && typeof COMPETITION_CONFIG_REALTIME.snapshot === 'function') {\n" +
        "        const configSignal = COMPETITION_CONFIG_REALTIME.snapshot();\n" +
        "        res.setHeader('X-Wave-Competition-Revision', String(configSignal.revision || 0));\n" +
        "        res.setHeader('X-Wave-Competition-Structural-Revision', String(configSignal.structuralRevision || 0));\n" +
        "    }\n",
        'competition-revision-headers',
    );

    apply(
        "            await writeCompetitionLive(); // 0 API call mới — chỉ đọc RAM, write R2 ~500 bytes\n",
        "            await writeCompetitionLive(); // 0 API call mới — chỉ đọc RAM, write R2 ~500 bytes\n" +
        "            ALPHA_LIVE_VOLUME_REVISION += 1;\n" +
        "            ALPHA_LIVE_VOLUME_OBSERVED_AT = Date.now();\n" +
        "            if (ALPHA_LIVE_PUBLISHER) {\n" +
        "                ALPHA_LIVE_PUBLISHER.publishNow('volume').catch(() => {});\n" +
        "            }\n",
        'alpha-live-volume-publish',
    );

    const setup = [
        "function waveFindActiveConfigByDbId(dbId) {",
        "    const wanted = Number(dbId);",
        "    for (const [alphaId, config] of Object.entries(ACTIVE_CONFIG)) {",
        "        if (Number(config && config.db_id) === wanted) return {\n" +
        "            alphaId,\n" +
        "            config,\n" +
        "            rawRow: COMPETITION_CONFIG_ROW_BASELINES.get(wanted) || null,\n" +
        "        };",
        "    }",
        "    return null;",
        "}",
        "",
        "function waveRememberCompetitionRow(row) {",
        "    if (!row || row.id == null) return;",
        "    COMPETITION_CONFIG_ROW_BASELINES.set(Number(row.id), {",
        "        id: row.id,",
        "        name: row.name,",
        "        contract: row.contract,",
        "        data: row.data && typeof row.data === 'object'",
        "            ? JSON.parse(JSON.stringify(row.data))",
        "            : row.data,",
        "    });",
        "}",
        "",
        "function waveApplyCompetitionConfigPatch(row, patch) {",
        "    const found = waveFindActiveConfigByDbId(row && row.id);",
        "    if (!found) return false;",
        "    const next = { ...found.config };",
        "    if (Object.prototype.hasOwnProperty.call(patch, 'history')) next.history = patch.history;",
        "    if (Object.prototype.hasOwnProperty.call(patch, 'ai_prediction')) next.ai_prediction = patch.ai_prediction;",
        "    if (Object.prototype.hasOwnProperty.call(patch, 'min_vol')) next.min_vol = patch.min_vol;",
        "    if (Object.prototype.hasOwnProperty.call(patch, 'minVol')) next.minVol = patch.minVol;",
        "    if (Object.prototype.hasOwnProperty.call(patch, 'display_target')) next.display_target = patch.display_target;",
        "    if (Object.prototype.hasOwnProperty.call(patch, 'display_prev_target')) next.display_prev_target = patch.display_prev_target;",
        "    ACTIVE_CONFIG[found.alphaId] = next;",
        "    if (GLOBAL_MARKET[found.alphaId] && Object.prototype.hasOwnProperty.call(patch, 'ai_prediction')) {",
        "        GLOBAL_MARKET[found.alphaId].ai_prediction = patch.ai_prediction;",
        "    }",
        "    return true;",
        "}",
        "",
        "function waveFiniteLiveNumber(value) {",
        "    const number = Number(value);",
        "    return Number.isFinite(number) ? number : null;",
        "}",
        "",
        "function waveBuildAlphaLiveVolumeSnapshot() {",
        "    if (!(ALPHA_LIVE_VOLUME_OBSERVED_AT > 0)) return null;",
        "    const items = {};",
        "    for (const [alphaId, config] of Object.entries(ACTIVE_CONFIG)) {",
        "        const live = GLOBAL_MARKET[alphaId];",
        "        if (!live || typeof live !== 'object') continue;",
        "        const item = {};",
        "        const dbId = waveFiniteLiveNumber(config && config.db_id);",
        "        const dailyTotal = waveFiniteLiveNumber(",
        "            live.effectiveTodayVol !== undefined ? live.effectiveTodayVol : live.v && live.v.dt",
        "        );",
        "        const dailyLimit = waveFiniteLiveNumber(live.v && live.v.dl);",
        "        const liveAccumulatedTotal = waveFiniteLiveNumber(live.totalAccumulated);",
        "        const liveAccumulatedLimit = waveFiniteLiveNumber(live.limitAccumulated);",
        "        const canonicalAccumulatedTotal = waveFiniteLiveNumber(config && config.total_accumulated_volume);",
        "        const canonicalAccumulatedLimit = waveFiniteLiveNumber(config && config.limit_accumulated_volume);",
        "        const accumulatedTotal = liveAccumulatedTotal === null",
        "            ? canonicalAccumulatedTotal",
        "            : (canonicalAccumulatedTotal === null ? liveAccumulatedTotal : Math.max(liveAccumulatedTotal, canonicalAccumulatedTotal));",
        "        const accumulatedLimit = liveAccumulatedLimit === null",
        "            ? canonicalAccumulatedLimit",
        "            : (canonicalAccumulatedLimit === null ? liveAccumulatedLimit : Math.max(liveAccumulatedLimit, canonicalAccumulatedLimit));",
        "        const cumulativeReady = accumulatedTotal !== null && accumulatedLimit !== null && accumulatedLimit <= accumulatedTotal;",
        "        const dailyTx = waveFiniteLiveNumber(live.tx);",
        "        if (dbId !== null) item.dbId = dbId;",
        "        if (dailyTotal !== null) item.dailyTotal = dailyTotal;",
        "        if (dailyLimit !== null) item.dailyLimit = dailyLimit;",
        "        if (dailyTotal !== null && dailyLimit !== null) item.dailyOnchain = Math.max(0, dailyTotal - dailyLimit);",
        "        if (cumulativeReady) {",
        "            item.accumulatedTotal = accumulatedTotal;",
        "            item.accumulatedLimit = accumulatedLimit;",
        "            item.accumulatedOnchain = Math.max(0, accumulatedTotal - accumulatedLimit);",
        "        }",
        "        if (dailyTx !== null) item.dailyTx = dailyTx;",
        "        if (Object.keys(item).length > 1 || (Object.keys(item).length === 1 && item.dbId === undefined)) {",
        "            items[alphaId] = item;",
        "        }",
        "    }",
        "    if (Object.keys(items).length === 0) return null;",
        "    return {",
        "        revision: ALPHA_LIVE_VOLUME_REVISION,",
        "        observedAt: ALPHA_LIVE_VOLUME_OBSERVED_AT,",
        "        limitObservedAt: Number(LIMIT_MAP_CACHE && LIMIT_MAP_CACHE.ts || 0),",
        "        items,",
        "    };",
        "}",
        "",
        "function waveBuildAlphaLiveState() {",
        "    return {",
        "        configSignal: COMPETITION_CONFIG_REALTIME &&",
        "            typeof COMPETITION_CONFIG_REALTIME.snapshot === 'function'",
        "            ? COMPETITION_CONFIG_REALTIME.snapshot()",
        "            : null,",
        "        volume: waveBuildAlphaLiveVolumeSnapshot(),",
        "    };",
        "}",
        "",
        "ALPHA_LIVE_PUBLISHER = createAlphaLivePublisher({",
        "    url: process.env.ALPHA_LIVE_PUBLISH_URL,",
        "    key: process.env.ALPHA_LIVE_PUBLISH_KEY,",
        "    getSnapshot: waveBuildAlphaLiveState,",
        "    logger: console,",
        "});",
        "",
        "COMPETITION_CONFIG_REALTIME = createCompetitionConfigRealtimeControl({",
        "    supabase,",
        "    getCurrentByDbId: waveFindActiveConfigByDbId,",
        "    applyPatch: waveApplyCompetitionConfigPatch,",
        "    rememberRow: waveRememberCompetitionRow,",
        "    refreshAll: syncActiveConfig,",
        "    onSnapshotChange: () => ALPHA_LIVE_PUBLISHER.publishNow('config'),",
        "    logger: console,",
        "});",
        "COMPETITION_CONFIG_REALTIME.start();",
        "",
    ].join('\n');

    apply(
        "server.listen(PORT, async () => {\n",
        setup + "server.listen(PORT, async () => {\n",
        'config-realtime-startup',
    );

    return { source, applied };
}

function loadProductionReadonlyIndexWithConfigSignal(filename) {
    const resolved = path.resolve(filename);
    const original = fs.readFileSync(resolved, 'utf8');
    const configHardened = hardenCompetitionConfigSignalSource(original);
    const baseHardened = hardenProductionReadonlySource(configHardened.source);

    const child = new Module(resolved, module.parent || module);
    child.filename = resolved;
    child.paths = Module._nodeModulePaths(path.dirname(resolved));
    child._compile(baseHardened.source, resolved);

    return {
        module: child,
        applied: [...baseHardened.applied, ...configHardened.applied],
    };
}

module.exports = {
    hardenCompetitionConfigSignalSource,
    loadProductionReadonlyIndexWithConfigSignal,
};
