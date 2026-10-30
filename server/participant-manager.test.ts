import assert from 'node:assert/strict';
import test from 'node:test';
import type { ServerMessage } from '../shared/protocol.js';
import { ParticipantManager } from './participant-manager.js';

test('commands affect only the sending viewer', () => {
  const emitted: ServerMessage[] = [];
  const manager = new ParticipantManager({ emit: (message) => emitted.push(message) });

  manager.handleChat({ userId: '1', displayName: 'Alpha', text: '!join' });
  manager.handleChat({ userId: '2', displayName: 'Beta', text: '!join' });
  manager.handleChat({ userId: '2', displayName: 'Beta', text: '!wave' });

  const action = emitted.findLast((message) => message.type === 'avatar.action');
  assert.deepEqual(action?.type === 'avatar.action' && action.userId, '2');
  assert.equal(manager.snapshot().find(({ userId }) => userId === '1')?.behavior, 'idle');
  assert.equal(manager.snapshot().find(({ userId }) => userId === '2')?.behavior, 'wave');
  manager.clear();
});

test('duplicate joins never allocate a second avatar', () => {
  const manager = new ParticipantManager({ emit: () => undefined });
  assert.equal(manager.handleChat({ userId: '1', displayName: 'Alpha', text: '!join' }), true);
  assert.equal(manager.handleChat({ userId: '1', displayName: 'Alpha', text: '!join' }), false);
  assert.equal(manager.snapshot().length, 1);
  manager.clear();
});

test('leave bypasses action cooldown and removes within its deadline', async () => {
  const emitted: ServerMessage[] = [];
  const manager = new ParticipantManager({
    emit: (message) => emitted.push(message),
    actionCooldownMs: 60_000,
    leaveDeadlineMs: 15,
  });
  manager.handleChat({ userId: '1', displayName: 'Alpha', text: '!join' });
  manager.handleChat({ userId: '1', displayName: 'Alpha', text: '!dance' });
  assert.equal(manager.handleChat({ userId: '1', displayName: 'Alpha', text: '!leave' }), true);
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(manager.snapshot().length, 0);
  assert.ok(emitted.some((message) => message.type === 'avatar.leave'));
  assert.ok(emitted.some((message) => message.type === 'avatar.removed'));
});

test('monster assignments rotate deterministically across ten slots', () => {
  const manager = new ParticipantManager({ emit: () => undefined });
  for (let index = 0; index < 10; index += 1) {
    assert.equal(
      manager.handleChat({
        userId: String(index),
        displayName: `Viewer ${index}`,
        text: '!join',
      }),
      true,
    );
  }
  assert.deepEqual(
    manager.snapshot().map(({ monsterType }) => monsterType),
    [
      'chicken',
      'blue-mushroom',
      'pink-flying',
      'green-sombrero',
      'pink-blob',
      'bee',
      'chicken',
      'blue-mushroom',
      'pink-flying',
      'green-sombrero',
    ],
  );
  manager.clear();
});

test('category-specific commands reject unsupported actions safely', () => {
  const manager = new ParticipantManager({ emit: () => undefined });
  manager.handleChat({ userId: 'blob', displayName: 'Blob', text: '!join' });
  manager.handleChat({ userId: 'big', displayName: 'Big', text: '!join' });
  manager.handleChat({ userId: 'flyer', displayName: 'Flyer', text: '!join' });

  assert.equal(manager.handleChat({ userId: 'blob', displayName: 'Blob', text: '!bite' }), true);
  assert.equal(manager.handleChat({ userId: 'big', displayName: 'Big', text: '!dance' }), false);
  assert.equal(manager.handleChat({ userId: 'flyer', displayName: 'Flyer', text: '!fly' }), true);
  assert.equal(manager.handleChat({ userId: 'flyer', displayName: 'Flyer', text: '!wave' }), false);
  assert.equal(manager.snapshot().find(({ userId }) => userId === 'blob')?.behavior, 'bite');
  assert.equal(manager.snapshot().find(({ userId }) => userId === 'flyer')?.behavior, 'fly');
  manager.clear();
});
