'use strict';

const fs = require('node:fs');

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);
  if (first < 0 || first !== last) {
    throw new Error(`${label}: expected exactly one canonical match`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

const indexPath = 'index.js';
let index = fs.readFileSync(indexPath, 'utf8');

index = replaceOnce(
  index,
  "    if (req.path === '/' || req.path === '/health') {\n        return res.status(200).send('OK');\n    }",
  "    if (req.path === '/' || req.path === '/health') {\n        res.setHeader('x-wave-release', 'competition-price-series-v1');\n        return res.status(200).send('OK');\n    }",
  'health release marker'
);

index = replaceOnce(
  index,
  "    syncTournamentPriceSeries({ maxFetches: 6 }).catch(error => console.warn('Price sync:', error.message));",
  "    (async () => {\n        const dryRun = await syncTournamentPriceSeries({ includeHistory: true, maxFetches: 100, dryRun: true });\n        console.log('[PRICE-BACKFILL] startup dry-run', dryRun);\n        if (Number(dryRun.missing || 0) > 0) {\n            const result = await syncTournamentPriceSeries({ includeHistory: true, maxFetches: 100 });\n            console.log('[PRICE-BACKFILL] startup result', result);\n        }\n    })().catch(error => console.warn('Price startup backfill:', error.message));",
  'startup price sync'
);

fs.writeFileSync(indexPath, index);

const testPath = 'test/index-contract.test.js';
let contract = fs.readFileSync(testPath, 'utf8');
contract = replaceOnce(
  contract,
  "    assert.match(source, /\\/api\\/competition-price-series/);",
  "    assert.match(source, /\\/api\\/competition-price-series/);\n    assert.match(source, /x-wave-release', 'competition-price-series-v1/);\n    assert.match(source, /includeHistory: true, maxFetches: 100, dryRun: true/);\n    assert.match(source, /includeHistory: true, maxFetches: 100/);",
  'backend contract assertions'
);
fs.writeFileSync(testPath, contract);
