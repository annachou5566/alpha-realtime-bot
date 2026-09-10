'use strict';

function alphaIdOf(item) {
    const value = String(item && item.alphaId || '').trim();
    return value || null;
}

function selectFreshAlphaTokenList(currentList, aggregateList) {
    const current = Array.isArray(currentList) ? currentList : [];
    const aggregate = Array.isArray(aggregateList) ? aggregateList : [];

    // Never let an empty/malformed aggregate erase last-good membership.
    if (aggregate.length === 0) return current;

    const out = current.map(item => ({ ...item }));
    const indexByAlphaId = new Map();

    out.forEach((item, index) => {
        const alphaId = alphaIdOf(item);
        if (alphaId && !indexByAlphaId.has(alphaId)) {
            indexByAlphaId.set(alphaId, index);
        }
    });

    let validAggregateCount = 0;

    aggregate.forEach(item => {
        if (!item || typeof item !== 'object') return;
        const alphaId = alphaIdOf(item);
        if (!alphaId) return;

        validAggregateCount += 1;

        const index = indexByAlphaId.get(alphaId);
        if (index === undefined) {
            indexByAlphaId.set(alphaId, out.length);
            out.push({ ...item });
            return;
        }

        // Fresh aggregate fields win, but preserve last-good fields omitted by
        // a partial upstream row. Membership can grow/refresh but never shrink
        // solely because a realtime aggregate response is partial.
        out[index] = {
            ...out[index],
            ...item,
            alphaId,
        };
    });

    return validAggregateCount > 0 ? out : current;
}

module.exports = {
    alphaIdOf,
    selectFreshAlphaTokenList,
};
