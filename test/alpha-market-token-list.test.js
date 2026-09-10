'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    selectFreshAlphaTokenList,
} = require('../lib/alpha-market-token-list');

test('fresh aggregate appends a new CP/Base token without dropping last-good membership', () => {
    const previous = [
        { alphaId: 'ALPHA_OLD', symbol: 'OLD', chainName: 'Bsc' },
        { alphaId: 'ALPHA_KEEP', symbol: 'KEEP', chainName: 'Solana' },
    ];
    const aggregate = [
        { alphaId: 'ALPHA_OLD', symbol: 'OLD2', chainName: 'Bsc' },
        { alphaId: 'ALPHA_CP', symbol: 'CP', chainName: 'Base' },
    ];

    const next = selectFreshAlphaTokenList(previous, aggregate);

    assert.equal(next.length, 3);
    assert.equal(next.find(x => x.alphaId === 'ALPHA_OLD').symbol, 'OLD2');
    assert.equal(next.find(x => x.alphaId === 'ALPHA_KEEP').symbol, 'KEEP');
    assert.equal(next.find(x => x.alphaId === 'ALPHA_CP').chainName, 'Base');
});

test('partial aggregate can never truncate last-good token membership', () => {
    const previous = [
        { alphaId: 'ALPHA_A', symbol: 'A' },
        { alphaId: 'ALPHA_B', symbol: 'B' },
        { alphaId: 'ALPHA_C', symbol: 'C' },
    ];
    const aggregate = [
        { alphaId: 'ALPHA_B', price: '2' },
    ];

    const next = selectFreshAlphaTokenList(previous, aggregate);

    assert.deepEqual(next.map(x => x.alphaId), ['ALPHA_A', 'ALPHA_B', 'ALPHA_C']);
    assert.equal(next.find(x => x.alphaId === 'ALPHA_B').symbol, 'B');
    assert.equal(next.find(x => x.alphaId === 'ALPHA_B').price, '2');
});

test('empty or malformed aggregate retains the exact last-good list', () => {
    const previous = [{ alphaId: 'ALPHA_OLD', symbol: 'OLD' }];

    assert.equal(selectFreshAlphaTokenList(previous, []), previous);
    assert.equal(selectFreshAlphaTokenList(previous, null), previous);
    assert.equal(selectFreshAlphaTokenList(previous, {}), previous);
    assert.equal(selectFreshAlphaTokenList(previous, [{ symbol: 'NO_ID' }]), previous);
});

test('duplicate aggregate alphaIds do not duplicate browser membership', () => {
    const previous = [{ alphaId: 'ALPHA_CP', symbol: 'CP' }];
    const aggregate = [
        { alphaId: 'ALPHA_CP', price: '1' },
        { alphaId: 'ALPHA_CP', price: '2' },
    ];

    const next = selectFreshAlphaTokenList(previous, aggregate);

    assert.equal(next.length, 1);
    assert.equal(next[0].price, '2');
});

test('loopRealtime refreshes membership from the existing aggregate poll without another Binance request', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const start = source.indexOf('async function loopRealtime()');
    const end = source.indexOf('// ==========================================\n// 6. API TRẢ DỮ LIỆU', start);
    assert.ok(start >= 0 && end > start);

    const loop = source.slice(start, end);
    const bulkTotalFetches = (loop.match(/axios\.get\(API_ENDPOINTS\.BULK_TOTAL/g) || []).length;

    assert.equal(bulkTotalFetches, 1);
    assert.match(
        loop,
        /BINANCE_TOKEN_LIST\s*=\s*selectFreshAlphaTokenList\(\s*BINANCE_TOKEN_LIST,\s*resTot\.data\.data,?\s*\)/,
    );
});
