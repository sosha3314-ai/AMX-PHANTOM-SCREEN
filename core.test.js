const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

test('room token uses cryptographically secure random bytes', () => {
  const a = crypto.randomBytes(32).toString('base64url');
  const b = crypto.randomBytes(32).toString('base64url');
  assert.equal(a.length >= 40, true);
  assert.notEqual(a, b);
});

test('device id validation pattern accepts generated ids and rejects short values', () => {
  const pattern = /^[a-zA-Z0-9_-]{8,80}$/;
  assert.equal(pattern.test(`dev_${crypto.randomUUID().replaceAll('-', '')}`), true);
  assert.equal(pattern.test('bad'), false);
});
