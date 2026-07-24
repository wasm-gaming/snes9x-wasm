# @wasm-gaming/snes9x-wasm

[Snes9x](https://github.com/snes9xgit/snes9x) — the long-running **Super
Nintendo / Super Famicom** emulator — compiled to WebAssembly via Emscripten
and packaged as a wasm-gaming engine SDK.

This subproject follows the same engine-package approach used by geolith-wasm,
fbneo-wasm, jgenesis-wasm, blastem-wasm, and rsdkv*:

- typed `manifest`
- typed `options`
- `load(config)` engine SDK surface
- Makefile-driven build (`build-sdk`, `build-wasm`, `preview`)

It conforms to the [`@wasm-gaming/engine-specs`](https://github.com/wasm-gaming/engine-specs)
contract (`EngineSDK` = `{ manifest, load }`).

Snes9x ships several frontend ports (`unix/`, `gtk/`, `libretro/`); none of
them suit a browser, so this package supplies its own
([scripts/shim/s9x_shim.cpp](scripts/shim/s9x_shim.cpp)) instead of an
Emscripten SDL layer: **no ASYNCIFY, no SDL, no emulated GL**. The JS SDK
drives one `S9xMainLoop()` per frame, blits the framebuffer to a 2D canvas,
and streams audio through an `AudioWorklet` ring buffer. Emulation is
**audio-clocked**: frames are produced to keep ~90 ms of audio queued, which
locks speed to the audio hardware with no resampling drift.

## ROM format

Pass the cartridge image as the `rom` asset: `.sfc`, `.smc`, `.fig` or `.swc`.
The 512-byte copier headers some dumps carry are detected and skipped by the
core, so both headered and unheadered images work. No BIOS is needed.

Enhancement chips are emulated in-core and need no extra files: **Super FX /
FX2**, **SA-1**, **DSP-1/2/3/4**, **S-DD1**, **SPC7110**, **C4**, **OBC1**,
**S-RTC**, **SETA ST-010/011/018**, and **MSU-1**.

The video standard follows the cartridge header (`options.region: 'auto'`),
which is right for effectively every commercial release; force it with
`'ntsc'` / `'pal'` for homebrew and hacks with a wrong or missing header.

## Contract surface

```js
import { manifest, load } from '@wasm-gaming/snes9x-wasm';

const engine = await load({
  canvasEl: canvas,               // or attachTo: containerEl
  assets: {
    rom: sfcFileBytes,            // .sfc/.smc cartridge image
  },
  options: { region: 'auto', aspect: '4:3' },
  persist: 'opfs',
  storageNamespace: 'smw',
  onEvent: (e) => console.log(e),
});
engine.start();
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `region` | `auto` | Video standard: `auto` (from the ROM header), `ntsc` (60.098 Hz) or `pal` (50.007 Hz). |
| `interpolation` | `gaussian` | DSP sample interpolation. `gaussian` matches real hardware; `none`/`linear`/`cubic`/`sinc` trade accuracy for sharpness. |
| `renderFilter` | `pixelated` | Canvas scaling filter (`pixelated` or `smooth`). |
| `cropOverscan` | `true` | Crop the picture to 224 lines. Disable to see all 239, including the rows many games leave as garbage. |
| `aspect` | `4:3` | Presented aspect ratio: `4:3` (as on a CRT) or `1:1` square pixels. |
| `multitap` | `false` | Emulate the 5-player Multitap in port 2 (pads 2-5). |
| `maxSpriteTilesPerLine` | `34` | `34` matches hardware, including its sprite flicker; `128` removes dropout. |
| `superFXClockMultiplier` | `100` | Super FX clock as a percentage of stock. Above 100 speeds up Star Fox / Yoshi's Island; a hack, not accuracy. |
| `volume` | `1.0` | Master audio volume (0–1). |
| `gamepads` | `true` | Poll connected gamepads (standard mapping) each frame. |
| `logLevel` | `error` | Core messages printed to the console (`off`, `error`, `debug`). |

### Capabilities

- **Save states**: `saveState()` / `loadState()` via the core's in-memory
  snapshot API (`S9xFreezeGameMem`), ~800 KB for a typical cart.
- **SRAM persistence**: battery-backed cartridge SRAM is persisted to OPFS
  (`snes9x/<storageNamespace>/sram.bin`) on pause/destroy and every 15 s;
  `purgeStorage()` removes the active namespace.
- **Screenshots**: `screenshot()` returns a PNG blob.

### Default controls

The face buttons follow the pad's own diamond layout on the keyboard: the
bottom row is B/Y, the row above is A/X.

| Control | P1 | P2 |
|---------|----|----|
| D-pad | Arrow keys | I/K/J/L |
| B / A | X / S | N / H |
| Y / X | Z / A | B / G |
| L / R | Q / W | T / Y |
| Start | Enter | 2 |
| Select | Right Shift | 1 |

Gamepads (standard mapping) are polled automatically. Because the SNES face
buttons sit rotated relative to a modern pad, the physical bottom/right
buttons map to B/A and the left/top ones to Y/X — the layout every SNES pad
has had.

Rebind via `engine.setInput({ 'p1.b': 'KeyJ', ... })` (KeyboardEvent codes).

## Build

```sh
make build        # Full build: WASM (Docker/Emscripten) + TypeScript SDK
make build-sdk    # TypeScript only (SDK + manifest + demo shell)
make build-wasm   # Snes9x WASM only (via Docker)
make preview      # Serve dist/ at :8029 with COOP/COEP headers
make smoke        # Headless boot test (needs a ROM in roms/)
```

The WASM build clones a pinned Snes9x revision and compiles the enumerated
core sources directly with `emcc` — no upstream-makefile patching and no
autotools. The source list mirrors `SOURCES_CXX` in
`libretro/Makefile.common`, minus the libretro port itself.

## WASM artifacts

| File | Description |
|------|-------------|
| `snes9x.js` | Emscripten module loader (`createSnes9xModule`). |
| `snes9x.wasm` | Compiled Snes9x core + shim (~2.1 MB). |

No SharedArrayBuffer or COOP/COEP headers are required at runtime (the
preview server sets them anyway for parity with sibling engines).

See [CORE.md](CORE.md) for the mapping between upstream Snes9x capabilities
and what this wrapper exposes.
