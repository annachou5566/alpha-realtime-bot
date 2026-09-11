'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    hardenCompetitionActiveWindowSource,
} = require('../lib/production-readonly-competition-window-hardening');
const {
    hardenCompetitionConfigSignalSource,
} = require('../lib/production-readonly-config-signal-hardening');
const {
    hardenProductionReadonlySource,
} = require('../lib/production-readonly-source-hardening');

const INDEX_PATH = path.join(__dirname, '..', 'index.js');

test('runtime source hardens competition membership to half-open windows and collision fail-closed', () => {
    const original = fs.readFileSync(INDEX_PATH, 'utf8');
    const out = hardenCompetitionActiveWindowSource(original);
    assert.deepEqual(out.applied, [
        'competition-window-import',
        'competition-window-collision-state',
        'competition-window-classification',
        'competition-window-active-owner',
    ]);
    assert.match(out.source, /competitionWindowState\(meta, Date\.now\(\)\)/);
    assert.match(out.source, /activeConfigCollisions/);
    assert.match(out.source, /delete newActive\[activeId\]/);
    assert.match(out.source, /windowState\.state === 'history'/);
    assert.doesNotMatch(out.source, /meta\.end && meta\.end < todayStr/);

    const configHardened = hardenCompetitionConfigSignalSource(out.source);
    const readonlyHardened = hardenProductionReadonlySource(configHardened.source);
    assert.match(readonlyHardened.source, /server\.listen\(PORT, LISTEN_HOST, async \(\) => \{/);
    assert.match(readonlyHardened.source, /writeSafety:/);
});

test('competition window hardener fails closed on source-anchor drift', () => {
    assert.throws(
        () => hardenCompetitionActiveWindowSource("const { buildRoundSafeHistoryEntries } = require('./lib/competition-history-response');\n"),
        /expected once, found 0/,
    );
});
