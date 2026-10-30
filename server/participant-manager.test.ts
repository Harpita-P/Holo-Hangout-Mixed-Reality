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

test('duplicate joins resync the existing avatar without reallocating it', () => {
  const emitted: ServerMessage[] = [];
  const manager = new ParticipantManager({ emit: (message) => emitted.push(message) });
  assert.equal(manager.handleChat({ userId: '1', displayName: 'Alpha', text: '!join' }), true);
  const original = manager.snapshot()[0];
  assert.equal(manager.handleChat({ userId: '1', displayName: 'Alpha', text: '!join' }), true);
  assert.equal(manager.snapshot().length, 1);
  assert.equal(manager.snapshot()[0]?.monsterType, original?.monsterType);
  assert.equal(emitted.filter((message) => message.type === 'avatar.join').length, 2);
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

test('normal chat is filtered, rate-limited, and emitted only for joined viewers', async () => {
  const emitted: ServerMessage[] = [];
  const manager = new ParticipantManager({
    emit: (message) => emitted.push(message),
    chatCooldownMs: 15,
  });

  assert.equal(manager.handleChat({ userId: '1', displayName: 'Alpha', text: 'hello' }), false);
  manager.handleChat({ userId: '1', displayName: 'Alpha', text: '!join' });
  assert.equal(manager.handleChat({ userId: '1', displayName: 'Alpha', text: '!unknown' }), false);
  assert.equal(
    manager.handleChat({ userId: '1', displayName: 'Alpha', text: `  hi\u0000 ${'💕'.repeat(60)}  ` }),
    true,
  );
  assert.equal(manager.handleChat({ userId: '1', displayName: 'Alpha', text: 'too soon' }), false);

  const firstChat = emitted.find((message) => message.type === 'avatar.chat');
  assert.equal(firstChat?.type, 'avatar.chat');
  assert.equal(firstChat?.type === 'avatar.chat' && firstChat.userId, '1');
  assert.ok(firstChat?.type === 'avatar.chat' && [...firstChat.text].length <= 100);
  assert.ok(firstChat?.type === 'avatar.chat' && !firstChat.text.includes('\u0000'));

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(manager.handleChat({ userId: '1', displayName: 'Alpha', text: 'new message' }), true);
  assert.equal(emitted.filter((message) => message.type === 'avatar.chat').length, 2);
  manager.handleChat({ userId: '1', displayName: 'Alpha', text: '!leave' });
  assert.equal(manager.handleChat({ userId: '1', displayName: 'Alpha', text: 'after leave' }), false);
  manager.clear();
});

test('community leaderboard scores accepted activity and tracks current members only', () => {
  const emitted: ServerMessage[] = [];
  const manager = new ParticipantManager({
    emit: (message) => emitted.push(message),
    actionCooldownMs: 0,
    chatCooldownMs: 0,
    scoreCooldownMs: 0,
    leaveDeadlineMs: 10,
  });

  manager.handleChat({ userId: 'alpha', displayName: 'Alpha', text: '!join' });
  manager.handleChat({ userId: 'beta', displayName: 'Beta', text: '!join' });
  manager.handleChat({ userId: 'alpha', displayName: 'Alpha', text: '!dance' });
  manager.handleChat({ userId: 'alpha', displayName: 'Alpha', text: 'hello!' });
  manager.handleChat({ userId: 'beta', displayName: 'Beta', text: '!unsupported' });
  manager.handleChat({ userId: 'beta', displayName: 'Beta', text: 'hi!' });

  assert.deepEqual(manager.leaderboardMessage().entries, [
    { userId: 'alpha', displayName: 'Alpha', score: 3 },
    { userId: 'beta', displayName: 'Beta', score: 1 },
  ]);
  manager.handleChat({ userId: 'alpha', displayName: 'Alpha', text: '!leave' });
  assert.deepEqual(manager.leaderboardMessage().entries, [
    { userId: 'beta', displayName: 'Beta', score: 1 },
  ]);
  assert.ok(emitted.some((message) => message.type === 'community.leaderboard'));
  manager.clear();
});
