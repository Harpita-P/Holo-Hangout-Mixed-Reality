import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { ViewerAvatarSystem } from './viewer-avatar-system.js';
import { PaintballBlasterSystem } from './paintball-blaster-system.js';
import { FloatingTerrainSystem } from './floating-terrain-system.js';
import { IslandBeeSystem } from './island-bee-system.js';
import { CommunitySandboxSystem } from './community-sandbox-system.js';

const container = document.getElementById('scene-container');
const landingBrand = document.getElementById('landing-brand');

if (!(container instanceof HTMLDivElement)) {
  throw new Error('HoloHangout scene container was not found.');
}

const labelArEntryButton = (): void => {
  for (const button of document.querySelectorAll('button')) {
    if (button.textContent?.trim().toLowerCase() === 'enter vr') {
      button.textContent = 'Enter AR';
      button.setAttribute('aria-label', 'Enter AR');
    }
  }
};

const entryButtonObserver = new MutationObserver(labelArEntryButton);
entryButtonObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
labelArEntryButton();

World.create(container, projectOptions)
  .then((world) => {
    world.renderer.xr.addEventListener('sessionstart', () => {
      if (landingBrand != null) landingBrand.hidden = true;
    });
    world.renderer.xr.addEventListener('sessionend', () => {
      if (landingBrand != null) landingBrand.hidden = false;
      labelArEntryButton();
    });
    world.registerSystem(CommunitySandboxSystem);
    world.registerSystem(ViewerAvatarSystem);
    world.registerSystem(PaintballBlasterSystem);
    world.registerSystem(FloatingTerrainSystem);
    world.registerSystem(IslandBeeSystem);
  })
  .catch((error: unknown) => {
    console.error('Unable to start the HoloHangout WebXR experience.', error);
  });
