'use strict';

function positiveTournamentId(value) {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
}

function historyResponseKey(item, fallbackKey) {
    const id = positiveTournamentId(item && (item.db_id ?? item.id));
    if (id) return `history_${id}`;
    return `history_legacy_${String(fallbackKey)}`;
}

function buildRoundSafeHistoryEntries(tournamentHistoryIndex, legacyHistoryCache) {
    const entries = [];
    const representedIds = new Set();
    Object.entries(tournamentHistoryIndex || {}).forEach(([fallbackId, item]) => {
        if (!item || typeof item !== 'object') return;

        const key = historyResponseKey(item, fallbackId);
        entries.push([key, item]);

        const id = positiveTournamentId(item.db_id ?? item.id ?? fallbackId);
        if (id) representedIds.add(String(id));

    });

    Object.entries(legacyHistoryCache || {}).forEach(([legacyKey, item]) => {
        if (!item || typeof item !== 'object') return;

        const id = positiveTournamentId(item.db_id ?? item.id);
        if (id && representedIds.has(String(id))) return;

        // Never dedupe by alphaId: Binance reuses alphaId across tournament
        // rounds. Only an exact tournament id proves the entry is duplicate.
        entries.push([historyResponseKey(item, legacyKey), item]);
    });

    return entries;
}

module.exports = {
    buildRoundSafeHistoryEntries,
    historyResponseKey,
    positiveTournamentId,
};
