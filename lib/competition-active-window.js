'use strict';

function parseUtcBoundary(dateValue, timeValue, fallbackTime) {
    const date = String(dateValue || '').trim();
    if (!date) return null;
    let time = String(timeValue || fallbackTime || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Number.NaN;
    if (!time) return Number.NaN;
    if (/^\d{2}:\d{2}$/.test(time)) time += ':00';
    if (!/^\d{2}:\d{2}:\d{2}$/.test(time)) return Number.NaN;
    const value = Date.parse(`${date}T${time}Z`);
    return Number.isFinite(value) ? value : Number.NaN;
}

function competitionWindowState(meta, nowMs = Date.now()) {
    const data = meta && typeof meta === 'object' ? meta : {};
    if (String(data.ai_prediction && data.ai_prediction.status_label || '').toUpperCase() === 'FINALIZED') {
        return { state: 'history', reason: 'finalized', startAt: null, endAt: null };
    }

    const hasStart = data.start !== undefined && data.start !== null && String(data.start).trim() !== '';
    const hasEnd = data.end !== undefined && data.end !== null && String(data.end).trim() !== '';
    const startAt = hasStart ? parseUtcBoundary(data.start, data.startTime, '00:00:00') : null;
    const endAt = hasEnd ? parseUtcBoundary(data.end, data.endTime, '23:59:59') : null;

    if ((hasStart && !Number.isFinite(startAt)) || (hasEnd && !Number.isFinite(endAt))) {
        return { state: 'invalid', reason: 'malformed-schedule', startAt, endAt };
    }
    if (Number.isFinite(startAt) && Number.isFinite(endAt) && endAt <= startAt) {
        return { state: 'invalid', reason: 'non-positive-window', startAt, endAt };
    }
    if (Number.isFinite(startAt) && nowMs < startAt) {
        return { state: 'future', reason: 'before-start', startAt, endAt };
    }
    if (Number.isFinite(endAt) && nowMs >= endAt) {
        return { state: 'history', reason: 'at-or-after-end', startAt, endAt };
    }
    return {
        state: 'active',
        reason: Number.isFinite(startAt) || Number.isFinite(endAt) ? 'inside-window' : 'legacy-unscheduled',
        startAt,
        endAt,
    };
}

module.exports = {
    parseUtcBoundary,
    competitionWindowState,
};
