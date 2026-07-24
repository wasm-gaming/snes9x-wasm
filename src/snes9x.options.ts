import type { JSONSchema } from '@wasm-gaming/engine-specs';

/**
 * Video standard. `auto` trusts the region byte in the cartridge header,
 * which is right for virtually every commercial release; the forced modes
 * exist for hacks and homebrew with a wrong or missing header.
 */
export type Snes9xRegion = 'auto' | 'ntsc' | 'pal';

/** DSP sample interpolation (DSP_INTERPOLATION_* in apu/apu.h). */
export type Snes9xInterpolation = 'none' | 'linear' | 'gaussian' | 'cubic' | 'sinc';

export type Snes9xLogLevel = 'off' | 'error' | 'debug';

export interface Snes9xOptions {
  /** Video standard: auto (from the ROM header), or forced NTSC/PAL. */
  region?: Snes9xRegion;
  /**
   * DSP interpolation. `gaussian` is what the real SNES DSP does and the
   * upstream default; the others trade accuracy for sharpness.
   */
  interpolation?: Snes9xInterpolation;
  /** Canvas scaling filter: `pixelated` for crisp pixels, `smooth` for linear. */
  renderFilter?: 'pixelated' | 'smooth';
  /**
   * Crop the overscan area. The SNES outputs 224 (or 239) lines; many games
   * leave garbage in the extra rows, so cropping to 224 is the common choice.
   */
  cropOverscan?: boolean;
  /**
   * Aspect ratio to present. `4:3` matches a CRT; `1:1` shows square pixels
   * (8:7 for the 256-wide modes), which some players prefer for pixel art.
   */
  aspect?: '4:3' | '1:1';
  /**
   * Emulate the 5-player Multitap in controller port 2, giving pads 2-5.
   * Only a handful of games support it (Bomberman, Micro Machines...).
   */
  multitap?: boolean;
  /**
   * Sprites drawn per scanline. Real hardware drops sprites past 34 tiles;
   * raising it removes flicker at the cost of accuracy.
   */
  maxSpriteTilesPerLine?: number;
  /**
   * Super FX clock as a percentage of stock. Above 100 speeds up the games
   * that use it (Star Fox, Yoshi's Island); it is a hack, not accuracy.
   */
  superFXClockMultiplier?: number;
  /** Master audio volume, 0.0–1.0. */
  volume?: number;
  /** Poll connected gamepads (standard mapping) each frame. */
  gamepads?: boolean;
  /**
   * Core messages printed to the console. `error` shows the core's own
   * error/warning messages; `debug` adds its informational ones.
   */
  logLevel?: Snes9xLogLevel;
}

export const DEFAULT_SNES9X_OPTIONS: Required<Snes9xOptions> = {
  region: 'auto',
  interpolation: 'gaussian',
  renderFilter: 'pixelated',
  cropOverscan: true,
  aspect: '4:3',
  multitap: false,
  maxSpriteTilesPerLine: 34,
  superFXClockMultiplier: 100,
  volume: 1.0,
  gamepads: true,
  logLevel: 'error',
};

/** Numeric ids consumed by s9xwasm_setup() in scripts/shim/s9x_shim.cpp. */
export const SNES9X_REGION_IDS: Record<Snes9xRegion, number> = {
  auto: 0,
  ntsc: 1,
  pal: 2,
};

/** Numeric ids matching DSP_INTERPOLATION_* in apu/apu.h. */
export const SNES9X_INTERPOLATION_IDS: Record<Snes9xInterpolation, number> = {
  none: 0,
  linear: 1,
  gaussian: 2,
  cubic: 3,
  sinc: 4,
};

export const SNES9X_LOG_LEVEL_IDS: Record<Snes9xLogLevel, number> = {
  off: 0,
  error: 1,
  debug: 2,
};

export const SNES9X_OPTIONS_SCHEMA: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    region: {
      type: 'string',
      enum: ['auto', 'ntsc', 'pal'],
      default: 'auto',
      description:
        'Video standard: auto (from the cartridge header), or forced NTSC (60.098Hz) / PAL (50.007Hz).',
    },
    interpolation: {
      type: 'string',
      enum: ['none', 'linear', 'gaussian', 'cubic', 'sinc'],
      default: 'gaussian',
      description:
        'DSP sample interpolation. gaussian matches real SNES hardware; the others trade accuracy for sharpness.',
    },
    renderFilter: {
      type: 'string',
      enum: ['pixelated', 'smooth'],
      default: 'pixelated',
      description: 'Canvas scaling filter: pixelated for crisp pixels, smooth for linear filtering.',
    },
    cropOverscan: {
      type: 'boolean',
      default: true,
      description:
        'Crop the picture to 224 lines. Disable to see the full 239-line output, including the rows many games leave as garbage.',
    },
    aspect: {
      type: 'string',
      enum: ['4:3', '1:1'],
      default: '4:3',
      description: 'Presented aspect ratio: 4:3 (as on a CRT) or 1:1 square pixels.',
    },
    multitap: {
      type: 'boolean',
      default: false,
      description: 'Emulate the 5-player Multitap in controller port 2 (pads 2-5).',
    },
    maxSpriteTilesPerLine: {
      type: 'integer',
      enum: [34, 128],
      default: 34,
      description:
        'Sprite tiles drawn per scanline. 34 matches hardware (including its flicker); 128 removes sprite dropout.',
    },
    superFXClockMultiplier: {
      type: 'integer',
      default: 100,
      minimum: 50,
      maximum: 400,
      description:
        'Super FX clock as a percentage of stock. Above 100 speeds up Star Fox / Yoshi’s Island; it is a hack, not accuracy.',
    },
    volume: {
      type: 'number',
      default: 1.0,
      minimum: 0,
      maximum: 1,
      description: 'Master audio volume.',
    },
    gamepads: {
      type: 'boolean',
      default: true,
      description: 'Poll connected gamepads (standard mapping) each frame.',
    },
    logLevel: {
      type: 'string',
      enum: ['off', 'error', 'debug'],
      default: 'error',
      description:
        'Core messages printed to the console: error (core errors and warnings) or debug (also informational).',
    },
  },
};
