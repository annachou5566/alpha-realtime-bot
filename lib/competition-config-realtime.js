'use strict';

const DEFAULT_BATCH_MS = 1200;
const DEFAULT_RING_SIZE = 12;
const DEFAULT_RING_TTL_MS = 20 * 60 * 1000;

const PATCH_KEYS = new Set([
    'ai_prediction',
    'history',
    'min_vol',
    'minVol',
    'min_vol_updated_at',
    'display_target',
    'display_prev_target',
]);

// These keys can change without changing tournament identity/schedule/config structure.
// They must never cause an hourly volume reconciliation to masquerade as a structural
// tournament INSERT/edit and force a full config reload.
const VOLATILE_KEYS = new Set([
    ...PATCH_KEYS,
    'real_vol_history',
    'limit_vol_history',
    'onchain_vol_history',
    'usdc_vol_history',
    'usdt_vol_history',
    'real_alpha_volume',
    'limit_daily_volume',
    'onchain_daily_volume',
    'usdc_daily_volume',
    'usdt_daily_volume',
    'limit_accumulated_volume',
    'limit_accumulated_tx',
    'onchain_accumulated_volume',
    'onchain_accumulated_tx',
    'usdc_accumulated_volume',
    'usdc_accumulated_tx',
    'usdt_accumulated_volume',
    'usdt_accumulated_tx',
    'total_accumulated_volume',
    'daily_tx_count',
    'tx_count',
    'competition_chart_series_v2',
    'competition_chart_series_v3',
    'base_total_vol',
    'base_limit_vol',
    'last_updated_ts',
    'migrated_limit_ts',
    'volume_observed_at',
    'limit_observed_at',
    'reconciled_at',
    'price',
    'change_24h',
    'liquidity',
    'volume',
    'market_analysis',
    'updated_at',
    'last_updated',
    'db_id',
]);

function parseRowData(value) {
    if (!value) return {};
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (_) {
            return {};
        }
    }
    return {};
}

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

function structuralProjection(data) {
    const source = parseRowData(data);
    const out = {};
    Object.keys(source).sort().forEach(key => {
        if (VOLATILE_KEYS.has(key)) return;
        out[key] = source[key];
    });
    return out;
}

function structuralRowProjection(row) {
    if (!row || typeof row !== 'object') return null;
    return {
        id: row.id == null ? null : Number(row.id),
        name: row.name == null ? null : String(row.name),
        contract: row.contract == null ? null : String(row.contract),
        data: structuralProjection(row.data),
    };
}

function patchProjection(data) {
    const source = parseRowData(data);
    const out = {};
    for (const key of PATCH_KEYS) {
        if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key];
    }
    return out;
}

function isFinalizedData(data) {
    const source = parseRowData(data);
    return String(source.ai_prediction?.status_label || '').toUpperCase() === 'FINALIZED' ||
        String(source.status || '').toUpperCase() === 'FINALIZED' ||
        source.is_finalized === true;
}

function changedPatchKeys(previousData, nextData) {
    const before = patchProjection(previousData);
    const after = patchProjection(nextData);
    const changed = [];
    for (const key of PATCH_KEYS) {
        const beforeHas = Object.prototype.hasOwnProperty.call(before, key);
        const afterHas = Object.prototype.hasOwnProperty.call(after, key);
        if (beforeHas !== afterHas || stableJson(before[key]) !== stableJson(after[key])) changed.push(key);
    }
    return changed;
}

function publicPatch(row, changedKeys = PATCH_KEYS) {
    const data = parseRowData(row && row.data);
    const alphaId = String(data.alphaId || '').trim();
    if (!alphaId) return null;
    const changed = changedKeys instanceof Set ? changedKeys : new Set(changedKeys);
    const out = { alphaId, dbId: Number(row.id) };
    if (changed.has('history')) out.history = Array.isArray(data.history) ? data.history : null;
    if (changed.has('ai_prediction')) {
        out.aiPrediction = data.ai_prediction && typeof data.ai_prediction === 'object'
            ? data.ai_prediction
            : null;
    }
    if (changed.has('min_vol')) out.minVol = Object.prototype.hasOwnProperty.call(data, 'min_vol') ? data.min_vol : null;
    if (changed.has('minVol')) out.minVolLegacy = Object.prototype.hasOwnProperty.call(data, 'minVol') ? data.minVol : null;
    if (changed.has('min_vol_updated_at')) {
        out.minVolUpdatedAt = Object.prototype.hasOwnProperty.call(data, 'min_vol_updated_at')
            ? data.min_vol_updated_at
            : null;
    }
    if (changed.has('display_target')) out.displayTarget = Object.prototype.hasOwnProperty.call(data, 'display_target') ? data.display_target : null;
    if (changed.has('display_prev_target')) out.displayPrevTarget = Object.prototype.hasOwnProperty.call(data, 'display_prev_target') ? data.display_prev_target : null;
    return out;
}

