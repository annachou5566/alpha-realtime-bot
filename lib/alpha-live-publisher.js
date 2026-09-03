'use strict';

const { createHash } = require('crypto');

const DEFAULT_TIMEOUT_MS = 5000;

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    Object.keys(value).sort().forEach(key => {
        out[key] = stableValue(value[key]);
    });
    return out;
}

function stableJson(value) {
    return JSON.stringify(stableValue(value));
}

function digestHex(value) {
    return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
}

function normalizePublishUrl(value) {
    try {
        const url = new URL(String(value || '').trim());
        const host = url.hostname.toLowerCase();
        if (url.protocol !== 'https:') return '';
        if (url.pathname !== '/api/alpha-live-publish') return '';
        if (url.search || url.hash) return '';
        if (host !== 'wave-alpha.pages.dev' && !host.endsWith('.wave-alpha.pages.dev')) return '';
        return url.toString();
    } catch (_) {
        return '';
    }
}

function createAlphaLivePublisher(options = {}) {
    const url = normalizePublishUrl(options.url);
    const key = String(options.key || '');
    const getSnapshot = options.getSnapshot;
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const logger = options.logger || console;
    const timeoutMs = Math.max(1000, Math.min(15000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
    const enabled = Boolean(
        url &&
        Buffer.byteLength(key) >= 32 &&
        typeof getSnapshot === 'function' &&
        typeof fetchImpl === 'function'
    );

    let inFlight = null;
    let rerunRequested = false;
    let lastSuccessfulHash = '';
    let lastSuccessAt = null;
    let lastError = null;
    let attempts = 0;
    let successes = 0;
    let duplicateSkips = 0;

    async function buildEnvelope() {
        const snapshot = await getSnapshot();
        if (!snapshot || typeof snapshot !== 'object') return null;
        const configSignal = snapshot.configSignal && typeof snapshot.configSignal === 'object'
            ? snapshot.configSignal
            : null;
        const volume = snapshot.volume && typeof snapshot.volume === 'object'
            ? snapshot.volume
            : null;
        if (!configSignal && !volume) return null;

        const sourceHash = digestHex({ configSignal, volume });
        return {
            schema: 1,
            observedAt: Date.now(),
            sourceHash,
            configSignal,
            volume,
        };
    }

    async function publishOnce() {
        if (!enabled) return false;
        const envelope = await buildEnvelope();
        if (!envelope) return false;
        if (envelope.sourceHash === lastSuccessfulHash) {
            duplicateSkips += 1;
            return false;
        }

        attempts += 1;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(envelope),
                signal: controller.signal,
                redirect: 'error',
            });
            if (!response || !response.ok) {
                throw new Error(`HTTP ${response && response.status ? response.status : 'ERR'}`);
            }
            lastSuccessfulHash = envelope.sourceHash;
            lastSuccessAt = new Date().toISOString();
            lastError = null;
            successes += 1;
            return true;
        } catch (error) {
            lastError = error && error.name === 'AbortError'
                ? 'timeout'
                : (error && error.message ? error.message : 'publish failed');
            logger.warn('[ALPHA-LIVE] publish failed:', lastError);
            return false;
        } finally {
            clearTimeout(timer);
        }
    }

    async function drain() {
        do {
            rerunRequested = false;
            await publishOnce();
        } while (rerunRequested);
    }

    function publishNow() {
        if (!enabled) return Promise.resolve(false);
        if (inFlight) {
            rerunRequested = true;
            return inFlight;
        }
        inFlight = drain().finally(() => {
            inFlight = null;
        });
        return inFlight;
    }

    function telemetry() {
        return {
            enabled,
            inFlight: Boolean(inFlight),
            rerunRequested,
            attempts,
            successes,
            duplicateSkips,
            lastSuccessAt,
            lastError,
        };
    }

    return {
        enabled,
        publishNow,
        telemetry,
    };
}

module.exports = {
    stableValue,
    stableJson,
    digestHex,
    normalizePublishUrl,
    createAlphaLivePublisher,
};
