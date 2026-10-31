import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { HostedTwitchAccount, verifyTwitchWebhook } from './hosted-twitch.js';

test('hosted Twitch authorization requests only chat and clip scopes', () => {
  const account = new HostedTwitchAccount(
    {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://api.example.com/auth/twitch/callback',
      eventSubCallbackUrl: 'https://api.example.com/twitch/eventsub',
      eventSubSecret: 'eventsub-secret',
    },
    () => undefined,
    () => undefined,
  );
  const url = new URL(account.createAuthorizationUrl('state'));
  assert.deepEqual(new Set(url.searchParams.get('scope')?.split(' ')), new Set([
    'user:read:chat',
    'user:write:chat',
    'clips:edit',
  ]));
  assert.equal(url.searchParams.get('state'), 'state');
});

test('Twitch webhook verification accepts authentic current messages only', () => {
  const now = Date.parse('2026-10-31T12:00:00.000Z');
  const timestamp = new Date(now).toISOString();
  const messageId = 'message-1';
  const body = '{"event":{"broadcaster_user_id":"a"}}';
  const secret = 'eventsub-secret';
  const signature = `sha256=${createHmac('sha256', secret)
    .update(messageId + timestamp + body)
    .digest('hex')}`;
  const headers = {
    'twitch-eventsub-message-id': messageId,
    'twitch-eventsub-message-timestamp': timestamp,
    'twitch-eventsub-message-signature': signature,
  };
  assert.equal(verifyTwitchWebhook(headers, body, secret, now), true);
  assert.equal(verifyTwitchWebhook(headers, `${body}x`, secret, now), false);
  assert.equal(verifyTwitchWebhook(headers, body, secret, now + 11 * 60_000), false);
});
