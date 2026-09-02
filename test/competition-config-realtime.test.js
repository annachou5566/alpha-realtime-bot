'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    structuralProjection,
    patchProjection,
    createCompetitionConfigRealtimeControl,
} = require('./competition-config-realtime');

function makeSupabase() {
    let handler = null;
    let subscribeCb = null;
    const channel = {
        on(_kind, _filter, cb) { handler = cb; return channel; },
        subscribe(cb) { subscribeCb = cb; if (cb) cb('SUBSCRIBED'); return channel; },
    };
    return {
        client: {
            channel() { return channel; },
            async removeChannel() {},
        },
        emit(payload) { handler(payload); },
        status(value, error) { if (subscribeCb) subscribeCb(value, error); },
    };
}

function baseData() {
    return {
        alphaId: 'ALPHA_1',
        contract: '0xabc',
        chainId: 56,
        start: '2026-09-01',
        end: '2026-09-07',
        rewardQty: 100,
        history: [{ date: '2026-09-02', target: 1000 }],
        ai_prediction: { target: 1200, status_label: 'LIVE PREDICTION' },
        real_alpha_volume: 10,
        total_accumulated_volume: 20,
    };
}

test('structural projection ignores live/AI/history churn but catches real config changes', () => {
    const a = baseData();
    const b = { ...baseData(), real_alpha_volume: 999, history: [{ date: '2026-09-02', target: 2000 }], ai_prediction: { target: 2400 } };
    assert.deepEqual(structuralProjection(a), structuralProjection(b));
    assert.notDeepEqual(structuralProjection(a), structuralProjection({ ...b, end: '2026-09-08' }));
});

test('patch projection includes manual MinVol history and AI target surfaces', () => {
    const p = patchProjection({
        ...baseData(),
        min_vol: 777,
        minVol: 888,
        display_target: 999,
        display_prev_target: 555,
    });
    assert.equal(p.min_vol, 777);
    assert.equal(p.minVol, 888);
    assert.equal(p.history.at(-1).target, 1000);
    assert.equal(p.ai_prediction.target, 1200);
    assert.equal(p.display_target, 999);
});

test('volume-only update is ignored while MinVol/AI update emits one batched patch', () => {
    const mock = makeSupabase();
    let current = {
        config: baseData(),
        alphaId: 'ALPHA_1',
        rawRow: { id: 1, name: 'ONE', contract: '0xabc', data: baseData() },
    };
    const applied = [];
    const control = createCompetitionConfigRealtimeControl({
        supabase: mock.client,
        getCurrentByDbId: id => Number(id) === 1 ? current : null,
        applyPatch: (_row, patch) => {
            applied.push(patch);
            current = { ...current, config: { ...current.config, ...patch } };
        },
        rememberRow: row => { current = { ...current, rawRow: JSON.parse(JSON.stringify(row)) }; },
        refreshAll: async () => {},
        batchMs: 100,
    });
    control.start();

    mock.emit({ eventType: 'UPDATE', new: { id: 1, name: 'ONE', contract: '0xabc', data: { ...baseData(), real_alpha_volume: 12345 } } });
    control.flushPatches();
    assert.equal(control.snapshot().revision, 0);
    assert.equal(applied.length, 0);

    const changed = baseData();
    changed.history = [{ date: '2026-09-02', target: 2222 }];
    changed.ai_prediction = { target: 2600, status_label: 'LIVE PREDICTION' };
    changed.real_alpha_volume = 12345;
    mock.emit({ eventType: 'UPDATE', new: { id: 1, name: 'ONE', contract: '0xabc', data: changed } });
    control.flushPatches();

    const snap = control.snapshot();
    assert.equal(applied.length, 1);
    assert.equal(snap.revision, 1);
    assert.equal(snap.batches.length, 1);
    assert.equal(snap.batches[0].kind, 'patch');
    assert.equal(snap.batches[0].patches[0].history.at(-1).target, 2222);
    assert.equal(snap.batches[0].patches[0].aiPrediction.target, 2600);
    assert.equal(Object.prototype.hasOwnProperty.call(snap.batches[0].patches[0], 'minVol'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(snap.batches[0].patches[0], 'displayTarget'), false);
});

test('structural change coalesces into bounded full refresh event', async () => {
    const mock = makeSupabase();
    let refreshCount = 0;
    const control = createCompetitionConfigRealtimeControl({
        supabase: mock.client,
        getCurrentByDbId: id => Number(id) === 1 ? {
            alphaId: 'ALPHA_1',
            config: baseData(),
            rawRow: { id: 1, name: 'ONE', contract: '0xabc', data: baseData() },
        } : null,
        applyPatch: () => {},
        rememberRow: () => {},
        refreshAll: async () => { refreshCount += 1; },
        batchMs: 100,
    });
    control.start();
    mock.emit({ eventType: 'UPDATE', new: { id: 1, name: 'ONE', contract: '0xabc', data: { ...baseData(), end: '2026-09-09' } } });
    await new Promise(resolve => setTimeout(resolve, 180));
    const snap = control.snapshot();
    assert.equal(refreshCount, 1);
    assert.equal(snap.structuralRevision, 1);
    assert.equal(snap.batches.at(-1).kind, 'structural');
});

test('inactive/finalized row missing from ACTIVE_CONFIG does not cause structural churn', async () => {
    const mock = makeSupabase();
    let refreshCount = 0;
    const control = createCompetitionConfigRealtimeControl({
        supabase: mock.client,
        getCurrentByDbId: () => null,
        applyPatch: () => {},
        rememberRow: () => {},
        refreshAll: async () => { refreshCount += 1; },
        batchMs: 100,
    });
    control.start();
    const data = baseData();
    data.ai_prediction = { target: 1, status_label: 'FINALIZED' };
    mock.emit({ eventType: 'UPDATE', new: { id: 99, data } });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(refreshCount, 0);
    assert.equal(control.snapshot().revision, 0);
});
