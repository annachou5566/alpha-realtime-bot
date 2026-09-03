'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
    createAlphaLivePublisher,
    normalizePublishUrl,
} = require('../lib/alpha-live-publisher');
const {
    createCompetitionConfigRealtimeControl,
} = require('../lib/competition-config-realtime');
const {
    hardenCompetitionConfigSignalSource,
} = require('../lib/production-readonly-config-signal-hardening');

function makeSupabase() {
    let handler = null;
    return {
        channel() {
            return {
                on(_kind, _filter, next) {
                    handler = next;
                    return this;
                },
                subscribe(callback) {
                    callback('SUBSCRIBED');
                    return this;
                },
            };
        },
        async removeChannel() {},
        emit(payload) {
            if (handler) handler(payload);
        },
    };
}

test('publisher is disabled without exact canonical/preview Pages URL and strong key', async () => {
    assert.equal(normalizePublishUrl('http://wave-alpha.pages.dev/api/alpha-live-publish'), '');
    assert.equal(normalizePublishUrl('https://example.com/api/alpha-live-publish'), '');
    assert.equal(normalizePublishUrl('https://wave-alpha.pages.dev/api/other'), '');

    let calls = 0;
    const publisher = createAlphaLivePublisher({
        url: '',
        key: '',
        getSnapshot: () => ({ configSignal: { revision: 1 } }),
        fetchImpl: async () => { calls += 1; return { ok: true, status: 204 }; },
    });
    assert.equal(publisher.enabled, false);
    assert.equal(await publisher.publishNow('disabled'), false);
    assert.equal(calls, 0);
});

test('publisher sends bounded latest state, dedupes identical snapshots and never logs key', async () => {
    const calls = [];
    const logs = [];
    const key = 'k'.repeat(40);
    let snapshot = {
        configSignal: { revision: 3, structuralRevision: 0, droppedBeforeRevision: 0, batches: [] },
        volume: {
            revision: 8,
            observedAt: 1000,
            limitObservedAt: 900,
            items: { ALPHA_1: { dbId: 1, dailyTotal: 10, dailyLimit: 4, accumulatedTotal: 20, accumulatedLimit: 8 } },
        },
    };
    const publisher = createAlphaLivePublisher({
        url: 'https://wave-alpha.pages.dev/api/alpha-live-publish',
        key,
        getSnapshot: () => snapshot,
        logger: { warn: (...args) => logs.push(args.join(' ')) },
        fetchImpl: async (_url, init) => {
            calls.push({ headers: init.headers, body: JSON.parse(init.body) });
            return { ok: true, status: 204 };
        },
    });

    assert.equal(publisher.enabled, true);
    await publisher.publishNow('first');
    await publisher.publishNow('duplicate');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.schema, 1);
    assert.equal(calls[0].body.volume.revision, 8);
    assert.equal(calls[0].body.volume.items.ALPHA_1.dailyTotal, 10);
    assert.match(calls[0].headers.Authorization, /^Bearer /);

    snapshot = {
        ...snapshot,
        volume: { ...snapshot.volume, revision: 9, observedAt: 2000 },
    };
    await publisher.publishNow('next-volume');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.volume.revision, 9);
    assert.equal(logs.join('\n').includes(key), false);

    const telemetry = publisher.telemetry();
    assert.equal(telemetry.successes, 2);
    assert.equal(telemetry.duplicateSkips, 1);
});

test('config realtime notifies observer only after an applied patch batch', async () => {
    const supabase = makeSupabase();
    const row = {
        id: 7,
        name: 'AAA',
        contract: '0x7',
        data: { alphaId: 'ALPHA_7', history: [{ date: '2026-09-03', target: 10 }] },
    };
    let currentRaw = JSON.parse(JSON.stringify(row));
    const notifications = [];

    const control = createCompetitionConfigRealtimeControl({
        supabase,
        batchMs: 100,
        getCurrentByDbId: () => ({ alphaId: 'ALPHA_7', config: {}, rawRow: currentRaw }),
        applyPatch: () => true,
        rememberRow: next => { currentRaw = JSON.parse(JSON.stringify(next)); },
        refreshAll: async () => {},
        onSnapshotChange: (snapshot, reason) => notifications.push({ snapshot, reason }),
        logger: { log() {}, warn() {}, error() {} },
    });
    control.start();
    supabase.emit({
        eventType: 'UPDATE',
        new: {
            ...row,
            data: { ...row.data, history: [{ date: '2026-09-03', target: 12 }] },
        },
    });
    control.flushPatches();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].reason, 'patch');
    assert.equal(notifications[0].snapshot.revision, 1);
    assert.equal(notifications[0].snapshot.batches[0].patches[0].history[0].target, 12);
    await control.stop();
});

test('production-readonly hardening wires publisher without changing Spot ownership or poll cadence', () => {
    const indexPath = path.join(__dirname, '..', 'index.js');
    const original = fs.readFileSync(indexPath, 'utf8');
    const { source, applied } = hardenCompetitionConfigSignalSource(original);
    const count = (text, pattern) => (text.match(pattern) || []).length;

    assert.ok(applied.includes('alpha-live-volume-publish'));
    assert.match(source, /createAlphaLivePublisher/);
    assert.match(source, /ALPHA_LIVE_PUBLISH_URL/);
    assert.match(source, /ALPHA_LIVE_PUBLISH_KEY/);
    assert.match(source, /onSnapshotChange: \(\) => ALPHA_LIVE_PUBLISHER\.publishNow\('config'\)/);
    assert.match(source, /ALPHA_LIVE_VOLUME_REVISION \+= 1/);
    assert.match(source, /limitObservedAt: Number\(LIMIT_MAP_CACHE/);
    assert.equal(count(source, /spot-tickers/g), count(original, /spot-tickers/g));
    assert.equal(count(source, /spot-market/g), count(original, /spot-market/g));
    assert.equal(count(source, /realtimePollMs:/g), count(original, /realtimePollMs:/g));
    assert.equal(count(source, /limitRefreshMs:/g), count(original, /limitRefreshMs:/g));
});
