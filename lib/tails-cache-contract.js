'use strict';

function expectedTailBoundaryDate(nowMs = Date.now()) {
    const day = new Date(nowMs);
    day.setUTCHours(0, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() - 1);
    return day.toISOString().slice(0, 10);
}

function metadataValue(metadata, key) {
    if (!metadata || typeof metadata !== 'object') return '';
    return String(metadata[key] ?? metadata[key.toLowerCase()] ?? '');
}

function validateTailsHead(head, nowMs = Date.now()) {
    const expectedBoundary = expectedTailBoundaryDate(nowMs);
    const metadata = head && head.Metadata || {};
    const schema = metadataValue(metadata, 'wa-schema');
    const boundary = metadataValue(metadata, 'boundary-date');
    const complete = metadataValue(metadata, 'complete');
    const payloadSha256 = metadataValue(metadata, 'payload-sha256').toLowerCase();
    const contentLength = Number(head && head.ContentLength);

    if (schema !== '2') {
        return { ok: false, reason: 'schema', expectedBoundary, boundary: boundary || null };
    }
    if (boundary !== expectedBoundary) {
        return { ok: false, reason: 'boundary', expectedBoundary, boundary: boundary || null };
    }
    if (complete !== 'true') {
        return { ok: false, reason: 'incomplete', expectedBoundary, boundary };
    }
    if (!/^[0-9a-f]{64}$/.test(payloadSha256)) {
        return { ok: false, reason: 'payload-hash', expectedBoundary, boundary };
    }
    if (!Number.isFinite(contentLength) || contentLength <= 0) {
        return { ok: false, reason: 'content-length', expectedBoundary, boundary };
    }

    return {
        ok: true,
        expectedBoundary,
        boundary,
        payloadSha256,
        contentLength,
    };
}

function validateTailsPayload(data, nowMs = Date.now()) {
    const expectedBoundary = expectedTailBoundaryDate(nowMs);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { ok: false, reason: 'payload-type', expectedBoundary };
    }
    if (Number(data.schema_version) !== 2) {
        return { ok: false, reason: 'schema', expectedBoundary };
    }
    if (data.complete !== true) {
        return { ok: false, reason: 'incomplete', expectedBoundary };
    }
    if (String(data.boundary_date || '') !== expectedBoundary) {
        return {
            ok: false,
            reason: 'boundary',
            expectedBoundary,
            boundary: data.boundary_date || null,
        };
    }

    const generatedAt = Date.parse(String(data.generated_at || ''));
    if (!Number.isFinite(generatedAt)) {
        return { ok: false, reason: 'generated-at', expectedBoundary };
    }
    if (generatedAt > nowMs + 5 * 60_000) {
        return { ok: false, reason: 'generated-at-future', expectedBoundary };
    }
    if (nowMs - generatedAt > 36 * 60 * 60_000) {
        return { ok: false, reason: 'generated-at-stale', expectedBoundary };
    }

    if (!data.total || typeof data.total !== 'object' || Array.isArray(data.total)) {
        return { ok: false, reason: 'total-map', expectedBoundary };
    }
    if (!data.limit || typeof data.limit !== 'object' || Array.isArray(data.limit)) {
        return { ok: false, reason: 'limit-map', expectedBoundary };
    }

    const expectedCount = Number(data.expected_token_count);
    const coveredTotalCount = Number(data.covered_total_count);
    const expectedLimitCount = Number(data.expected_limit_token_count);
    const coveredLimitCount = Number(data.covered_limit_count);

    if (!Number.isInteger(expectedCount) || expectedCount <= 0) {
        return { ok: false, reason: 'expected-count', expectedBoundary };
    }
    if (coveredTotalCount !== expectedCount || Object.keys(data.total).length !== expectedCount) {
        return { ok: false, reason: 'total-coverage', expectedBoundary };
    }
    if (!Number.isInteger(expectedLimitCount) || expectedLimitCount < 0) {
        return { ok: false, reason: 'expected-limit-count', expectedBoundary };
    }
    if (coveredLimitCount !== expectedLimitCount) {
        return { ok: false, reason: 'limit-coverage', expectedBoundary };
    }

    const hashFields = [
        data.expected_ids_hash,
        data.covered_total_ids_hash,
        data.expected_limit_ids_hash,
        data.covered_limit_ids_hash,
    ].map(value => String(value || '').toLowerCase());

    if (hashFields.some(value => !/^[0-9a-f]{64}$/.test(value))) {
        return { ok: false, reason: 'coverage-hash', expectedBoundary };
    }
    if (hashFields[0] !== hashFields[1] || hashFields[2] !== hashFields[3]) {
        return { ok: false, reason: 'coverage-hash-mismatch', expectedBoundary };
    }

    for (const series of Object.values(data.total)) {
        if (!Array.isArray(series) || series.length !== 1440) {
            return { ok: false, reason: 'total-series-shape', expectedBoundary };
        }
    }

    return {
        ok: true,
        expectedBoundary,
        boundary: expectedBoundary,
        generatedAt,
    };
}

function currentTailValue(state, map, id, minute, nowMs = Date.now()) {
    if (!state || state.available !== true) return null;
    if (state.boundaryDate !== expectedTailBoundaryDate(nowMs)) return null;
    if (!Number.isInteger(minute) || minute < 0 || minute >= 1440) return null;
    const series = map && map[id];
    if (!Array.isArray(series) || series.length !== 1440) return null;
    const raw = series[minute];
    if (raw === null || raw === undefined || raw === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
}

function finiteNumberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

module.exports = {
    expectedTailBoundaryDate,
    validateTailsHead,
    validateTailsPayload,
    currentTailValue,
    finiteNumberOrNull,
};
