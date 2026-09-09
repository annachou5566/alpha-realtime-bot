'use strict';

const crypto = require('node:crypto');

function stableIdsHash(ids) {
    return crypto
        .createHash('sha256')
        .update([...ids].map(String).sort().join('\n'), 'utf8')
        .digest('hex');
}

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

function validateTailsHeadForSource(head, options = {}) {
    const nowMs = options.nowMs ?? Date.now();
    const key = String(options.key || 'tails_cache.json');
    const expectedPayloadSha256 = String(options.expectedPayloadSha256 || '')
        .trim()
        .toLowerCase();

    if (key === 'tails_cache.json') {
        return {
            ...validateTailsHead(head, nowMs),
            sourceMode: 'live-metadata',
        };
    }

    if (!/^[0-9a-f]{64}$/.test(expectedPayloadSha256)) {
        return {
            ok: false,
            reason: 'pinned-payload-hash-required',
            expectedBoundary: expectedTailBoundaryDate(nowMs),
            boundary: null,
            sourceMode: 'pinned-shadow',
        };
    }

    const contentLength = Number(head && head.ContentLength);
    if (!Number.isFinite(contentLength) || contentLength <= 0) {
        return {
            ok: false,
            reason: 'content-length',
            expectedBoundary: expectedTailBoundaryDate(nowMs),
            boundary: null,
            sourceMode: 'pinned-shadow',
        };
    }

    const metadataContract = validateTailsHead(head, nowMs);
    if (
        metadataContract.ok
        && metadataContract.payloadSha256 !== expectedPayloadSha256
    ) {
        return {
            ok: false,
            reason: 'pinned-payload-hash-mismatch',
            expectedBoundary: metadataContract.expectedBoundary,
            boundary: metadataContract.boundary,
            sourceMode: 'pinned-shadow',
        };
    }

    return {
        ok: true,
        expectedBoundary: expectedTailBoundaryDate(nowMs),
        boundary: metadataContract.ok ? metadataContract.boundary : null,
        payloadSha256: expectedPayloadSha256,
        contentLength,
        sourceMode: 'pinned-shadow',
        metadataValidated: metadataContract.ok,
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

    const expectedWindowStart = Date.parse(`${expectedBoundary}T00:00:00Z`);
    const expectedWindowEnd = expectedWindowStart + 24 * 60 * 60 * 1000 - 1;
    const windowStart = Date.parse(String(data.window_start || ''));
    const windowEnd = Date.parse(String(data.window_end || ''));
    if (windowStart !== expectedWindowStart || windowEnd !== expectedWindowEnd) {
        return { ok: false, reason: 'window', expectedBoundary };
    }

    const generatedAt = Date.parse(String(data.generated_at || ''));
    if (!Number.isFinite(generatedAt)) {
        return { ok: false, reason: 'generated-at', expectedBoundary };
    }
    if (generatedAt < expectedWindowEnd) {
        return { ok: false, reason: 'generated-at-before-window-end', expectedBoundary };
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
    const limitApplicableCount = Number(data.limit_applicable_token_count);
    const classifiedLimitCount = Number(data.classified_limit_token_count);
    const expectedLimitCount = Number(data.expected_limit_token_count);
    const coveredLimitCount = Number(data.covered_limit_count);
    const unsupportedLimitCount = Number(data.unsupported_limit_token_count);
    const unsupportedLimitIds = Array.isArray(data.unsupported_limit_ids)
        ? data.unsupported_limit_ids.map(String)
        : null;

    if (!Number.isInteger(expectedCount) || expectedCount <= 0) {
        return { ok: false, reason: 'expected-count', expectedBoundary };
    }
    if (coveredTotalCount !== expectedCount || Object.keys(data.total).length !== expectedCount) {
        return { ok: false, reason: 'total-coverage', expectedBoundary };
    }

    for (const [name, value] of [
        ['limit-applicable-count', limitApplicableCount],
        ['classified-limit-count', classifiedLimitCount],
        ['expected-limit-count', expectedLimitCount],
        ['covered-limit-count', coveredLimitCount],
        ['unsupported-limit-count', unsupportedLimitCount],
    ]) {
        if (!Number.isInteger(value) || value < 0) {
            return { ok: false, reason: name, expectedBoundary };
        }
    }

    if (!unsupportedLimitIds) {
        return { ok: false, reason: 'unsupported-limit-ids', expectedBoundary };
    }
    if (
        unsupportedLimitIds.length !== unsupportedLimitCount
        || new Set(unsupportedLimitIds).size !== unsupportedLimitIds.length
        || unsupportedLimitIds.some(id => !id)
    ) {
        return { ok: false, reason: 'unsupported-limit-coverage', expectedBoundary };
    }

    if (
        coveredLimitCount !== expectedLimitCount
        || Object.keys(data.limit).length !== expectedLimitCount
    ) {
        return { ok: false, reason: 'limit-coverage', expectedBoundary };
    }
    if (
        expectedLimitCount + unsupportedLimitCount !== limitApplicableCount
        || classifiedLimitCount !== limitApplicableCount
    ) {
        return { ok: false, reason: 'limit-capability-count-partition', expectedBoundary };
    }

    const hashFields = [
        data.expected_ids_hash,
        data.covered_total_ids_hash,
        data.limit_applicable_ids_hash,
        data.classified_limit_ids_hash,
        data.expected_limit_ids_hash,
        data.covered_limit_ids_hash,
        data.unsupported_limit_ids_hash,
    ].map(value => String(value || '').toLowerCase());

    if (hashFields.some(value => !/^[0-9a-f]{64}$/.test(value))) {
        return { ok: false, reason: 'coverage-hash', expectedBoundary };
    }
    if (
        hashFields[0] !== hashFields[1]
        || hashFields[2] !== hashFields[3]
        || hashFields[4] !== hashFields[5]
    ) {
        return { ok: false, reason: 'coverage-hash-mismatch', expectedBoundary };
    }

    const actualTotalIds = Object.keys(data.total);
    const actualLimitIds = Object.keys(data.limit);
    const actualTotalSet = new Set(actualTotalIds);
    const actualLimitSet = new Set(actualLimitIds);
    const unsupportedSet = new Set(unsupportedLimitIds);

    if ([...actualLimitSet].some(id => unsupportedSet.has(id))) {
        return { ok: false, reason: 'limit-capability-overlap', expectedBoundary };
    }
    const classifiedIds = [...actualLimitSet, ...unsupportedSet];
    if (classifiedIds.some(id => !actualTotalSet.has(id))) {
        return { ok: false, reason: 'limit-capability-not-total-subset', expectedBoundary };
    }
    if (new Set(classifiedIds).size !== limitApplicableCount) {
        return { ok: false, reason: 'limit-capability-classified-size', expectedBoundary };
    }

    const actualTotalHash = stableIdsHash(actualTotalIds);
    const actualLimitHash = stableIdsHash(actualLimitIds);
    const actualUnsupportedHash = stableIdsHash(unsupportedLimitIds);
    const actualClassifiedHash = stableIdsHash(classifiedIds);

    if (hashFields[0] !== actualTotalHash || hashFields[1] !== actualTotalHash) {
        return { ok: false, reason: 'total-keys-hash', expectedBoundary };
    }
    if (hashFields[4] !== actualLimitHash || hashFields[5] !== actualLimitHash) {
        return { ok: false, reason: 'limit-keys-hash', expectedBoundary };
    }
    if (hashFields[6] !== actualUnsupportedHash) {
        return { ok: false, reason: 'unsupported-limit-ids-hash', expectedBoundary };
    }
    if (hashFields[2] !== actualClassifiedHash || hashFields[3] !== actualClassifiedHash) {
        return { ok: false, reason: 'limit-applicable-ids-hash', expectedBoundary };
    }

    for (const series of Object.values(data.total)) {
        if (!Array.isArray(series) || series.length !== 1440) {
            return { ok: false, reason: 'total-series-shape', expectedBoundary };
        }
    }
    for (const series of Object.values(data.limit)) {
        if (!Array.isArray(series) || series.length !== 1440) {
            return { ok: false, reason: 'limit-series-shape', expectedBoundary };
        }
    }

    return {
        ok: true,
        expectedBoundary,
        boundary: expectedBoundary,
        generatedAt,
        unsupportedLimitIds,
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
    stableIdsHash,
    expectedTailBoundaryDate,
    validateTailsHead,
    validateTailsHeadForSource,
    validateTailsPayload,
    currentTailValue,
    finiteNumberOrNull,
};
