import { defineComponents } from '@iwsdk/core';
import { MonsterAvatar } from './monster-avatar-component.js';
import { ViewerAvatar } from './viewer-avatar-component.js';
import { PaintballBlaster } from './paintball-blaster-component.js';
import { FloatingTerrain } from './floating-terrain-component.js';
import { IslandBee } from './island-bee-component.js';

export default defineComponents([
  ViewerAvatar,
  MonsterAvatar,
  PaintballBlaster,
  FloatingTerrain,
  IslandBee,
]);
