'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const source = fs.readFileSync(require.resolve('../index.js'), 'utf8');

function sliceBetween(startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.notEqual(start, -1, startMarker + ' missing');
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.notEqual(end, -1, endMarker + ' missing');
    return source.slice(start, end);
}

test('competition-data embeds the existing R2 price series in the one browser payload', () => {
    assert.match(source, /function embeddedCompetitionPriceSeries\(config\)/);
    assert.match(source, /PRICE_SERIES_CACHE\[id\] \|\| null/);
    assert.match(source, /function attachCompetitionPriceSeries\(config\)/);
    assert.match(source, /competition_price_series_v3: embeddedCompetitionPriceSeries\(config\)/);

    const api = sliceBetween("app.get('/api/competition-data'", '// =======================================================\n// 📈 API KLINES');
    assert.match(api, /Object\.entries\(HISTORY_CACHE\)/);
    assert.match(api, /attachCompetitionPriceSeries\(item\)/);
    assert.match(api, /competition_price_series_v3: embeddedCompetitionPriceSeries\(config\)/);
});

test('price sync is fair: at most one missing boundary attempt per competition per pass', () => {
    const sync = sliceBetween('async function syncTournamentPriceSeries', "app.get('/api/competition-price-series'");
    assert.match(sync, /let PRICE_SERIES_CONFIG_CURSOR|PRICE_SERIES_CONFIG_CURSOR/);
    assert.match(sync, /const orderedConfigs = configCount/);
    assert.match(sync, /const missingBoundaries = boundaries\.filter/);
    assert.match(sync, /const boundary = missingBoundaries\[0\]/);
    assert.match(sync, /fetched \+= 1;\s*const boundary = missingBoundaries\[0\]/s);
    assert.doesNotMatch(sync, /for \(const boundary of boundaries\) \{[\s\S]*fetchBoundaryPrice/);
});

test('normal runtime does not silently enable historical backfill or add another scheduler', () => {
    assert.match(source, /setInterval\(\(\) => syncTournamentPriceSeries\(\{ maxFetches: 6 \}\)/);
    assert.doesNotMatch(source, /setInterval\([^\n]*includeHistory:\s*true/);
    const admin = sliceBetween("app.post('/api/admin/backfill-competition-prices'", 'async function syncActiveConfig');
    assert.match(admin, /includeHistory: req\.body && req\.body\.includeHistory !== false/);
});


test('production-readonly persists Price through existing machine HMAC path, never direct R2 PutObject', () => {
    assert.match(source, /createCompetitionPriceSeriesPublisher/);
    assert.match(source, /readonlyState && readonlyState\.mode === 'production-readonly'/);
    assert.match(source, /PRICE_SERIES_MACHINE_PUBLISHER\.publishSnapshot\(PRICE_SERIES_CACHE\)/);
    const persist = sliceBetween('async function persistPriceSeriesToR2', 'function normalizeContractForChain');
    const readonlyStart = persist.indexOf("if (readonlyState && readonlyState.mode === 'production-readonly')");
    const directPut = persist.indexOf('new PutObjectCommand');
    assert.ok(readonlyStart >= 0 && directPut > readonlyStart);
});

test('nearest Price never closes a canonical boundary', () => {
    const sync = sliceBetween('async function syncTournamentPriceSeries', "app.get('/api/competition-price-series'");
    assert.match(sync, /point\.quality === 'exact'/);
    assert.match(sync, /Number\(point\.driftMs\) === 0/);
    assert.match(sync, /pricePoint\.quality !== 'exact'/);
    assert.match(sync, /Number\(pricePoint\.observedAt\) !== Number\(boundary\.boundaryAt\)/);
    assert.match(sync, /existing\.points = existing\.points\.filter/);
});


test('bounded historical backfill scopes strictly to requested numeric tournament ids', () => {
    assert.match(source, /function normalizePriceSeriesIds\(value\)/);
    assert.match(source, /filter\(item => \/\^\\d\{1,9\}\$\/\.test\(item\)\)/);
    const sync = sliceBetween('async function syncTournamentPriceSeries', "app.get('/api/competition-price-series'");
    assert.match(sync, /const hasIdFilter = Array\.isArray\(options\.ids\) \|\| typeof options\.ids === 'string'/);
    assert.match(sync, /const requestedIdSet = new Set\(requestedIds\)/);
    assert.match(sync, /!hasIdFilter \|\| requestedIdSet\.has\(tournamentSeriesId\(config\)\)/);
    assert.match(sync, /requestedIds: hasIdFilter \? requestedIds : null/);

    const admin = sliceBetween("app.post('/api/admin/backfill-competition-prices'", 'async function syncActiveConfig');
    assert.match(admin, /const hasIds = Object\.prototype\.hasOwnProperty\.call\(body, 'ids'\)/);
    assert.match(admin, /return res\.status\(400\)\.json\(\{ error: 'At least one valid numeric tournament id is required' \}\)/);
    assert.match(admin, /ids: hasIds \? ids : undefined/);
});

test('boundary fetch continues past nearest and returns exact timestamps only', () => {
    const fetchBlock = sliceBetween('async function fetchBoundaryPrice', 'function tournamentSeriesId');
    assert.match(fetchBlock, /selected\.quality === 'exact'/);
    assert.match(fetchBlock, /Number\(selected\.driftMs\) === 0/);
    assert.match(fetchBlock, /Number\(selected\.observedAt\) === Number\(boundaryAt\)/);
    assert.match(fetchBlock, /Continue to the next resolution/);
    assert.doesNotMatch(fetchBlock, /if \(selected\) \{\s*return/);
});
