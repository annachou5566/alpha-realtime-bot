'use strict';

const {
    canonicalMachineMessage,
    digestHex,
    hmacHex,
    stableJson,
} = require('./alpha-live-publisher');

const DEFAULT_TIMEOUT_MS = 5000;

function normalizePublishUrl(value) {
    try {
        const url = new URL(String(value || '').trim());
        const host = url.hostname.toLowerCase();
        if (url.protocol !== 'https:') return '';
        if (url.pathname !== '/api/alpha-live-publish') return '';
        if (url.search || url.hash) return '';
        if (host !== 'wave-alpha.pages.dev' && !host.endsWith('.wave-alpha.pages.dev')) return '';
        url.pathname = '/api/competition-price-series-publish';
        return url.toString();
    } catch (_) {
        return '';
    }
}

function exactSnapshot(cache) {
    const data = {};
    const entries = Object.entries(cache && typeof cache === 'object' ? cache : {})
        .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
        .slice(0, 250);

    for (const [id, series] of entries) {
        if (!/^\d{1,9}$/.test(id)) continue;
        if (!series || Number(series.version) !== 3 || series.boundaryModel !== 'dual') continue;
        const startAt = Number(series.startAt);
        const endAt = Number(series.endAt);
        if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || !(endAt > startAt)) continue;

        const points = (Array.isArray(series.points) ? series.points : [])
            .filter(point => {
                const boundaryAt = Number(point && point.boundaryAt);
                const observedAt = Number(point && point.observedAt);
                const price = Number(point && point.price);
                const driftMs = Number(point && point.driftMs);
                return point
                    && point.quality === 'exact'
                    && driftMs === 0
                    && observedAt === boundaryAt
                    && Number.isFinite(boundaryAt)
                    && boundaryAt >= startAt
                    && boundaryAt <= endAt
                    && price > 0;
            })
            .sort((a, b) => Number(a.boundaryAt) - Number(b.boundaryAt));

        data[id] = {
            ...series,
            id,
            points,
        };
    }
    return data;
}

function createCompetitionPriceSeriesPublisher(options = {}) {
    const url = normalizePublishUrl(options.livePublishUrl);
    const key = String(options.key || '');
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const logger = options.logger || console;
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const timeoutMs = Math.max(1000, Math.min(15000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
    const enabled = Boolean(url && Buffer.byteLength(key) >= 32 && typeof fetchImpl === 'function');

    let lastSuccessfulHash = '';
    let attempts = 0;
    let successes = 0;
    let duplicateSkips = 0;
    let lastSuccessAt = null;
    let lastError = null;

    async function publishSnapshot(cache) {
        if (!enabled) throw new Error('Competition Price machine publisher unavailable');

        const data = exactSnapshot(cache);
        const sourceHash = digestHex(data);
        if (sourceHash === lastSuccessfulHash) {
            duplicateSkips += 1;
            return false;
        }

        const body = JSON.stringify({
            schema: 1,
            updatedAt: Math.trunc(now()),
            sourceHash,
            data,
        });
        const timestamp = Math.trunc(now());
        const pathname = new URL(url).pathname;
        const signature = hmacHex(key, canonicalMachineMessage({
            timestamp,
            method: 'POST',
            pathname,
            body,
        }));

        attempts += 1;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-wave-timestamp': String(timestamp),
                    'x-wave-signature': `sha256=${signature}`,
                },
                body,
                signal: controller.signal,
                redirect: 'error',
            });
            if (!response || !response.ok) {
                throw new Error(`HTTP ${response && response.status ? response.status : 'ERR'}`);
            }
            lastSuccessfulHash = sourceHash;
            successes += 1;
            lastSuccessAt = new Date(now()).toISOString();
            lastError = null;
            return true;
        } catch (error) {
            lastError = error && error.name === 'AbortError'
                ? 'timeout'
                : (error && error.message ? error.message : 'publish failed');
            logger.warn('[COMPETITION-PRICE] machine publish failed:', lastError);
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    function telemetry() {
        return {
            enabled,
            attempts,
            successes,
            duplicateSkips,
            lastSuccessAt,
            lastError,
        };
    }

    return {
        enabled,
        publishSnapshot,
        telemetry,
    };
}

module.exports = {
    normalizePublishUrl,
    exactSnapshot,
    createCompetitionPriceSeriesPublisher,
};
