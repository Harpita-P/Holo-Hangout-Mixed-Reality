import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  MONSTER_AUTONOMY_CLIPS,
  MONSTER_COMMANDS,
  MONSTER_ROSTER,
} from '../shared/monsters.js';

const runtimeFiles: Record<string, string> = {
  chicken: 'chicken.gltf',
  'blue-mushroom': 'blue-mushroom.gltf',
  'pink-flying': 'pink-flying.gltf',
  'green-sombrero': 'green-sombrero.gltf',
  'pink-blob': 'pink-blob.gltf',
  bee: 'bee.gltf',
};

test('production roster contains exactly six self-contained skinned models', async () => {
  assert.equal(MONSTER_ROSTER.length, 6);
  const directory = resolve('public/monsters');
  const seen = new Set<string>();
  for (const monster of MONSTER_ROSTER) {
    const filename = runtimeFiles[monster.type];
    const path = resolve(directory, filename);
    const gltf = JSON.parse(await readFile(path, 'utf8')) as {
      buffers?: Array<{ uri?: string }>;
      images?: Array<{ uri?: string; bufferView?: number }>;
      skins?: unknown[];
    };
    assert.equal((gltf.skins?.length ?? 0) > 0, true, `${monster.name} has a skin`);
    assert.equal(
      gltf.buffers?.every(({ uri }) => uri?.startsWith('data:')),
      true,
      `${monster.name} has no external buffers`,
    );
    assert.equal(
      gltf.images?.every(
        ({ uri, bufferView }) => uri?.startsWith('data:') || bufferView != null,
      ) ?? true,
      true,
      `${monster.name} has no external images`,
    );
    assert.equal((await stat(path)).size > 0, true);
    seen.add(filename);
  }
  assert.equal(seen.size, 6);
});

test('every mapped command and autonomy clip exists in its category models', async () => {
  for (const monster of MONSTER_ROSTER) {
    const path = resolve('public/monsters', runtimeFiles[monster.type]);
    const gltf = JSON.parse(await readFile(path, 'utf8')) as {
      animations?: Array<{ name?: string }>;
    };
    const available = new Set(
      (gltf.animations ?? []).flatMap(({ name }) => (name == null ? [] : [name])),
    );
    const autonomy = MONSTER_AUTONOMY_CLIPS[monster.category];
    const required = [
      autonomy.idle,
      autonomy.move,
      ...Object.values(MONSTER_COMMANDS[monster.category]).flatMap(
        ({ clips }) => clips,
      ),
    ];
    for (const clip of required) {
      assert.equal(available.has(clip), true, `${monster.name} provides ${clip}`);
    }
  }
});
