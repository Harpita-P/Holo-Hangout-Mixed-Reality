import assert from 'node:assert/strict';
import test from 'node:test';
import { ShoutoutTracker } from '../shared/shoutout-tracker.js';

test('shoutout triggers after three uninterrupted seconds', () => {
  const tracker = new ShoutoutTracker();
  assert.equal(tracker.begin('viewer', false, 10), true);
  assert.deepEqual(tracker.update(12.99), []);
  assert.deepEqual(tracker.update(13), ['viewer']);
});

test('early release cancels the pending shoutout', () => {
  const tracker = new ShoutoutTracker();
  tracker.begin('viewer', false, 0);
  tracker.release('viewer');
  assert.deepEqual(tracker.update(5), []);
});

test('continuous holds trigger once and respect the per-viewer cooldown', () => {
  const tracker = new ShoutoutTracker();
  tracker.begin('viewer', false, 0);
  assert.deepEqual(tracker.update(3), ['viewer']);
  assert.deepEqual(tracker.update(8), []);
  tracker.release('viewer');
  assert.equal(tracker.begin('viewer', false, 10), false);
  assert.equal(tracker.begin('viewer', false, 24), true);
  assert.deepEqual(tracker.update(27), ['viewer']);
});

test('demo bots never start shoutout holds', () => {
  const tracker = new ShoutoutTracker();
  assert.equal(tracker.begin('demo-bot:0', true, 0), false);
  assert.deepEqual(tracker.update(10), []);
});
