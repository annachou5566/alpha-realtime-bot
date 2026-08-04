'use strict';

const fs = require('node:fs');

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);
  if (first < 0 || first !== last) throw new Error(`${label}: expected exactly one canonical match`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

const indexPath = 'index.js';
let source = fs.readFileSync(indexPath, 'utf8');
source = replaceOnce(
  source,
  "res.setHeader('x-wave-release', 'competition-price-series-v1');",
  "res.setHeader('x-wave-release', 'competition-price-series-v2');",
  'release marker'
);
source = replaceOnce(
  source,
  "            `&tokenAddress=${encodeURIComponent(contract)}&dataType=aggregate` +\n            `&startTime=${Math.max(0, boundaryAt - attempt.maxDriftMs)}` +\n            `&endTime=${boundaryAt + attempt.maxDriftMs}`;",
  "            `&tokenAddress=${encodeURIComponent(contract)}&dataType=aggregate` +\n            // Binance Alpha rejects startTime + endTime together with code -1130.\n            // endTime alone returns the bounded historical window ending after the\n            // requested UTC boundary, allowing chooseBoundaryPrice() to select it.\n            `&endTime=${boundaryAt + attempt.maxDriftMs}`;",
  'boundary Kline query'
);
fs.writeFileSync(indexPath, source);

const testPath = 'test/index-contract.test.js';
let contract = fs.readFileSync(testPath, 'utf8');
contract = replaceOnce(
  contract,
  "    assert.match(source, /x-wave-release', 'competition-price-series-v1/);",
  "    assert.match(source, /x-wave-release', 'competition-price-series-v2/);\n    assert.match(source, /`&endTime=\\$\\{boundaryAt \\+ attempt\\.maxDriftMs\\}`/);\n    assert.doesNotMatch(source, /`&startTime=\\$\\{Math\\.max\\(0, boundaryAt - attempt\\.maxDriftMs\\)\\}`/);",
  'boundary query contracts'
);
fs.writeFileSync(testPath, contract);
