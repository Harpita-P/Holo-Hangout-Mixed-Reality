import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { ViewerAvatarSystem } from './viewer-avatar-system.js';
import { PaintballBlasterSystem } from './paintball-blaster-system.js';
import { FloatingTerrainSystem } from './floating-terrain-system.js';

const container = document.getElementById('scene-container');

if (!(container instanceof HTMLDivElement)) {
  throw new Error('ChatIRL scene container was not found.');
}

World.create(container, projectOptions)
  .then((world) => {
    world.registerSystem(ViewerAvatarSystem);
    world.registerSystem(PaintballBlasterSystem);
    world.registerSystem(FloatingTerrainSystem);
  })
  .catch((error: unknown) => {
    console.error('Unable to start the ChatIRL WebXR experience.', error);
  });
