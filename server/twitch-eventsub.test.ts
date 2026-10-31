import assert from 'node:assert/strict';
import test from 'node:test';
import { TwitchEventSub } from './twitch-eventsub.js';

test('Twitch authorization requests chat and clip permissions', () => {
  const twitch = new TwitchEventSub(
    {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'http://localhost/callback',
    },
    () => undefined,
    () => undefined,
  );
  const url = new URL(twitch.createAuthorizationUrl('state'));
  assert.deepEqual(new Set(url.searchParams.get('scope')?.split(' ')), new Set([
    'user:read:chat',
    'user:write:chat',
    'clips:edit',
  ]));
});
