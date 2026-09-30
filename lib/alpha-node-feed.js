'use strict';

const ALPHA_NODE_READ_RPC = 'wave_alpha_node_feed_read';
const DEFAULT_ALPHA_NODE_LIMIT = 30;
const MAX_ALPHA_NODE_LIMIT = 50;
const RECORD_ID_RE = /^alpha-forecast-receipt:[1-9][0-9]*$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const HASH_RE = /^0x[0-9a-f]{64}$/;
const POOL_ID_RE = /^0x[0-9a-f]{64}$/;

const SOURCE_CLASS_BY_KIND = Object.freeze({
    POOL_SCHEDULE_CAPTURE: 'APPROVED_POOL_SCHEDULE_CAPTURE_RECEIPT',
    EXTERNAL_ADVISORY_OBSERVATION: 'APPROVED_EXTERNAL_ADVISORY_RECEIPT',
    FORECAST_ARTIFACT: 'APPROVED_PERSISTENCE_SERVER_RECEIPT',
    DIRECT_CHAIN_CAPTURE: 'APPROVED_DIRECT_CHAIN_CAPTURE_RECEIPT',
});

function safePositiveInteger(value, name, max = Number.MAX_SAFE_INTEGER) {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 1 || n > max) {
        throw new Error(`${name} invalid`);
    }
    return n;
}

function iso(value, name) {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) throw new Error(`${name} invalid`);
    return new Date(ms).toISOString();
}

function lowerHex(value, re, name) {
    const out = String(value ?? '').trim().toLowerCase();
    if (!re.test(out)) throw new Error(`${name} invalid`);
    return out;
}

function optionalText(value) {
    const out = String(value ?? '').trim();
    return out || null;
}

function parseAlphaNodeQuery(query = {}) {
    const rawLimit = query.limit;
    const limit = rawLimit == null || rawLimit === ''
        ? DEFAULT_ALPHA_NODE_LIMIT
        : safePositiveInteger(rawLimit, 'limit', MAX_ALPHA_NODE_LIMIT);

    let beforeId = null;
    if (query.before != null && String(query.before).trim() !== '') {
        beforeId = safePositiveInteger(query.before, 'before');
    }

    return Object.freeze({
        limit,
        beforeId,
        rpcArgs: Object.freeze({
            p_limit: limit,
            p_before_id: beforeId,
        }),
    });
}

function baseReceipt(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('feed row invalid');
    const receiptId = safePositiveInteger(row.receiptId, 'receiptId');
    const immutableRecordId = String(row.immutableRecordId ?? '').trim();
    if (!RECORD_ID_RE.test(immutableRecordId)
        || immutableRecordId !== `alpha-forecast-receipt:${receiptId}`) {
        throw new Error('immutableRecordId invalid');
    }

    const receiptKind = String(row.receiptKind ?? '').trim();
    const sourceClass = String(row.sourceClass ?? '').trim();
    if (!SOURCE_CLASS_BY_KIND[receiptKind]) throw new Error('receiptKind unsupported');
    if (SOURCE_CLASS_BY_KIND[receiptKind] !== sourceClass) throw new Error('sourceClass mismatch');

    const serverRecordedAt = iso(row.serverRecordedAt, 'serverRecordedAt');
    const data = row.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('feed data invalid');

    return { receiptId, immutableRecordId, receiptKind, sourceClass, serverRecordedAt, data };
}

function mapPoolSchedule(base) {
    const { data, serverRecordedAt } = base;
    const action = String(data.scheduleAction ?? '').trim();
    if (!['POOL_SCHEDULE_SET_OR_RESCHEDULED', 'POOL_SCHEDULE_CLEARED'].includes(action)) {
        throw new Error('pool schedule action invalid');
    }

    const poolId = lowerHex(data.poolId, POOL_ID_RE, 'poolId');
    const emitter = lowerHex(data.emitter, ADDRESS_RE, 'emitter');
    const operator = lowerHex(data.operator, ADDRESS_RE, 'operator');
    const txHash = lowerHex(data.txHash, HASH_RE, 'txHash');
    const blockNumber = safePositiveInteger(data.blockNumber, 'blockNumber');
    const logIndex = Number(data.logIndex);
    if (!Number.isSafeInteger(logIndex) || logIndex < 0) throw new Error('logIndex invalid');
    const chainEventAt = iso(data.chainEventAt, 'chainEventAt');

    let eventAt = null;
    let leadTimeSeconds = null;
    let eventType;
    let title;
    let whyItMatters;

    if (action === 'POOL_SCHEDULE_CLEARED') {
        if (data.eventAt != null) throw new Error('cleared pool eventAt must be null');
        eventType = 'POOL_SCHEDULE_CLEARED';
        title = 'Pool schedule cleared';
        whyItMatters = 'A qualified Pool Schedule contract signal cleared a previously scheduled event.';
    } else {
        eventAt = iso(data.eventAt, 'eventAt');
        leadTimeSeconds = Math.trunc((Date.parse(eventAt) - Date.parse(serverRecordedAt)) / 1000);
        eventType = 'POOL_SCHEDULED_OR_RESCHEDULED';
        title = 'Pool scheduled or rescheduled';
        whyItMatters = 'A qualified Pool Schedule contract signal exposed an event time before or during the event lifecycle.';
    }

    return {
        eventType,
        title,
        occurredAt: chainEventAt,
        observedAt: serverRecordedAt,
        eventAt,
        leadTimeSeconds,
        source: 'DIRECT_CHAIN_POOL_SCHEDULE',
        waveForecastRank: null,
        tokenContract: null,
        tokenSymbol: null,
        projectName: null,
        poolId,
        evidence: {
            emitter,
            operator,
            txHash,
            blockNumber,
            logIndex,
        },
        whyItMatters,
    };
}

