'use strict';

function cleanCompetitionSymbol(value) {
    return String(value || '')
        .toUpperCase()
        .replace(/\s*\([^)]*\)\s*/g, '')
        .trim();
}

function isEvmContract(value) {
    return /^0x[0-9a-fA-F]{40}$/.test(String(value || '').trim());
}

function sameCompetitionContract(left, right) {
    const a = String(left || '').trim();
    const b = String(right || '').trim();
    if (!a || !b) return false;
    if (a === b) return true;
    return isEvmContract(a) && isEvmContract(b) && a.toLowerCase() === b.toLowerCase();
}

function resolveOfficialAlphaToken(tokenList, row = {}, meta = {}) {
    const list = Array.isArray(tokenList) ? tokenList : [];
    const alphaId = String(meta.alphaId || '').trim();
    const contract = String(row.contract || meta.contract || '').trim();
    const symbol = cleanCompetitionSymbol(row.name || meta.symbol || meta.name);

    return list.find(token => {
        if (!token || typeof token !== 'object') return false;
        if (alphaId && String(token.alphaId || '').trim() === alphaId) return true;
        if (contract && sameCompetitionContract(token.contractAddress, contract)) return true;
        return Boolean(symbol && cleanCompetitionSymbol(token.symbol) === symbol);
    }) || null;
}

module.exports = {
    cleanCompetitionSymbol,
    sameCompetitionContract,
    resolveOfficialAlphaToken,
};
