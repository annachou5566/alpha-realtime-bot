'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isAuthorizedAlphaReadKey: accepts } = require('../lib/readonly-api-auth');
test('legacy credential works without standby', () => {
 assert.equal(accepts('old-synthetic', 'old-synthetic'), true);
 assert.equal(accepts('wrong-synthetic', 'old-synthetic'), false);
});
test('optional standby does not remove active access', () => {
 assert.equal(accepts('old-synthetic', 'old-synthetic', 'next-synthetic'), true);
 assert.equal(accepts('next-synthetic', 'old-synthetic', 'next-synthetic'), true);
 assert.equal(accepts('wrong-synthetic', 'old-synthetic', 'next-synthetic'), false);
});
test('malformed and absent credentials are rejected', () => {
 for(const v of ['', undefined, null, ['old-synthetic'], {}, 7])
  assert.equal(accepts(v, 'old-synthetic', 'next-synthetic'), false);
 assert.equal(accepts('', '', ''), false);
});
test('old identity denied after verifier switch', () => {
 assert.equal(accepts('old-synthetic', 'next-synthetic'), false);
 assert.equal(accepts('next-synthetic', 'next-synthetic'), true);
});
test('UTF8 and bounded header handling', () => {
 assert.equal(accepts('ключ', 'ключ'), true);
 assert.equal(accepts('a'.repeat(4097), 'a'.repeat(4097)), false);
 assert.equal(accepts('a'.repeat(4096), 'a'.repeat(4096)), true);
});
