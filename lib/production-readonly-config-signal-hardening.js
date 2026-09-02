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
        "const { createCompetitionConfigRealtimeControl } = require('./lib/competition-config-realtime');\n",
        'config-realtime-import',
    );

    apply(
        "let ACTIVE_CONFIG = {};      \n",
        "let ACTIVE_CONFIG = {};      \n" +
        "let COMPETITION_CONFIG_REALTIME = null;\n" +
        "let COMPETITION_CONFIG_ROW_BASELINES = new Map();\n",
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
        "COMPETITION_CONFIG_REALTIME = createCompetitionConfigRealtimeControl({",
        "    supabase,",
        "    getCurrentByDbId: waveFindActiveConfigByDbId,",
        "    applyPatch: waveApplyCompetitionConfigPatch,",
        "    rememberRow: waveRememberCompetitionRow,",
        "    refreshAll: syncActiveConfig,",
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