function mapExternalAdvisory(base) {
    const { data, serverRecordedAt } = base;
    const sourceChannel = String(data.sourceChannel ?? '').trim();
    const sourceObservationId = String(data.sourceObservationId ?? '').trim();
    if (sourceChannel !== 'alpha123en' || !/^alpha123en:[1-9][0-9]*$/.test(sourceObservationId)) {
        throw new Error('external advisory identity invalid');
    }

    const sourcePublishedAt = iso(data.sourcePublishedAt, 'sourcePublishedAt');
    const waveObservedAt = iso(data.waveObservedAt, 'waveObservedAt');
    if (Date.parse(waveObservedAt) < Date.parse(sourcePublishedAt)
        || Date.parse(serverRecordedAt) < Date.parse(waveObservedAt)) {
        throw new Error('external advisory chronology invalid');
    }

    const contract = data.contract == null
        ? null
        : lowerHex(data.contract, ADDRESS_RE, 'external contract');
    const eventAt = data.eventAt == null ? null : iso(data.eventAt, 'external eventAt');

    return {
        eventType: 'EXTERNAL_ADVISORY_OBSERVED',
        title: 'External advisory observed',
        occurredAt: sourcePublishedAt,
        observedAt: serverRecordedAt,
        eventAt,
        leadTimeSeconds: eventAt == null
            ? null
            : Math.trunc((Date.parse(eventAt) - Date.parse(serverRecordedAt)) / 1000),
        source: 'EXTERNAL_ADVISORY',
        waveForecastRank: null,
        tokenContract: contract,
        tokenSymbol: optionalText(data.symbol),
        projectName: optionalText(data.projectName),
        poolId: null,
        evidence: {
            sourceChannel,
            sourceObservationId,
            sourceUrl: optionalText(data.sourceUrl),
            sourceMessageType: optionalText(data.sourceMessageType),
            externalPrediction: data.externalPrediction === true,
        },
        whyItMatters: 'An external source was recorded as attributed evidence; it is not a Wave independent prediction.',
    };
}

function mapForecastArtifact(base) {
    const { data, serverRecordedAt } = base;
    const tokenContract = lowerHex(data.tokenContract, ADDRESS_RE, 'forecast tokenContract');
    const rank = String(data.rank ?? '').trim();
    if (!['NO_SIGNAL','WATCH_ONLY','CANDIDATE','STRONG_CANDIDATE','SUPPRESSED_NEGATIVE_CONTROL','FAIL_CLOSED'].includes(rank)) {
        throw new Error('forecast rank invalid');
    }
    const revisionNumber = Number(data.revisionNumber);
    if (!Number.isSafeInteger(revisionNumber) || revisionNumber < 0) throw new Error('revisionNumber invalid');
    const evidenceObservedThrough = iso(data.evidenceObservedThrough, 'evidenceObservedThrough');
    if (Date.parse(evidenceObservedThrough) > Date.parse(serverRecordedAt)) {
        throw new Error('forecast evidence time exceeds receipt time');
    }

    return {
        eventType: 'FORECAST_ARTIFACT_RECORDED',
        title: 'Wave forecast artifact recorded',
        occurredAt: evidenceObservedThrough,
        observedAt: serverRecordedAt,
        eventAt: null,
        leadTimeSeconds: null,
        source: 'WAVE_FORECAST_ARTIFACT',
        waveForecastRank: rank,
        tokenContract,
        tokenSymbol: null,
        projectName: null,
        poolId: null,
        evidence: {
            chainId: String(data.chainId ?? '').trim(),
            revisionNumber,
        },
        whyItMatters: rank === 'WATCH_ONLY'
            ? 'Wave recorded watch-only evidence. This is not a prediction.'
            : 'Wave persisted its current forecast classification from canonical evidence.',
    };
}

