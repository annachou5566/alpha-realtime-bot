'use strict';
// Compare inbound credentials with fixed-length digests to avoid plain string comparisons.
const { createHash, timingSafeEqual } = require('node:crypto');
const MAX_KEY_BYTES = 4096;
function equalCredential(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  const bytes = Buffer.byteLength(candidate, 'utf8');
  const expectedBytes = Buffer.byteLength(expected, 'utf8');
  if (!bytes || !expectedBytes || bytes > MAX_KEY_BYTES || expectedBytes > MAX_KEY_BYTES) return false;
  const lhs = createHash('sha256').update(candidate, 'utf8').digest();
  const rhs = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(lhs, rhs);
}
function isAuthorizedAlphaReadKey(candidate, active, standby) {
  const activeMatch = equalCredential(candidate, active);
  const standbyMatch = typeof standby === 'string' && standby.length > 0
    ? equalCredential(candidate, standby) : false;
  return activeMatch || standbyMatch;
}
module.exports = { isAuthorizedAlphaReadKey };
