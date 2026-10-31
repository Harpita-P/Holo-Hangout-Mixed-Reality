import assert from 'node:assert/strict';
import test from 'node:test';
import { validateVoxelBlueprint, type VoxelBlueprint } from '../shared/community-sandbox.js';
import type { ParticipantSnapshot, ServerMessage } from '../shared/protocol.js';
import { CommunitySandbox, parseBuildCommand } from './community-sandbox.js';
import { generateMockBlueprint } from './community-sandbox-mock.js';

const viewer: ParticipantSnapshot = {
  userId: 'viewer-1', isBot: false, displayName: 'ViewerOne', colorHex: '#FFFFFF', slot: 0,
  monsterType: 'chicken', monsterCategory: 'big', monsterName: 'Chicken', supportedCommands: [],
  behavior: 'idle', actionSequence: 0, targetX: 0, targetZ: 0,
};

test('build command parser preserves a multiword prompt and distinguishes other chat', () => {
  assert.equal(parseBuildCommand(' !build colorful little dragon '), 'colorful little dragon');
  assert.equal(parseBuildCommand('!build'), '');
  assert.equal(parseBuildCommand('hello chat'), null);
});

test('sandbox never generates before a sustained physical approval and approves once', async () => {
  const emitted: ServerMessage[] = [];
  const sandbox = makeSandbox(emitted);
  sandbox.start();
  assert.equal(sandbox.submit(viewer.userId, viewer.displayName, 'colorful dragon'), true);
  assert.equal(sandbox.status().creations.length, 0);
  const request = sandbox.status().pending[0];
  assert.ok(request);
  sandbox.setHeld(viewer.userId, true, 1000);
  assert.equal(sandbox.approve(request.id, viewer.userId, 1200), false);
  assert.equal(sandbox.approve(request.id, viewer.userId, 1400), true);
  assert.equal(sandbox.approve(request.id, viewer.userId, 1500), false);
  await waitFor(() => sandbox.status().creations.length === 1);
  assert.equal(emitted.filter(({ type }) => type === 'sandbox.creation.ready').length, 1);
  sandbox.shutdown();
});

test('holding the requesting avatar automatically approves its build', async () => {
  const sandbox = makeSandbox([]);
  sandbox.start();
  assert.equal(sandbox.submit(viewer.userId, viewer.displayName, 'pink flower'), true);
  sandbox.setHeld(viewer.userId, true);
  await waitFor(() => sandbox.status().creations.length === 1);
  assert.equal(sandbox.status().pending.length, 0);
  sandbox.shutdown();
});

test('an OpenAI-style generator is never called until approval', async () => {
  let calls = 0;
  const sandbox = new CommunitySandbox({
    emit: () => undefined,
    participant: (userId) => userId === viewer.userId ? viewer : null,
    apiKey: '',
    generator: 'openai',
    generateBlueprint: async (prompt) => {
      calls += 1;
      return generateMockBlueprint(prompt);
    },
  });
  sandbox.start();
  sandbox.submit(viewer.userId, viewer.displayName, 'rocket');
  const request = sandbox.status().pending[0];
  assert.ok(request);
  await Promise.resolve();
  assert.equal(calls, 0);
  sandbox.setHeld(viewer.userId, true, 1000);
  assert.equal(sandbox.approve(request.id, viewer.userId, 1400), true);
  await waitFor(() => calls === 1 && sandbox.status().creations.length === 1);
  sandbox.shutdown();
});

test('pending requests expire without creating objects', async () => {
  const sandbox = makeSandbox([], 20);
  sandbox.start();
  assert.equal(sandbox.submit(viewer.userId, viewer.displayName, 'tiny castle'), true);
  await waitFor(() => sandbox.status().pending.length === 0);
  assert.equal(sandbox.status().creations.length, 0);
  sandbox.shutdown();
});

test('mock generator creates recognizable bounded examples', () => {
  for (const prompt of ['dragon', 'castle', 'tree', 'rocket', 'heart']) {
    const blueprint = generateMockBlueprint(prompt);
    assert.ok(blueprint.voxels.length >= 8 && blueprint.voxels.length <= 300);
    assert.ok(blueprint.palette.length <= 8);
    assert.ok(blueprint.voxels.some(({ y }) => y === 0));
  }
});

test('blueprint validator rejects duplicate and out-of-bounds voxels', () => {
  const valid = generateMockBlueprint('heart');
  const duplicate: VoxelBlueprint = { ...valid, voxels: [...valid.voxels, valid.voxels[0]] };
  assert.throws(() => validateVoxelBlueprint(duplicate), /Duplicate voxel/u);
  const invalid: VoxelBlueprint = {
    ...valid,
    voxels: valid.voxels.map((voxel, index) => index === 0 ? { ...voxel, x: 12 } : voxel),
  };
  assert.throws(() => validateVoxelBlueprint(invalid), /out of bounds/u);
});

function makeSandbox(emitted: ServerMessage[], requestLifetimeMs = 5000): CommunitySandbox {
  return new CommunitySandbox({
    emit: (message) => emitted.push(message),
    participant: (userId) => userId === viewer.userId ? viewer : null,
    apiKey: '',
    generator: 'mock',
    requestLifetimeMs,
    viewerCooldownMs: 5,
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for sandbox state.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
