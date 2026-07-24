#!/usr/bin/env node
/* Headless smoke test: boot the WASM core in Node, run frames, verify that
   video output is non-trivial, audio sample counts match the model, and a
   savestate round-trips.

   Usage: node scripts/smoke-test.cjs [rom.sfc] [region]
   Defaults: roms/smario-world-USA.sfc, region auto(0)
*/

const fs = require('node:fs');
const path = require('node:path');

const projectDir = path.resolve(__dirname, '..');
const romPath = process.argv[2] ?? path.join(projectDir, 'roms/smario-world-USA.sfc');
const region = Number(process.argv[3] ?? 0); // auto

const SAMPLERATE = 48000;
const FRAMES = 600; // ~10s of emulated time

async function main() {
  // package.json declares "type": "module", so require() the UMD loader via
  // a .cjs copy; locateFile still resolves the wasm from dist/.
  const cjsCopy = path.join(projectDir, '.tmp/snes9x.smoke.cjs');
  fs.mkdirSync(path.dirname(cjsCopy), { recursive: true });
  fs.copyFileSync(path.join(projectDir, 'dist/snes9x/snes9x.js'), cjsCopy);
  const createSnes9xModule = require(cjsCopy);
  const mod = await createSnes9xModule({
    locateFile: (p) => path.join(projectDir, 'dist/snes9x', p),
  });

  if (!mod._s9xwasm_setup(SAMPLERATE, region, 2 /* gaussian */)) {
    throw new Error('core setup failed');
  }

  const rom = fs.readFileSync(romPath);
  const romPtr = mod._malloc(rom.length);
  mod.HEAPU8.set(rom, romPtr);
  if (!mod._s9xwasm_load_rom(romPtr, rom.length)) {
    throw new Error('ROM load failed');
  }
  mod._free(romPtr);

  const romName = mod.UTF8ToString(mod._s9xwasm_rom_name()).trim();
  const pal = !!mod._s9xwasm_is_pal();
  const framerate = mod._s9xwasm_framerate_micro() / 1e6;
  console.log(
    `loaded "${romName}" — ${(mod._s9xwasm_rom_size() / 1024).toFixed(0)}KB, ` +
      `${pal ? 'PAL' : 'NTSC'} @ ${framerate.toFixed(3)}Hz, ` +
      `SRAM ${mod._s9xwasm_sram_size()} bytes`,
  );

  mod._s9xwasm_reset();

  const expectedSamps = Math.round(SAMPLERATE / framerate) * 2;
  let sampsTotal = 0;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < FRAMES; i++) {
    sampsTotal += mod._s9xwasm_exec();
  }
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const avgSamps = sampsTotal / FRAMES;
  if (Math.abs(avgSamps - expectedSamps) > expectedSamps * 0.05) {
    throw new Error(
      `avg audio samps/frame ${avgSamps.toFixed(1)}, expected ~${expectedSamps}`,
    );
  }

  // Inspect the visible frame: count distinct colors and non-black pixels.
  const w = mod._s9xwasm_frame_width();
  const h = mod._s9xwasm_frame_height();
  const ptr = mod._s9xwasm_frame_rgba();
  const frame = mod.HEAPU8.subarray(ptr, ptr + w * h * 4);
  const colors = new Set();
  let nonBlack = 0;
  for (let i = 0; i < frame.length; i += 4) {
    const rgb = (frame[i] << 16) | (frame[i + 1] << 8) | frame[i + 2];
    colors.add(rgb);
    if (rgb !== 0) nonBlack++;
  }

  // Audio energy over the last frame's buffer.
  const lastSamps = mod._s9xwasm_exec();
  const aptr = mod._s9xwasm_audio_ptr();
  const audio = mod.HEAP16.subarray(aptr >> 1, (aptr >> 1) + lastSamps);
  let energy = 0;
  for (let i = 0; i < audio.length; i++) energy += Math.abs(audio[i]);

  // Savestate round-trip. Emulation is deterministic, so the frame produced
  // by the exec right after a restore must be byte-identical to the one the
  // exec right after the save produced — comparing against the frame at save
  // time would instead just measure one frame of animation.
  const stateSize = mod._s9xwasm_state_size();
  const statePtr = mod._s9xwasm_state_save();
  if (!statePtr || !stateSize) throw new Error('savestate failed');
  const state = mod.HEAPU8.slice(statePtr, statePtr + stateSize);

  mod._s9xwasm_exec();
  const expected = mod.HEAPU8.slice(
    mod._s9xwasm_frame_rgba(),
    mod._s9xwasm_frame_rgba() + w * h * 4,
  );

  for (let i = 0; i < 60; i++) mod._s9xwasm_exec();

  const loadPtr = mod._malloc(state.length);
  mod.HEAPU8.set(state, loadPtr);
  const ok = mod._s9xwasm_state_load(loadPtr, state.length);
  mod._free(loadPtr);
  if (!ok) throw new Error('savestate load failed');

  mod._s9xwasm_exec();
  const restored = mod.HEAPU8.subarray(
    mod._s9xwasm_frame_rgba(),
    mod._s9xwasm_frame_rgba() + w * h * 4,
  );
  let diff = 0;
  for (let i = 0; i < expected.length; i += 4) {
    if (expected[i] !== restored[i]) diff++;
  }

  const fps = (FRAMES / (elapsedMs / 1000)).toFixed(0);
  console.log(`ran ${FRAMES} frames in ${elapsedMs.toFixed(0)}ms (${fps} fps headless)`);
  console.log(
    `audio: ${sampsTotal} int16 total, ${expectedSamps} per frame expected, energy=${energy}`,
  );
  console.log(`video: ${w}x${h}, ${colors.size} distinct colors, ${nonBlack}/${w * h} non-black`);
  console.log(`state: ${stateSize} bytes, ${diff}/${w * h} pixels differ after restore`);

  if (colors.size < 8) throw new Error('framebuffer looks blank — video pipeline broken?');
  if (energy === 0) throw new Error('audio is silent — APU pipeline broken?');
  if (diff !== 0) throw new Error(`savestate restore diverged on ${diff} pixels`);
  console.log('SMOKE TEST PASS');
}

main().catch((err) => {
  console.error('SMOKE TEST FAIL:', err.message);
  process.exit(1);
});
