import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCsrfToken,
  createPlatformToken,
  verifyPlatformToken,
} from './platform-security.js';

const secret = 'test-session-secret-with-enough-entropy';

test('dashboard and world credentials are signed, scoped, and expire', () => {
  const now = 1_000_000;
  const dashboard = createPlatformToken(
    { kind: 'dashboard', subject: 'streamer-a' },
    secret,
    10_000,
    now,
  );
  const world = createPlatformToken(
    { kind: 'world', subject: 'streamer-a', worldId: 'world-a' },
    secret,
    10_000,
    now,
  );
  assert.equal(verifyPlatformToken(dashboard, secret, 'dashboard', now)?.subject, 'streamer-a');
  assert.equal(verifyPlatformToken(dashboard, secret, 'world', now), null);
  assert.equal(verifyPlatformToken(world, secret, 'world', now)?.worldId, 'world-a');
  assert.equal(verifyPlatformToken(world, secret, 'world', now + 10_001), null);
  assert.equal(verifyPlatformToken(`${world}x`, secret, 'world', now), null);
});

test('CSRF tokens are bound to streamer ownership', () => {
  assert.notEqual(createCsrfToken('streamer-a', secret), createCsrfToken('streamer-b', secret));
});
