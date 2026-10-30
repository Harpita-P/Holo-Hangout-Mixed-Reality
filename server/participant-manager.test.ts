import assert from 'node:assert/strict';
import test from 'node:test';
import type { ServerMessage } from '../shared/protocol.js';
import { ParticipantManager } from './participant-manager.js';

test('commands affect only the sending viewer', () => {
  const emitted: ServerMessage[] = [];
  const manager = new ParticipantManager({ emit: (message) => emitted.push(message) });

  manager.handleChat({ userId: '1', displayName: 'Alpha', text: '!join' });
  manager.handleChat({ userId: '2', displayName: 'Beta', text: '!join' });
  manager.handleChat({ userId: '2', displayName: 'Beta', text: '!dance' });

  const action = emitted.findLast((message) => message.type === 'avatar.action');
  assert.deepEqual(action?.type === 'avatar.action' && action.userId, '2');
  assert.equal(manager.snapshot().find(({ userId }) => userId === '1')?.behavior, 'idle');
  assert.equal(manager.snapshot().find(({ userId }) => userId === '2')?.behavior, 'dance');
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