function mapDirectChain(base) {
    const { data, serverRecordedAt } = base;
    const chainEventAt = iso(data.chainEventAt, 'direct chainEventAt');
    const providerId = String(data.providerId ?? '').trim();
    const chainKey = String(data.chainKey ?? '').trim();
    const finality = String(data.finality ?? '').trim();
    if (!providerId || chainKey !== 'bsc' || finality !== 'BSC_FINALIZED_TAG_CONFIRMED') {
        throw new Error('direct-chain binding invalid');
    }

    return {
        eventType: 'DIRECT_CHAIN_CAPTURED',
        title: 'Qualified direct-chain evidence captured',
        occurredAt: chainEventAt,
        observedAt: serverRecordedAt,
        eventAt: null,
        leadTimeSeconds: null,
        source: 'DIRECT_CHAIN',
        waveForecastRank: null,
        tokenContract: null,
        tokenSymbol: null,
        projectName: null,
        poolId: null,
        evidence: { providerId, chainKey, finality },
        whyItMatters: 'Wave captured finalized chain evidence. Token, transfer and amount details are intentionally not inferred from this receipt.',
    };
}

function mapAlphaNodeReceipt(row) {
    const base = baseReceipt(row);
    let projected;

    if (base.receiptKind === 'POOL_SCHEDULE_CAPTURE') projected = mapPoolSchedule(base);
    else if (base.receiptKind === 'EXTERNAL_ADVISORY_OBSERVATION') projected = mapExternalAdvisory(base);
    else if (base.receiptKind === 'FORECAST_ARTIFACT') projected = mapForecastArtifact(base);
    else projected = mapDirectChain(base);

    return Object.freeze({
        receiptId: base.receiptId,
        immutableRecordId: base.immutableRecordId,
        receiptKind: base.receiptKind,
        sourceClass: base.sourceClass,
        ...projected,
    });
}

function projectAlphaNodeRpcResponse(payload, requestedLimit = MAX_ALPHA_NODE_LIMIT) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('alpha node RPC payload invalid');
    }
    if (Number(payload.schemaVersion) !== 1) throw new Error('alpha node RPC schemaVersion invalid');
    if (!Array.isArray(payload.items)) throw new Error('alpha node RPC items invalid');

    const limit = safePositiveInteger(requestedLimit, 'requestedLimit', MAX_ALPHA_NODE_LIMIT);
    if (payload.items.length > limit) throw new Error('alpha node RPC exceeded requested limit');

    const items = payload.items.map(mapAlphaNodeReceipt);
    const ids = items.map((item) => item.receiptId);
    if (new Set(ids).size !== ids.length) throw new Error('alpha node RPC duplicate receiptId');
    for (let i = 1; i < ids.length; i += 1) {
        if (ids[i] >= ids[i - 1]) throw new Error('alpha node RPC ordering invalid');
    }

    if (typeof payload.hasMore !== 'boolean') throw new Error('alpha node RPC hasMore invalid');
    let nextBeforeId = null;
    if (payload.nextBeforeId != null) {
        nextBeforeId = safePositiveInteger(payload.nextBeforeId, 'nextBeforeId');
        if (ids.length && nextBeforeId > ids[ids.length - 1]) {
            throw new Error('nextBeforeId invalid');
        }
    }

    return Object.freeze({
        schemaVersion: 1,
        items: Object.freeze(items),
        hasMore: payload.hasMore,
        nextBeforeId,
    });
}

function createAlphaNodeFeedHandler({ supabase, logger = console } = {}) {
    if (!supabase || typeof supabase.rpc !== 'function') throw new Error('supabase RPC client required');

    return async function alphaNodeFeedHandler(req, res) {
        let query;
        try {
            query = parseAlphaNodeQuery(req?.query || {});
        } catch (error) {
            return res.status(400).json({ success: false, error: error.message });
        }

        try {
            const { data, error } = await supabase.rpc(ALPHA_NODE_READ_RPC, query.rpcArgs);
            if (error) throw new Error(`alpha node read RPC failed: ${error.message || 'unknown'}`);
            const projected = projectAlphaNodeRpcResponse(data, query.limit);
            res.setHeader('Cache-Control', 'public, max-age=15, s-maxage=30, stale-while-revalidate=30');
            return res.json({ success: true, ...projected });
        } catch (error) {
            logger.error?.('[ALPHA-NODE]', error.message);
            return res.status(503).json({ success: false, error: 'Alpha Node feed unavailable' });
        }
    };
}

module.exports = {
    ALPHA_NODE_READ_RPC,
    DEFAULT_ALPHA_NODE_LIMIT,
    MAX_ALPHA_NODE_LIMIT,
    SOURCE_CLASS_BY_KIND,
    createAlphaNodeFeedHandler,
    mapAlphaNodeReceipt,
    parseAlphaNodeQuery,
    projectAlphaNodeRpcResponse,
};
