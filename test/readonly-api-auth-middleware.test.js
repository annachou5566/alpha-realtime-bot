'use strict';
// Execute the exact authentication middleware extracted from the current index.js.
// This is a no-network fixture with synthetic credentials, no app startup.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const indexPath = path.resolve(__dirname, '..', 'index.js');
const src = fs.readFileSync(indexPath, 'utf8');
const startMarker = '// --- BẢO MẬT: CỬA AN NINH KIỂM TRA API KEY ---';
const endMarker = '// ----------------------------------------------';
const start = src.indexOf(startMarker);
const end = src.indexOf(endMarker, start + startMarker.length);
assert.ok(start >= 0 && end > start);
assert.equal(src.indexOf(startMarker, start + 1), -1, 'unique middleware source');
const isolatedSource = src.slice(start, end);
function middlewareFor(active, standby) {
  const handlers = [];
  const env = { API_SECRET_KEY: active };
  if (standby !== undefined) env.API_SECRET_KEY_NEXT = standby;
  new Function('app', 'require', 'process', 'console', isolatedSource)(
    { use(fn) { handlers.push(fn); } },
    createRequire(indexPath),
    { env },
    { warn() {} }
  );
  assert.equal(handlers.length, 1);
  return handlers[0];
}
function execute(handler, key, url = '/api/market-data', method = 'GET') {
  let status = null;
  let body = null;
  let nextCalls = 0;
  const res = {
    setHeader() {},
    status(code) { status = code; return this; },
    json(v) { body = v; return this; },
    send(v) { body = v; return this; }
  };
  handler({ method, path: url, ip: '127.0.0.1', headers: key === undefined ? {} : { 'x-api-key': key } },
    res, () => { nextCalls++; });
  return { status, body, nextCalls };
}
test('source middleware accepts only current key when standby is absent', () => {
  const handler = middlewareFor('old-synthetic');
  assert.equal(execute(handler, 'old-synthetic').nextCalls, 1);
  assert.equal(execute(handler, 'unknown-synthetic').status, 401);
  assert.equal(execute(handler, 'new-synthetic').nextCalls, 0);
});
test('source middleware accepts either key during explicit overlap', () => {
  const handler = middlewareFor('old-synthetic', 'new-synthetic');
  assert.equal(execute(handler, 'old-synthetic').nextCalls, 1);
  assert.equal(execute(handler, 'new-synthetic').nextCalls, 1);
  assert.equal(execute(handler, 'unknown-synthetic').status, 401);
});
test('source middleware rejects malformed headers and preserves existing probes', () => {
  const handler = middlewareFor('old-synthetic', 'new-synthetic');
  for (const bad of [undefined, '', ['old-synthetic'], 'wrong'])
    assert.equal(execute(handler, bad).status, 401);
  assert.equal(execute(handler, undefined, '/api/market-data', 'OPTIONS').nextCalls, 1);
  assert.equal(execute(handler, undefined, '/health').status, 200);
});
test('source middleware denies old credential after a new-only verifier switch', () => {
  const handler = middlewareFor('new-synthetic');
  assert.equal(execute(handler, 'old-synthetic').status, 401);
  assert.equal(execute(handler, 'new-synthetic').nextCalls, 1);
});
test('launch requires a protected standby file and refuses inherited secret', () => {
  const launch = fs.readFileSync(path.resolve(__dirname,'..','scripts','oracle-production-readonly-launch.sh'),'utf8');
  assert.ok(launch.includes('PRODUCTION_READ_API_SECRET_KEY_NEXT+x'));
  assert.ok(launch.includes('refusing inherited standby API credential'));
  assert.ok(launch.includes('NEXT_API_KEY_FILE="$CRED_DIR/PRODUCTION_READ_API_SECRET_KEY_NEXT"'));
  assert.ok(launch.includes('if [[ -e "$NEXT_API_KEY_FILE" ]]'));
  assert.ok(launch.includes('require_file "$NEXT_API_KEY_FILE"'));
});
