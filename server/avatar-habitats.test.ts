import assert from 'node:assert/strict';
import test from 'node:test';
import { clampToHabitat, habitatForUser } from '../shared/avatar-habitats.js';

test('demo bots and real viewers remain on the main terrain', () => {
  assert.equal(habitatForUser('demo-bot:0'), null);
  assert.equal(habitatForUser('demo-bot:1'), null);
  assert.equal(habitatForUser('demo-bot:2'), null);
  assert.equal(habitatForUser('real-viewer'), null);
});

test('habitat clamping remains bounded for future ambient regions', () => {
  const habitat = { centerX: 0, centerZ: 0, radius: 0.1, baseY: 0, bobAmplitude: 0, bobSpeed: 1, bobPhase: 0 };
  const point = clampToHabitat(habitat, 3, 3);
  assert.ok(Math.hypot(point.x - habitat.centerX, point.z - habitat.centerZ) <= habitat.radius + 1e-9);
});
