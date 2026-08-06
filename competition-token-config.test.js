'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    cleanCompetitionSymbol,
    sameCompetitionContract,
    resolveOfficialAlphaToken,
} = require('./lib/competition-token-config');

const CAP_CONTRACT = '0x99991c6aabba5a096f24f250b73580f5179b9999';
const POWER_CONTRACT = '0x9dc44ae5be187eca9e2a67e33f27a4c91cea1223';
const tokens = [
    { alphaId: 'ALPHA_CAP', symbol: 'CAP', contractAddress: CAP_CONTRACT, chainId: '56' },
    { alphaId: 'ALPHA_POWER', symbol: 'POWER', contractAddress: POWER_CONTRACT, chainId: '56' },
    { alphaId: 'ALPHA_SOL', symbol: 'SOLX', contractAddress: 'AbCdEf123', chainId: 'CT_501' },
];

test('resolves a missing alphaId from the official Binance contract', () => {
    const token = resolveOfficialAlphaToken(tokens, {
        name: 'CAP (R2)',
        contract: CAP_CONTRACT.toUpperCase().replace('0X', '0x'),
    }, {});
    assert.equal(token?.alphaId, 'ALPHA_CAP');
});

test('resolves round-labelled competitions from the official Binance symbol', () => {
    const token = resolveOfficialAlphaToken(tokens, { name: 'POWER (R1)' }, {});
    assert.equal(token?.alphaId, 'ALPHA_POWER');
    assert.equal(cleanCompetitionSymbol(' POWER (R1) '), 'POWER');
});

test('keeps non-EVM contract matching case-sensitive', () => {
    assert.equal(sameCompetitionContract('AbCdEf123', 'abcdef123'), false);
    assert.equal(resolveOfficialAlphaToken(tokens, { contract: 'abcdef123', name: 'UNKNOWN' }, {}), null);
});

test('prefers an explicit official alphaId when available', () => {
    const token = resolveOfficialAlphaToken(tokens, { name: 'WRONG' }, { alphaId: 'ALPHA_CAP' });
    assert.equal(token?.contractAddress, CAP_CONTRACT);
});

test('returns null instead of inventing an identifier', () => {
    assert.equal(resolveOfficialAlphaToken(tokens, { name: 'MISSING', contract: '0x0000000000000000000000000000000000000000' }, {}), null);
});
