import assert from 'node:assert/strict';
import test from 'node:test';
import { battleWinner, segmentHitsSphere } from '../shared/blaster-battle.js';
import { BlastCommandLimiter } from '../shared/blast-command-limiter.js';

test('blast limiter enforces five-second viewer cooldown and global rate limit', () => {
  const limiter = new BlastCommandLimiter(5000, 1000, 2);
  assert.equal(limiter.accept('viewer-a', 0), true);
  assert.equal(limiter.accept('viewer-b', 10), true);
  assert.equal(limiter.accept('viewer-c', 20), false);
  assert.equal(limiter.accept('viewer-c', 1010), true);
  assert.equal(limiter.accept('viewer-a', 4999), false);
  assert.equal(limiter.accept('viewer-a', 5000), true);
});

test('moving projectile collision uses the traveled segment, not an automatic hit', () => {
  const center = { x: 0, y: 1.6, z: 0 };
  assert.equal(
    segmentHitsSphere({ x: -1, y: 1.6, z: 0 }, { x: 1, y: 1.6, z: 0 }, center, 0.14),
    true,
  );
  assert.equal(
    segmentHitsSphere({ x: -1, y: 1.9, z: 0 }, { x: 1, y: 1.9, z: 0 }, center, 0.14),
    false,
  );
});

test('battle winner distinguishes streamer, chat, and ties', () => {
  assert.equal(battleWinner(4, 2), 'streamer');
  assert.equal(battleWinner(1, 3), 'chat');
  assert.equal(battleWinner(2, 2), 'tie');
});
