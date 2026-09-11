'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const {
    replaceExactlyOnce,
    hardenProductionReadonlySource,
} = require('./production-readonly-source-hardening');
const {
    hardenCompetitionConfigSignalSource,
} = require('./production-readonly-config-signal-hardening');

function hardenCompetitionActiveWindowSource(input) {
    if (typeof input !== 'string' || !input.trim()) {
        throw new Error('[COMPETITION-WINDOW] index source is required');
    }

    let source = input;
    const applied = [];
    const apply = (from, to, label) => {
        const result = replaceExactlyOnce(source, from, to, label);
        source = result.source;
        applied.push(label);
    };

    apply(
        "const {\n    buildRoundSafeHistoryEntries,\n} = require('./lib/competition-history-response');\n",
        "const {\n    buildRoundSafeHistoryEntries,\n} = require('./lib/competition-history-response');\n" +
        "const { competitionWindowState } = require('./lib/competition-active-window');\n",
        'competition-window-import',
    );

    apply(
        "            const newTokens = [];\n            data.forEach(row => {\n",
        "            const newTokens = [];\n" +
        "            const activeConfigCollisions = new Set();\n" +
        "            data.forEach(row => {\n",
        'competition-window-collision-state',
    );

    apply(
        "                const meta = row.data || {};\n                let isActive = true;\n                if (meta.ai_prediction && meta.ai_prediction.status_label === 'FINALIZED') isActive = false;\n                if (meta.end && meta.end < todayStr) isActive = false;\n\n                if (meta.alphaId) {\n",
        "                const meta = row.data || {};\n" +
        "                const windowState = competitionWindowState(meta, Date.now());\n" +
        "                const isActive = windowState.state === 'active';\n" +
        "                if (windowState.state === 'invalid') {\n" +
        "                    console.warn('[CONFIG] invalid competition schedule; excluded', { dbId: row.id, alphaId: meta.alphaId || null, reason: windowState.reason });\n" +
        "                }\n\n" +
        "                if (meta.alphaId) {\n",
        'competition-window-classification',
    );

    apply(
        "                    if (isActive) {\n                        newActive[meta.alphaId] = { ...meta, db_id: row.id };\n                        if (!newTokens.includes(meta.alphaId)) newTokens.push(meta.alphaId);\n                    } else {\n                        const roundEntry = {\n",
        "                    if (isActive) {\n" +
        "                        const activeId = String(meta.alphaId);\n" +
        "                        if (activeConfigCollisions.has(activeId)) {\n" +
        "                            console.error('[CONFIG] overlapping active competition row remains excluded', { alphaId: activeId, dbId: row.id });\n" +
        "                        } else if (newActive[activeId]) {\n" +
        "                            const previousDbId = Number(newActive[activeId].db_id);\n" +
        "                            delete newActive[activeId];\n" +
        "                            const tokenIndex = newTokens.indexOf(activeId);\n" +
        "                            if (tokenIndex >= 0) newTokens.splice(tokenIndex, 1);\n" +
        "                            activeConfigCollisions.add(activeId);\n" +
        "                            console.error('[CONFIG] overlapping active competition rows excluded', { alphaId: activeId, dbIds: [previousDbId, Number(row.id)] });\n" +
        "                        } else {\n" +
        "                            newActive[activeId] = { ...meta, db_id: row.id };\n" +
        "                            if (!newTokens.includes(activeId)) newTokens.push(activeId);\n" +
        "                        }\n" +
        "                    } else if (windowState.state === 'history') {\n" +
        "                        const roundEntry = {\n",
        'competition-window-active-owner',
    );

    return { source, applied };
}

function loadProductionReadonlyIndexWithCompetitionWindow(filename) {
    const resolved = path.resolve(filename);
    const original = fs.readFileSync(resolved, 'utf8');
    const windowHardened = hardenCompetitionActiveWindowSource(original);
    const configHardened = hardenCompetitionConfigSignalSource(windowHardened.source);
    const baseHardened = hardenProductionReadonlySource(configHardened.source);

    const child = new Module(resolved, module.parent || module);
    child.filename = resolved;
    child.paths = Module._nodeModulePaths(path.dirname(resolved));
    child._compile(baseHardened.source, resolved);

    return {
        module: child,
        applied: [
            ...baseHardened.applied,
            ...windowHardened.applied,
            ...configHardened.applied,
        ],
    };
}

module.exports = {
    hardenCompetitionActiveWindowSource,
    loadProductionReadonlyIndexWithCompetitionWindow,
};
