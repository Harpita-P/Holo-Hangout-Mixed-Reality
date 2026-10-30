import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';

const container = document.getElementById('scene-container');

if (!(container instanceof HTMLDivElement)) {
  throw new Error('ChatIRL scene container was not found.');
}

World.create(container, projectOptions).catch((error: unknown) => {
  console.error('Unable to start the ChatIRL WebXR experience.', error);
});
