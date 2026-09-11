'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { competitionWindowState } = require('../lib/competition-active-window');

const r1 = { start: '2026-09-10', startTime: '13:00', end: '2026-09-17', endTime: '13:00' };
const r2 = { start: '2026-09-17', startTime: '13:00', end: '2026-09-24', endTime: '13:00' };

test('DEBIT seam is half-open: R1 history and R2 active at exact boundary', () => {
    const seam = Date.parse('2026-09-17T13:00:00Z');
    assert.equal(competitionWindowState(r1, seam).state, 'history');
    assert.equal(competitionWindowState(r2, seam).state, 'active');
});

test('future round is excluded until exact start', () => {
    const before = Date.parse('2026-09-17T12:59:59.999Z');
    assert.equal(competitionWindowState(r2, before).state, 'future');
});

test('finalized row is history regardless of dates', () => {
    assert.equal(competitionWindowState({ ...r2, ai_prediction: { status_label: 'FINALIZED' } }, Date.parse('2026-09-18T00:00:00Z')).state, 'history');
});

test('legacy end-only row remains active until its end and then history', () => {
    const row = { end: '2026-09-20', endTime: '13:00' };
    assert.equal(competitionWindowState(row, Date.parse('2026-09-20T12:59:59Z')).state, 'active');
    assert.equal(competitionWindowState(row, Date.parse('2026-09-20T13:00:00Z')).state, 'history');
});

test('unscheduled legacy row remains compatible active', () => {
    assert.equal(competitionWindowState({}, Date.now()).state, 'active');
});

test('malformed or non-positive explicit schedule fails closed', () => {
    assert.equal(competitionWindowState({ start: 'bad', end: '2026-09-20' }).state, 'invalid');
    assert.equal(competitionWindowState({ start: '2026-09-20', startTime: '13:00', end: '2026-09-20', endTime: '12:00' }).state, 'invalid');
});
