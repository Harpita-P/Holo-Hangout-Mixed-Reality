import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PlatformStore, type StreamerAccount } from './platform-store.js';

function account(id: string, worldId: string): StreamerAccount {
  return {
    twitchUserId: id,
    login: `streamer_${id}`,
    worldId,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    token: {
      accessToken: `access-secret-${id}`,
      refreshToken: `refresh-secret-${id}`,
      expiresAt: 9_999_999,
      userId: id,
      login: `streamer_${id}`,
    },
    settings: { acceptingJoins: true, demoEnabled: false },
  };
}

test('platform storage encrypts tokens and restores isolated streamer records', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'holohangout-platform-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'platform.json');
  const secret = 'storage-secret-long-enough-for-test';
  const store = new PlatformStore(path, secret);
  await Promise.all([
    store.save(account('a', 'world-a')),
    store.save(account('b', 'world-b')),
  ]);
  const raw = await readFile(path, 'utf8');
  assert.doesNotMatch(raw, /access-secret|refresh-secret/u);

  const restored = new PlatformStore(path, secret);
  await restored.load();
  assert.equal(restored.findByWorld('world-a')?.twitchUserId, 'a');
  assert.equal(restored.findByWorld('world-b')?.twitchUserId, 'b');
  assert.equal(restored.get('a')?.token.refreshToken, 'refresh-secret-a');
});
