'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    selectFreshAlphaTokenList,
} = require('../lib/alpha-market-token-list');

test('fresh aggregate becomes the canonical Alpha Market membership list', () => {
    const previous = [{ alphaId: 'ALPHA_OLD', symbol: 'OLD' }];
    const aggregate = [
        { alphaId: 'ALPHA_OLD', symbol: 'OLD' },
        { alphaId: 'ALPHA_CP', symbol: 'CP', chainName: 'Base' },
    ];

    assert.equal(selectFreshAlphaTokenList(previous, aggregate), aggregate);
    assert.equal(selectFreshAlphaTokenList(previous, aggregate).length, 2);
});

test('empty or malformed aggregate retains the last good token list', () => {
    const previous = [{ alphaId: 'ALPHA_OLD', symbol: 'OLD' }];

    assert.equal(selectFreshAlphaTokenList(previous, []), previous);
    assert.equal(selectFreshAlphaTokenList(previous, null), previous);
    assert.equal(selectFreshAlphaTokenList(previous, {}), previous);
});

test('loopRealtime refreshes token membership from its existing aggregate poll', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const start = source.indexOf('async function loopRealtime()');
    const end = source.indexOf('// ==========================================\n// 6. API TRẢ DỮ LIỆU', start);
    assert.ok(start >= 0 && end > start);

    const loop = source.slice(start, end);
    assert.match(loop, /axios\.get\(API_ENDPOINTS\.BULK_TOTAL/);
    assert.match(loop, /BINANCE_TOKEN_LIST\s*=\s*selectFreshAlphaTokenList\(BINANCE_TOKEN_LIST,\s*resTot\.data\.data\)/);
});
