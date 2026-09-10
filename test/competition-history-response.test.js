'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    buildRoundSafeHistoryEntries,
    historyResponseKey,
} = require('../lib/competition-history-response');

test('History response keys are tournament-round unique even when alphaId is reused', () => {
    const index = {
        180: { db_id: 180, name: 'AIA (R1)', alphaId: 'ALPHA_496' },
        186: { db_id: 186, name: 'AIA (R2)', alphaId: 'ALPHA_496' },
        185: { db_id: 185, name: 'COLLECT (R1)', alphaId: 'ALPHA_506' },
    };

    const entries = buildRoundSafeHistoryEntries(index, {});
    const out = Object.fromEntries(entries);

    assert.equal(out.history_180.name, 'AIA (R1)');
    assert.equal(out.history_186.name, 'AIA (R2)');
    assert.equal(out.history_185.name, 'COLLECT (R1)');
    assert.equal(Object.keys(out).length, 3);
});

test('active round keyed by alphaId cannot overwrite a History round', () => {
    const history = Object.fromEntries(buildRoundSafeHistoryEntries({
        185: { db_id: 185, name: 'COLLECT (R1)', alphaId: 'ALPHA_506' },
    }, {}));

    history.ALPHA_506 = {
        db_id: 191,
        name: 'COLLECT (R2)',
        alphaId: 'ALPHA_506',
    };

    assert.equal(history.history_185.db_id, 185);
    assert.equal(history.history_185.name, 'COLLECT (R1)');
    assert.equal(history.ALPHA_506.db_id, 191);
    assert.equal(history.ALPHA_506.name, 'COLLECT (R2)');
});

test('Supabase round index wins over stale legacy alphaId cache', () => {
    const entries = buildRoundSafeHistoryEntries({
        186: { db_id: 186, name: 'AIA (R2)', alphaId: 'ALPHA_496' },
    }, {
        ALPHA_496: { db_id: 180, name: 'AIA (R1)', alphaId: 'ALPHA_496' },
    });

    const out = Object.fromEntries(entries);
    assert.equal(out.history_186.name, 'AIA (R2)');
    assert.equal(Object.values(out).some(item => item.name === 'AIA (R1)'), false);
});

test('legacy-only History remains available as compatibility fallback', () => {
    const entries = buildRoundSafeHistoryEntries({}, {
        ALPHA_999: { name: 'LEGACY ONLY', alphaId: 'ALPHA_999' },
    });

    assert.deepEqual(entries, [
        ['history_legacy_ALPHA_999', { name: 'LEGACY ONLY', alphaId: 'ALPHA_999' }],
    ]);
});

test('index.js uses round-safe Supabase History index without changing R2 History persistence', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

    assert.match(source, /let TOURNAMENT_HISTORY_INDEX = \{\};/);
    assert.match(source, /newHistoryByTournament\[String\(row\.id\)\] = roundEntry;/);
    assert.match(source, /buildRoundSafeHistoryEntries\(\s*TOURNAMENT_HISTORY_INDEX,\s*HISTORY_CACHE,\s*\)/);
    assert.match(source, /Key: HISTORY_FILE_KEY, Body: JSON\.stringify\(HISTORY_CACHE\)/);
    assert.doesNotMatch(source, /JSON\.stringify\(TOURNAMENT_HISTORY_INDEX\)/);
});

test('historyResponseKey is stable and scoped by tournament id', () => {
    assert.equal(historyResponseKey({ db_id: 186, alphaId: 'ALPHA_496' }, 'ALPHA_496'), 'history_186');
    assert.equal(historyResponseKey({ id: 185, alphaId: 'ALPHA_506' }, 'ALPHA_506'), 'history_185');
});
