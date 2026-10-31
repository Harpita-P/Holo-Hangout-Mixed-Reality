import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  HangoutMomentsService,
  type TwitchClipGateway,
  type VerifiedClip,
} from './hangout-moments.js';

class FakeGateway implements TwitchClipGateway {
  authorized = true;
  live = true;
  creates = 0;
  polls = 0;
  readyAfter = 1;

  clipsAuthorized(): boolean { return this.authorized; }
  async isBroadcasterLive(): Promise<boolean> { return this.live; }
  async createClip(): Promise<{ id: string }> {
    this.creates += 1;
    return { id: `clip-${this.creates}` };
  }
  async getClip(id: string): Promise<VerifiedClip | null> {
    this.polls += 1;
    if (this.polls < this.readyAfter) return null;
    return { id, url: `https://clips.twitch.tv/${id}`, title: 'Moment', createdAt: '2026-01-01T00:00:00Z' };
  }
}

async function fixture(
  t: test.TestContext,
  gateway: FakeGateway,
  now = 1_000_000,
): Promise<{ service: HangoutMomentsService; verified: VerifiedClip[] }> {
  const directory = await mkdtemp(join(tmpdir(), 'hangout-moments-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const verified: VerifiedClip[] = [];
  const service = new HangoutMomentsService(
    gateway,
    join(directory, 'moments.json'),
    () => undefined,
    (clip) => verified.push(clip),
    () => now,
    0,
    3,
  );
  await service.load();
  return { service, verified };
}

test('automatic moment verifies once and suppresses duplicate/cooldown requests', async (t) => {
  const gateway = new FakeGateway();
  gateway.readyAfter = 2;
  const { service, verified } = await fixture(t, gateway);
  await service.setAutoClipEnabled(true);
  assert.equal((await service.completeChallenge('run-1')).state, 'ready');
  assert.equal(gateway.creates, 1);
  assert.equal(verified.length, 1);
  await service.completeChallenge('run-1');
  await service.completeChallenge('run-2');
  assert.equal(gateway.creates, 1);
  assert.match(service.status().message, /cooldown/i);
});

test('offline and missing-scope clip requests remain unavailable without creating', async (t) => {
  const gateway = new FakeGateway();
  gateway.live = false;
  const { service } = await fixture(t, gateway);
  assert.equal((await service.createManualMoment()).state, 'unavailable');
  assert.equal(gateway.creates, 0);
  gateway.live = true;
  gateway.authorized = false;
  assert.equal((await service.createManualMoment()).state, 'unavailable');
  assert.match(service.status().message, /reconnect/i);
  assert.equal(gateway.creates, 0);
});
