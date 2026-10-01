'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

function replaceExactlyOnce(source, from, to, label) {
    const pieces = source.split(from);
    const count = pieces.length - 1;
    if (count !== 1) {
        throw new Error(`[QUALIFICATION] Source hardening anchor ${label} expected once, found ${count}`);
    }
    return {
        source: pieces[0] + to + pieces[1],
        label,
    };
}

function hardenQualificationSource(input) {
    if (typeof input !== 'string' || !input.trim()) {
        throw new Error('[QUALIFICATION] index source is required');
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
        "const QUALIFICATION_MODE =\n" +
        "    String(process.env.WAVE_RUNTIME_MODE || '').toLowerCase() === 'qualification';\n" +
        "const LISTEN_HOST = QUALIFICATION_MODE ? '127.0.0.1' : undefined;\n",
        'mode-and-loopback-host',
    );

    apply(
        "async function fetch14DaysHistoryBapi() {\n    // [BW FIX]",
        "async function fetch14DaysHistoryBapi() {\n" +
        "    if (QUALIFICATION_MODE) {\n" +
        "        console.warn(\n" +
        "            '[QUALIFICATION] Historical Binance backfill disabled; ' +\n" +
        "            'loading existing R2 market history without freshness claim.'\n" +
        "        );\n" +
        "        await syncMarketHistory();\n" +
        "        return;\n" +
        "    }\n\n" +
        "    // [BW FIX]",
        'historical-scrape-guard',
    );

    apply(
        "async function checkStartOffsets() {\n",
        "async function checkStartOffsets() {\n" +
        "    if (QUALIFICATION_MODE) {\n" +
        "        console.log('[QUALIFICATION] Start-offset upstream scan disabled.');\n" +
        "        return;\n" +
        "    }\n",
        'start-offset-guard',
    );

    apply(
        "async function syncTournamentPriceSeries(options = {}) {\n",
        "async function syncTournamentPriceSeries(options = {}) {\n" +
        "    if (QUALIFICATION_MODE && options.dryRun !== true) {\n" +
        "        console.log('[QUALIFICATION] Competition price backfill disabled.');\n" +
        "        return {\n" +
        "            skipped: true,\n" +
        "            reason: 'qualification-mode',\n" +
        "            fetched: 0,\n" +
        "            stored: 0,\n" +
        "            migrated: 0,\n" +
        "            missing: 0,\n" +
        "            series: Object.keys(PRICE_SERIES_CACHE).length,\n" +
        "        };\n" +
        "    }\n",
        'price-backfill-guard',
    );

    apply(
        "async function finalizeTournament(alphaId, finalData, predictionResult) {\n",
        "async function finalizeTournament(alphaId, finalData, predictionResult) {\n" +
        "    if (QUALIFICATION_MODE) {\n" +
        "        console.warn(`[QUALIFICATION] Finalize suppressed for ${alphaId}.`);\n" +
        "        return;\n" +
        "    }\n",
        'finalize-guard',
    );

    apply(
        "async function writeCompetitionLive() {\n",
        "async function writeCompetitionLive() {\n" +
        "    if (QUALIFICATION_MODE) return;\n",
        'competition-live-write-guard',
    );

    apply(
        "const isNowFinalized = existingAi?.status_label === 'FINALIZED' || isTimeUp;\n",
        "const isNowFinalized = !QUALIFICATION_MODE &&\n" +
        "                    (existingAi?.status_label === 'FINALIZED' || isTimeUp);\n",
        'auto-finalize-guard',
    );

    apply(
        "server.listen(PORT, async () => {\n",
        "server.listen(PORT, LISTEN_HOST, async () => {\n",
        'loopback-bind',
    );

    return { source, applied };
}

function loadHardenedIndex(filename) {
    const resolved = path.resolve(filename);
    const original = fs.readFileSync(resolved, 'utf8');
    const hardened = hardenQualificationSource(original);

    const child = new Module(resolved, module.parent || module);
    child.filename = resolved;
    child.paths = Module._nodeModulePaths(path.dirname(resolved));
    child._compile(hardened.source, resolved);

    return { module: child, applied: hardened.applied };
}

module.exports = {
    replaceExactlyOnce,
    hardenQualificationSource,
    loadHardenedIndex,
};
