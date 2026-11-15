// The engine owns its folder: every namespace resolves under snes9x/, and none can
// climb out of it. Runs against the built SDK (make build-sdk), the module a host
// actually imports — which also proves it loads with no import map or bundler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Snes9xSDK, { storagePath, STATE_SLOTS, AUTO_STATE_SLOT, SNES9X_SPEC } from '../dist/snes9x/snes9x.sdk.js';

const cases = [
  [undefined, 'default', 'snes9x/default', false],
  ['', 'default', 'snes9x/default', false],
  [{ id: 'zelda' }, 'default', 'snes9x/default', false],
  ['super-metroid', 'super-metroid', 'snes9x/super-metroid', false],
  ['zelda/profile-a', 'zelda/profile-a', 'snes9x/zelda/profile-a', false],
  [' a b /c? ', 'a_b/c_', 'snes9x/a_b/c_', false],
  ['../x', 'x', 'snes9x/x', false],
  ['..', 'default', 'snes9x/default', false],
  ['/abs/path', 'abs/path', 'snes9x/abs/path', false],
  ['snes9x/Zelda', 'Zelda', 'snes9x/Zelda', true],
  ['snes9x', 'snes9x', 'snes9x/snes9x', false],
];

for (const [input, namespace, path, prefixed] of cases) {
  test(`storagePath('snes9x', ${JSON.stringify(input)}) → ${path}`, () => {
    assert.deepEqual(storagePath('snes9x', input), { namespace, path, prefixed });
  });
}

test('the engine id is the folder', () => {
  assert.equal(Snes9xSDK.id, 'snes9x');
});

test('the slots are the other engines\' slots: 0-3 and the unsaved point in 9', () => {
  assert.equal(STATE_SLOTS, 4);
  assert.equal(AUTO_STATE_SLOT, 9);
});

test('the spec describes every option of the settings catalog', () => {
  assert.deepEqual(SNES9X_SPEC.assets.rom.allowedTypes, ['.sfc', '.smc', '.fig', '.swc']);
  assert.equal(SNES9X_SPEC.storage.namespace.default, 'default');
  assert.equal(SNES9X_SPEC.options.region.default, 'auto');
  assert.equal(SNES9X_SPEC.options.region.live, false, 'region needs a reset');
  assert.equal(SNES9X_SPEC.options.volume.live, true);
  assert.equal(SNES9X_SPEC.options.escMenu.default, true);
  assert.deepEqual(SNES9X_SPEC.options.interpolation.enum, ['none', 'linear', 'gaussian', 'cubic', 'sinc']);
});

test('a play opened without a ROM says so', async () => {
  // No DOM here: mount() is skipped, so start() stops at the first missing piece.
  await assert.rejects(() => new Snes9xSDK().start(), /mount\(\)|ROM/);
});
