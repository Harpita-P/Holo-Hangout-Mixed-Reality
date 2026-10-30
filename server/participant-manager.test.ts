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

test('demo mode toggles six stable bots without duplicating or affecting real viewers', () => {
  const manager = new ParticipantManager({ emit: () => undefined });
  manager.handleChat({ userId: 'real-1', displayName: 'Real Viewer', text: '!join' });

  assert.deepEqual(manager.setDemoMode(true), {
    enabled: true,
    botCount: 6,
    realParticipantCount: 1,
    totalCount: 7,
    capacity: 10,
  });
  assert.deepEqual(
    manager.snapshot().filter(({ isBot }) => isBot).map(({ displayName }) => displayName),
    ['mochibot', 'pixelbot', 'bobabot', 'novabot', 'poppybot', 'ziggybot'],
  );
  assert.equal(manager.setDemoMode(true).botCount, 6);
  assert.equal(manager.snapshot().length, 7);

  const disabled = manager.setDemoMode(false);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.botCount, 0);
  assert.deepEqual(manager.snapshot().map(({ displayName }) => displayName), ['Real Viewer']);
  manager.clear();
});

test('real viewers displace bots at capacity and bots return after viewers leave', async () => {
  const manager = new ParticipantManager({ emit: () => undefined, leaveDeadlineMs: 10 });
  manager.setDemoMode(true);
  for (let index = 0; index < 10; index += 1) {
    assert.equal(
      manager.handleChat({
        userId: `real-${index}`,
        displayName: `Real ${index}`,
        text: '!join',
      }),
      true,
    );
  }
  assert.deepEqual(manager.demoStatus(), {
    enabled: true,
    botCount: 0,
    realParticipantCount: 10,
    totalCount: 10,
    capacity: 10,
  });

  manager.handleChat({ userId: 'real-0', displayName: 'Real 0', text: '!leave' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(manager.demoStatus().botCount, 1);
  assert.equal(manager.demoStatus().realParticipantCount, 9);
  assert.equal(manager.demoStatus().totalCount, 10);
  manager.clear();
  assert.deepEqual(manager.demoStatus(), {
    enabled: false,
    botCount: 0,
    realParticipantCount: 0,
    totalCount: 0,
    capacity: 10,
  });
});

test('demo bots never appear in the community leaderboard', () => {
  const manager = new ParticipantManager({ emit: () => undefined });
  manager.setDemoMode(true);
  assert.deepEqual(manager.leaderboardMessage().entries, []);
  assert.equal(
    manager.handleChat({ userId: 'real', displayName: 'Real', text: '!join' }),
    true,
  );
  assert.deepEqual(manager.leaderboardMessage().entries, [
    { userId: 'real', displayName: 'Real', score: 0 },
  ]);
  manager.clear();
});

test('fresh real joins emit one welcome and callback while duplicates and bots do not', () => {
  const emitted: ServerMessage[] = [];
  const joined: string[] = [];
  const manager = new ParticipantManager({
    emit: (message) => emitted.push(message),
    onRealViewerJoined: (participant) => joined.push(participant.userId),
  });
  manager.setDemoMode(true);
  manager.handleChat({ userId: 'viewer-1', displayName: 'ViewerOne', text: '!join' });
  manager.handleChat({ userId: 'viewer-1', displayName: 'ViewerOne', text: '!join' });

  assert.deepEqual(joined, ['viewer-1']);
  assert.deepEqual(
    emitted.filter((message) => message.type === 'viewer.welcome'),
    [{ type: 'viewer.welcome', userId: 'viewer-1', displayName: 'ViewerOne' }],
  );
  manager.clear();
});

test('universal reactions are real-viewer only, cooldown protected, and scored', () => {
  const emitted: ServerMessage[] = [];
  const manager = new ParticipantManager({
    emit: (message) => emitted.push(message),
    scoreCooldownMs: 0,
  });
  manager.handleChat({ userId: 'viewer-1', displayName: 'ViewerOne', text: '!join' });

  assert.equal(
    manager.handleChat({ userId: 'viewer-1', displayName: 'ViewerOne', text: '!support' }),
    true,
  );
  assert.equal(
    manager.handleChat({ userId: 'viewer-1', displayName: 'ViewerOne', text: '!like' }),
    false,
  );
  assert.ok(
    emitted.some(
      (message) =>
        message.type === 'avatar.reaction' &&
        message.userId === 'viewer-1' &&
        message.reaction === 'support',
    ),
  );
  assert.equal(manager.leaderboardMessage().entries[0]?.score, 2);
  assert.deepEqual(
    manager.snapshot().find(({ userId }) => userId === 'viewer-1')?.supportedCommands.slice(-4),
    ['!support', '!like', '!fire', '!leave'],
  );
  manager.clear();
});