function createCompetitionConfigRealtimeControl(options = {}) {
    const supabase = options.supabase;
    const getCurrentByDbId = options.getCurrentByDbId;
    const applyPatch = options.applyPatch;
    const rememberRow = options.rememberRow;
    const refreshAll = options.refreshAll;
    const onSnapshotChange = typeof options.onSnapshotChange === 'function'
        ? options.onSnapshotChange
        : null;
    const logger = options.logger || console;
    const batchMs = Math.max(100, Number(options.batchMs) || DEFAULT_BATCH_MS);
    const ringSize = Math.max(2, Number(options.ringSize) || DEFAULT_RING_SIZE);
    const ringTtlMs = Math.max(60_000, Number(options.ringTtlMs) || DEFAULT_RING_TTL_MS);

    if (!supabase || typeof supabase.channel !== 'function') {
        throw new Error('competition config realtime requires Supabase client');
    }
    if (typeof getCurrentByDbId !== 'function' || typeof applyPatch !== 'function' ||
        typeof rememberRow !== 'function' || typeof refreshAll !== 'function') {
        throw new Error('competition config realtime requires current/patch/remember/refresh callbacks');
    }

    let channel = null;
    let status = 'idle';
    let lastEventAt = null;
    let lastAppliedAt = null;
    let lastError = null;
    let revision = 0;
    let structuralRevision = 0;
    let droppedBeforeRevision = 0;
    let flushTimer = null;
    let structuralTimer = null;
    let structuralRunning = false;
    let pendingStructural = false;
    const pendingPatches = new Map();
    const batches = [];

    function trimBatches(now = Date.now()) {
        while (batches.length > 0 && now - batches[0].createdAtMs > ringTtlMs) {
            const removed = batches.shift();
            droppedBeforeRevision = Math.max(droppedBeforeRevision, removed.revision);
        }
        while (batches.length > ringSize) {
            const removed = batches.shift();
            droppedBeforeRevision = Math.max(droppedBeforeRevision, removed.revision);
        }
    }

    function pushBatch(batch) {
        batches.push(batch);
        trimBatches(batch.createdAtMs);
    }

    function notifySnapshotChange(reason) {
        if (!onSnapshotChange) return;
        const current = snapshot();
        Promise.resolve()
            .then(() => onSnapshotChange(current, reason))
            .catch(error => {
                logger.warn(
                    '[CONFIG-REALTIME] snapshot observer failed:',
                    error && error.message ? error.message : String(error),
                );
            });
    }

    function flushPatches() {
        flushTimer = null;
        if (pendingStructural || structuralRunning || pendingPatches.size === 0) return;
        const patches = Array.from(pendingPatches.values());
        pendingPatches.clear();
        revision += 1;
        const now = Date.now();
        lastAppliedAt = new Date(now).toISOString();
        pushBatch({
            revision,
            kind: 'patch',
            createdAtMs: now,
            createdAt: lastAppliedAt,
            patches,
        });
        notifySnapshotChange('patch');
    }

    function schedulePatchFlush() {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = setTimeout(flushPatches, batchMs);
        if (typeof flushTimer.unref === 'function') flushTimer.unref();
    }

    async function runStructuralRefresh() {
        structuralTimer = null;
        if (structuralRunning) {
            pendingStructural = true;
            return;
        }
        structuralRunning = true;
        pendingStructural = false;
        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
        pendingPatches.clear();
        try {
            await refreshAll();
            revision += 1;
            structuralRevision += 1;
            const now = Date.now();
            lastAppliedAt = new Date(now).toISOString();
            pushBatch({
                revision,
                kind: 'structural',
                structuralRevision,
                createdAtMs: now,
                createdAt: lastAppliedAt,
            });
            notifySnapshotChange('structural');
        } catch (error) {
            lastError = error && error.message ? error.message : String(error);
            logger.error('[CONFIG-REALTIME] structural refresh failed:', lastError);
        } finally {
            structuralRunning = false;
            if (pendingStructural) scheduleStructuralRefresh();
        }
    }

    function scheduleStructuralRefresh() {
        pendingStructural = true;
        if (structuralTimer) clearTimeout(structuralTimer);
        structuralTimer = setTimeout(runStructuralRefresh, Math.min(batchMs, 750));
        if (typeof structuralTimer.unref === 'function') structuralTimer.unref();
    }

    function handleUpdate(row) {
        if (!row || row.id == null) return;
        const nextData = parseRowData(row.data);
        const current = getCurrentByDbId(row.id);

        if (!current) {
            if (!isFinalizedData(nextData)) scheduleStructuralRefresh();
            return;
        }

        if (!current.rawRow ||
            stableJson(structuralRowProjection(current.rawRow)) !== stableJson(structuralRowProjection(row))) {
            scheduleStructuralRefresh();
            return;
        }

        const changedKeys = changedPatchKeys(current.rawRow.data, nextData);
        if (changedKeys.length === 0) {
            rememberRow(row);
            return;
        }

        const nextPatchProjection = patchProjection(nextData);
        const patch = publicPatch(row, new Set(changedKeys));
        if (!patch) {
            scheduleStructuralRefresh();
            return;
        }

        applyPatch(row, nextPatchProjection);
        rememberRow(row);
        pendingPatches.set(patch.alphaId, patch);
        schedulePatchFlush();
    }

    function handlePayload(payload) {
        lastEventAt = new Date().toISOString();
        lastError = null;
        const eventType = String(payload && payload.eventType || '').toUpperCase();
        if (eventType === 'UPDATE') {
            handleUpdate(payload.new);
            return;
        }
        if (eventType === 'INSERT') {
            const data = parseRowData(payload.new && payload.new.data);
            if (!isFinalizedData(data)) scheduleStructuralRefresh();
            return;
        }
        if (eventType === 'DELETE') scheduleStructuralRefresh();
    }

    function start() {
        if (channel) return channel;
        status = 'connecting';
        channel = supabase
            .channel('wave-alpha-oracle-competition-config')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'tournaments' }, handlePayload)
            .subscribe((nextStatus, error) => {
                status = String(nextStatus || 'unknown').toLowerCase();
                if (error) {
                    lastError = error.message || String(error);
                    logger.error('[CONFIG-REALTIME] subscription error:', lastError);
                }
                if (nextStatus === 'SUBSCRIBED') {
                    logger.log('[CONFIG-REALTIME] subscribed to public.tournaments');
                }
            });
        return channel;
    }

    async function stop() {
        if (flushTimer) clearTimeout(flushTimer);
        if (structuralTimer) clearTimeout(structuralTimer);
        flushTimer = null;
        structuralTimer = null;
        pendingPatches.clear();
        if (channel && typeof supabase.removeChannel === 'function') {
            try { await supabase.removeChannel(channel); } catch (_) {}
        }
        channel = null;
        status = 'stopped';
    }

    function snapshot() {
        trimBatches();
        return {
            revision,
            structuralRevision,
            droppedBeforeRevision,
            batches: batches.map(batch => {
                const { createdAtMs, ...publicBatch } = batch;
                return publicBatch;
            }),
        };
    }

    function telemetry() {
        trimBatches();
        return {
            status,
            revision,
            structuralRevision,
            batchCount: batches.length,
            droppedBeforeRevision,
            pendingPatchCount: pendingPatches.size,
            pendingStructural,
            structuralRunning,
            lastEventAt,
            lastAppliedAt,
            lastError,
        };
    }

    return {
        start,
        stop,
        snapshot,
        telemetry,
        handlePayload,
        flushPatches,
    };
}

module.exports = {
    PATCH_KEYS,
    VOLATILE_KEYS,
    parseRowData,
    structuralProjection,
    structuralRowProjection,
    patchProjection,
    changedPatchKeys,
    publicPatch,
    createCompetitionConfigRealtimeControl,
};
