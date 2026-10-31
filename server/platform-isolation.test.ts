import assert from 'node:assert/strict';
import test from 'node:test';
import type { ServerMessage } from '../shared/protocol.js';
import { ParticipantManager } from './participant-manager.js';

test('streamer participant managers route viewer events to separate worlds', () => {
  const worldA: ServerMessage[] = [];
  const worldB: ServerMessage[] = [];
  const managerA = new ParticipantManager({ emit: (message) => worldA.push(message) });
  const managerB = new ParticipantManager({ emit: (message) => worldB.push(message) });
  assert.equal(managerA.handleChat({ userId: 'viewer-a', displayName: 'ViewerA', text: '!join' }), true);
  assert.equal(managerB.snapshot().length, 0);
  assert.equal(worldB.length, 0);
  assert.equal(managerB.handleChat({ userId: 'viewer-b', displayName: 'ViewerB', text: '!join' }), true);
  assert.deepEqual(managerA.snapshot().map(({ userId }) => userId), ['viewer-a']);
  assert.deepEqual(managerB.snapshot().map(({ userId }) => userId), ['viewer-b']);
  managerA.clear();
  managerB.clear();
});
