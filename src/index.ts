import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { ViewerAvatarSystem } from './viewer-avatar-system.js';
import { PaintballBlasterSystem } from './paintball-blaster-system.js';
import { FloatingTerrainSystem } from './floating-terrain-system.js';
import { IslandBeeSystem } from './island-bee-system.js';

const container = document.getElementById('scene-container');

if (!(container instanceof HTMLDivElement)) {
  throw new Error('HoloHangout scene container was not found.');
}

World.create(container, projectOptions)
  .then((world) => {
    world.registerSystem(ViewerAvatarSystem);
    world.registerSystem(PaintballBlasterSystem);
    world.registerSystem(FloatingTerrainSystem);
    world.registerSystem(IslandBeeSystem);
  })
  .catch((error: unknown) => {
    console.error('Unable to start the HoloHangout WebXR experience.', error);
  });
