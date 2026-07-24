# Snes9x core ↔ wrapper mapping

Upstream: https://github.com/snes9xgit/snes9x (pinned in
[scripts/build-snes9x.sh](scripts/build-snes9x.sh), see `SNES9X_REF`).

Snes9x is a core plus a choice of frontend ports (`unix/`, `gtk/`, `qt/`,
`win32/`, `macosx/`, `libretro/`). This wrapper **compiles none of them** —
[scripts/shim/s9x_shim.cpp](scripts/shim/s9x_shim.cpp) supplies the same
`S9x*` callbacks the core links against (from `display.h`, `controls.h`,
`fscompat.h`) and exposes a flat C ABI to JS. The compiled source list mirrors
`SOURCES_CXX` in `libretro/Makefile.common`.

## What is exposed

| Upstream capability | This wrapper |
|---------------------|--------------|
| Cartridge loading from memory (`Memory.LoadROMMem`) | ✅ `assets.rom` (`.sfc`/`.smc`/`.fig`/`.swc`, copier headers auto-stripped) |
| NTSC / PAL, auto-detected from the ROM header | ✅ `options.region` (`auto`/`ntsc`/`pal`) |
| Video: 16-bit framebuffer, 256/512 × 224/239/448/478 | ✅ built with `PIXEL_FORMAT=RGB565`, converted to RGBA → 2D canvas; geometry re-read every frame so hi-res and interlace switches are followed |
| Overscan cropping | ✅ `options.cropOverscan` (224-line crop, offsets from the libretro port) |
| Audio: SPC700/DSP → resampler → int16 stereo | ✅ APU asked for the `AudioContext` rate directly, so there is no second resampling stage; AudioWorklet sink |
| DSP interpolation (gaussian/linear/cubic/sinc/none) | ✅ `options.interpolation` |
| Save states (`S9xFreezeGameMem` / `S9xUnfreezeGameMem`) | ✅ `saveState`/`loadState`, sized via `nulStream` |
| Battery-backed cartridge SRAM (`Memory.SRAM`) | ✅ persisted to OPFS |
| 2 controllers, rebindable | ✅ keyboard + gamepads (`setInput`) |
| 5-player Multitap (`CTL_MP5`) | ✅ `options.multitap` (pads 2-5) |
| Enhancement chips: Super FX/FX2, SA-1, DSP-1/2/3/4, S-DD1, SPC7110, C4, OBC1, S-RTC, SETA ST-010/011/018 | ✅ compiled in, no extra assets needed |
| Sprite-per-line limit, Super FX overclock | ✅ `options.maxSpriteTilesPerLine`, `options.superFXClockMultiplier` |
| MSU-1 (streamed audio/data) | ⚠️ compiled in, but the side files it reads (`<rom>.msu`, `<rom>-N.pcm`) are never mounted, so it is effectively off |
| BS-X, Sufami Turbo, multi-cart | ❌ needs `LoadMultiCartMem` plus BIOS assets; not wired |
| Mouse, Super Scope, Justifier, Macs Rifle | ❌ masters disabled in `s9xwasm_setup`; only joypads are wired |
| Cheats (`cheats.cpp`) | ❌ compiled in, no API exposed |
| Movie recording (`movie.cpp`) | ❌ compiled in, needs a filesystem |
| NTSC composite filter (`filter/snes_ntsc.c`) | ❌ not compiled; the SDK scales with CSS instead |
| Netplay (`netplay.cpp`, `server.cpp`) | ❌ not compiled |

## Timing model

- One `s9xwasm_exec()` = one `S9xMainLoop()` = one emulated frame, which ends
  by calling back into `S9xDeinitUpdate()` — where the shim converts the
  frame to RGBA. `S9xSyncSpeed()` is a deliberate no-op: the host paces.
- The APU resamples to `Settings.SoundPlaybackRate`, which the SDK sets to the
  browser's actual `AudioContext.sampleRate`, so produced audio matches
  consumed audio exactly at native speed (1598 int16/frame at 48 kHz NTSC).
- The SDK runs frames only when the audio ring buffer is below ~90 ms
  (audio-clocked pacing). When the AudioContext is suspended (autoplay
  policy) **or its clock has stalled** — which happens when there is no
  output device at all, as in a headless browser — it falls back to
  wall-clock pacing so the picture keeps moving.

## Build notes

- `UNZIP_SUPPORT` must stay **undefined**, not defined to 0: `stream.h` tests
  it with `#ifdef`, so defining it at all pulls in `unzip.h`.
- MEMFS stays **enabled** (`-sFILESYSTEM=0` is not used). ROMs, SRAM and save
  states all travel through memory, but the core still probes for optional
  side files (MSU-1 audio, cheats, movies); with the filesystem stubbed out
  those `fopen()` calls succeed against a stub and the core then acts on
  files that do not exist — MSU-1 in particular latches on.
- `-sSTACK_SIZE=5242880`: the default 64 KB is not enough for `snapshot.cpp`,
  which walks large descriptor tables while freezing.
- `memmap.cpp` prints its memory-map choice (`Map_LoROMMap`) with a bare
  `printf`, so that one line reaches the console regardless of
  `options.logLevel`, which only gates `S9xMessage`.
