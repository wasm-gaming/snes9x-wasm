# @wasm-gaming/snes9x-wasm

[Snes9x](https://github.com/snes9xgit/snes9x) — the long-running **Super
Nintendo / Super Famicom** emulator — compiled to WebAssembly via Emscripten
and packaged as a wasm-gaming engine SDK.

It implements the [`@wasm-gaming/engine-specs`](https://github.com/wasm-gaming/engine-specs)
contract 1.0 (`Snes9xSDK` / `Snes9xPlay`), ships its own app (suspend points, save states in the
pause menu, menus by touch), and builds through the Makefile (`build-sdk`, `build-wasm`,
`preview`).

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

The wasm-gaming engine contract 1.0 (`@wasm-gaming/engine-specs`): a self-contained ESM
package (the contract's runtime ships beside the SDK — no bundler, no import map).

```js
import Snes9xSDK from '@wasm-gaming/snes9x-wasm';

const play = await new Snes9xSDK()
  .options({ region: 'auto', aspect: '4:3' })
  .assets({ rom: () => file.arrayBuffer() })        // bytes, or a thunk
  .storage({ namespace: 'super-metroid' })          // → OPFS snes9x/super-metroid/
  .on('saves', ({ detail }) => console.log('saved', detail.files))
  .mount(document.querySelector('#stage'))          // a <canvas> is used as is; anything else gets one
  .start();

play.pause('menu');                                  // the first caller owns the pause…
play.resume('menu');                                 // …and only it lifts it; sound stops too
await play.states.save(0, { thumbnail: await play.snapshot() });
play.states.load(0);                                 // slots 0-3, plus 9 (the suspend point)
await play.restart();                                // power cycle
await play.destroy();                                // battery RAM flushed, loop stopped, audio closed
```

Files in OPFS `snes9x/<namespace>/`: `sram.bin` (battery RAM: every 15 s, on pause, when the
page is hidden and on destroy) and per save-state slot `slot_N.state`, `slot_N.png`,
`slot_N.lock`. `play.settings` is the live settings façade (the options below).

## The engine's own app

A host that would rather not draw menus mounts the app shipped next to the SDK (engine-specs
`EngineApp`, `UX.md`) — the same app as blastem-wasm's and fbneo-wasm's:

```js
const app = await import('@wasm-gaming/snes9x-wasm/app'); // dist/snes9x/app/app.js
const handle = await app.mount(element, { game, storage, assets, input, exit });
```

Suspend points the way the Nintendo Classic Mini does them, and a pause menu on Select + Start or
Escape with the four save-state slots in it (an empty one saves at once; a saved one offers
*Cargar*, *Guardar aquí*, *Bloquear*, *Borrar*). Menus work by touch too. Through the app the
Escape settings overlay is off: Escape is the pause menu's.

Gamepads are read from `navigator.getGamepads()` (pad 0 is player 1, by position: B 0, A 1, Y 2,
X 3, L 4, R 5, Select 8, Start 9) — so engine-specs' on-screen touch pad (`TOUCH_LAYOUTS.snes`)
plays it with no change here.

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
| `escMenu` | `true` | Show the built-in in-game settings menu when the player presses Escape. |

## In-game settings menu

Snes9x keeps its configuration in the core's global `Settings` struct, which
the emulation re-reads as it runs — the DSP consults the interpolation mode per
sample, the PPU the sprite limit per scanline — so almost every option above
can be changed without restarting the game. The SDK mounts a settings overlay
over the viewport that does exactly that — **press Escape** to open it (off when
the engine app runs the game: there Escape opens the pause menu).

- ↑ ↓ select · ← → change · Enter apply · Esc close (mouse works too)
- Changes persist per storage namespace in `localStorage` and are re-applied
  on the next start. Explicit `options` passed by the host still win.
- `region` is tagged **needs reset**: the core reads the forced video standard
  while it maps the cartridge and clears it there, so the menu's *Reset game*
  re-maps the ROM to apply it (battery RAM is carried across).
- Settings the loaded `snes9x.wasm` cannot apply — a build predating one of the
  shim's setters — are omitted rather than erroring, so the menu degrades
  cleanly against an older artifact.

Pass `options: { escMenu: false }` to suppress it and drive the settings
yourself:

```js
play.settings.write('maxSpriteTilesPerLine', 128); // no sprite dropout
play.settings.read('interpolation');               // 'gaussian'
play.options({ volume: 0.5 });                     // the contract's way: live options apply at once
```

Every knob is declared once in [src/snes9x.options.ts](src/snes9x.options.ts);
the contract's spec (`SNES9X_SPEC`), the defaults and the menu are all derived from
that catalog, so a new row there is enough to expose a new setting.

### Capabilities

- **Save states**: `play.states` slots over the core's in-memory snapshot API
  (`S9xFreezeGameMem`), ~800 KB for a typical cart.
- **SRAM persistence**: battery-backed cartridge SRAM is persisted to OPFS
  (`snes9x/<storageNamespace>/sram.bin`) on pause/destroy and every 15 s;
  `purgeStorage()` removes the active namespace, along with the menu settings
  saved for it.
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


## Build

```sh
make build        # Full build: WASM (Docker/Emscripten) + TypeScript SDK
make build-sdk    # TypeScript only (SDK + the contract runtime + the app + demo page)
make test         # Type-check, then the tests against the built package
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
