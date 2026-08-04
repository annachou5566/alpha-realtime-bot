'use strict';

const fs = require('node:fs');
const path = 'test/index-contract.test.js';
let source = fs.readFileSync(path, 'utf8');

const replacements = [
  [
    `    assert.match(source, /REALTIME_POLL_MS', 5 * 60_000/);`,
    `    assert.ok(source.includes("REALTIME_POLL_MS', 5 * 60_000"));`,
  ],
  [
    `    assert.match(source, /CONFIG_SYNC_MS', 30 * 60_000/);`,
    `    assert.ok(source.includes("CONFIG_SYNC_MS', 30 * 60_000"));`,
  ],
  [
    `    assert.match(source, /TOKEN_LIST_SYNC_MS', 6 * 60 * 60_000/);`,
    `    assert.ok(source.includes("TOKEN_LIST_SYNC_MS', 6 * 60 * 60_000"));`,
  ],
  [
    `    assert.match(source, /syncBaseData({ force: true })/);`,
    `    assert.ok(source.includes('syncBaseData({ force: true })'));`,
  ],
];

for (const [before, after] of replacements) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`Expected one generated contract line, found ${count}: ${before}`);
  source = source.replace(before, after);
}

fs.writeFileSync(path, source);
