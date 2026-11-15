/**
 * The engine package's entry point: an `EngineSDK` for Snes9x, the Super Nintendo /
 * Super Famicom emulator.
 *
 * ```js
 * import Snes9xSDK from '@wasm-gaming/snes9x-wasm';
 *
 * const play = await new Snes9xSDK()
 *   .assets({ rom: () => readRom() })         // bytes, or a thunk
 *   .storage({ namespace: 'super-metroid' })  // → OPFS snes9x/super-metroid/
 *   .mount(document.querySelector('#stage'))
 *   .start();
 *
 * play.pause('menu'); play.resume('menu');
 * await play.states.save(0, { thumbnail: await play.snapshot() });
 * play.states.load(0);
 * await play.restart();                        // power cycle
 * await play.destroy();                        // battery RAM flushed, loop stopped, audio closed
 * ```
 *
 * Everything a host drives is the contract's (`@wasm-gaming/engine-specs`); what is this
 * engine's own: the options (the live settings catalog), owner-aware
 * {@link Snes9xPlay.pause} / {@link Snes9xPlay.resume}, {@link Snes9xPlay.states},
 * {@link Snes9xPlay.snapshot}, {@link Snes9xPlay.storagePath} and the `saves` event —
 * the same shape as blastem-wasm and fbneo-wasm, so the engine app is one app.
 *
 * Files in OPFS `snes9x/<namespace>/`: `sram.bin` (battery RAM, flushed every 15 s, on
 * pause and on destroy), and per save-state slot `slot_N.state`, `slot_N.png` (its frame)
 * and `slot_N.lock`. The slots are read into memory at start, so listing them is
 * synchronous; every change is written through.
 */
import {
  EnginePlayBase,
  EngineSDKBase,
  EventEmitter,
  type EngineInit,
  type EngineSDKConstructor,
  type EventsOf,
} from '@wasm-gaming/engine-specs';
import { createSnes9xCore, type Snes9xCore } from './snes9x.core.js';
import {
  SNES9X_SPEC,
  SNES9X_VIDEO,
  type Snes9xAsset,
  type Snes9xEngineConfig,
  type Snes9xOptions,
  type Snes9xOptionValue,
  type Snes9xPayloads,
} from './snes9x.options.js';

export type {
  Snes9xAsset,
  Snes9xAssets,
  Snes9xEngineConfig,
  Snes9xEvents,
  Snes9xOptions,
  Snes9xPayloads,
  Snes9xStorage,
} from './snes9x.options.js';
export type { Snes9xConfig } from './snes9x.config.js';
export { SNES9X_SPEC, SNES9X_VIDEO } from './snes9x.options.js';

const ENGINE_ID = 'snes9x';
const DEFAULT_STORAGE_NAMESPACE = 'default';

/**
 * Where an engine keeps one namespace: `<engineId>/<namespace>`, relative to the OPFS
 * root. The same rule as every engine's: segments cleaned, `.` and `..` dropped,
 * anything outside `[A-Za-z0-9._-]` → `_`, nothing usable → `default`; a leading
 * `<engineId>/` is stripped once.
 */
export function storagePath(
  engineId: string,
  namespace: unknown,
): { namespace: string; path: string; prefixed: boolean } {
  const segments =
    typeof namespace === 'string'
      ? namespace
          .split('/')
          .map((segment) => segment.trim())
          .filter((segment) => segment && segment !== '.' && segment !== '..')
          .map((segment) => segment.replace(/[^A-Za-z0-9._-]/g, '_'))
      : [];
  const prefixed = segments.length > 1 && segments[0] === engineId;
  if (prefixed) segments.shift();
  const cleaned = segments.join('/') || DEFAULT_STORAGE_NAMESPACE;
  return { namespace: cleaned, path: `${engineId}/${cleaned}`, prefixed };
}

async function opfsDir(path: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
  try {
    let dir = await navigator.storage.getDirectory();
    for (const segment of path.split('/').filter(Boolean)) {
      dir = await dir.getDirectoryHandle(segment, { create });
    }
    return dir;
  } catch {
    return null;
  }
}

async function resolveAsset(asset: Snes9xAsset | undefined): Promise<Uint8Array | null> {
  const value = typeof asset === 'function' ? await asset() : asset;
  if (value == null) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError('snes9x: an asset must be a Uint8Array, an ArrayBuffer or a thunk returning one');
}

/** The player's save-state slots: 0-3. */
export const STATE_SLOTS = 4;
/**
 * The *unsaved* suspend point (Classic Mini style): written when the player leaves,
 * offered when they come back, and saved into a numbered slot only when they ask.
 */
export const AUTO_STATE_SLOT = 9;

/** One save-state slot. */
export interface Snes9xStateSlot {
  slot: number;
  /** When the state was written, or null for an empty slot. */
  savedAt: Date | null;
  /** The frame saved with it (PNG), when the host handed one over. */
  thumbnail: Blob | null;
  /** Protected: cannot be overwritten or removed until unlocked. */
  locked: boolean;
}

/** Save states: Snes9x's snapshots in numbered slots, kept in OPFS. */
export interface Snes9xStates {
  /** The player's slots, 0-3. */
  list(): Snes9xStateSlot[];
  /** Any slot, {@link AUTO_STATE_SLOT} included. */
  get(slot: number): Snes9xStateSlot;
  /** Save the running game (paused or not) into `slot`. Refuses a locked slot. */
  save(slot: number, options?: { thumbnail?: Blob | null }): Promise<void>;
  /** Load `slot` into the running game; false when it is empty or Snes9x refused it. */
  load(slot: number): boolean;
  /** Copy a state (and its frame) into another slot — the unsaved point into a numbered one. */
  copy(from: number, to: number): Promise<void>;
  lock(slot: number, locked: boolean): Promise<void>;
  remove(slot: number): Promise<void>;
}

interface StoredFile {
  bytes: Uint8Array;
  at: number;
}

/** The live engine: one booted Snes9x and its session. */
export class Snes9xPlay extends EnginePlayBase<Snes9xPayloads> {
  #core: Snes9xCore | null = null;
  #destroyed = false;
  #pauseOwner: string | null = null;

  #canvas: HTMLCanvasElement | null = null;
  #ownsCanvas = false;
  #box: HTMLElement | null = null;
  #boxObserver: ResizeObserver | null = null;

  #namespace = DEFAULT_STORAGE_NAMESPACE;
  #storagePath = `${ENGINE_ID}/${DEFAULT_STORAGE_NAMESPACE}`;
  #persist = true;
  /** The slot files of this namespace, read at start and written through. */
  #files = new Map<string, StoredFile>();
  #onHidden = (): void => {
    if (document.visibilityState === 'hidden') void this.flushSaves();
  };

  constructor(init?: EngineInit<Snes9xPayloads>, events?: EventEmitter<EventsOf<Snes9xPayloads>>) {
    super(SNES9X_SPEC, init, events);
  }

  /** The normalised namespace this session uses. */
  get namespace(): string {
    return this.#namespace;
  }

  /** Where this session's files live, relative to the OPFS root: `snes9x/<namespace>`. */
  get storagePath(): string {
    return this.#storagePath;
  }

  /** Who holds the pause, or null while running. */
  get pausedBy(): string | null {
    return this.#pauseOwner;
  }

  /** The live settings (the options catalog); writes apply to the running game. */
  get settings(): Snes9xCore['config'] {
    return this.#requireCore().config;
  }

  /** The current frame as a PNG (the 2D canvas keeps the last one, paused or not). */
  async snapshot(): Promise<Blob | null> {
    return this.#core ? this.#core.snapshot() : null;
  }

  /** Save states — see {@link Snes9xStates}. */
  get states(): Snes9xStates {
    const core = this.#requireCore();
    const name = {
      state: (slot: number) => `slot_${slot}.state`,
      png: (slot: number) => `slot_${slot}.png`,
      lock: (slot: number) => `slot_${slot}.lock`,
    };
    const checkSlot = (slot: number): number => {
      if (slot === AUTO_STATE_SLOT || (Number.isInteger(slot) && slot >= 0 && slot < STATE_SLOTS)) return slot;
      throw new RangeError(`snes9x: a state slot is 0-${STATE_SLOTS - 1} or ${AUTO_STATE_SLOT}, not ${slot}`);
    };
    const isLocked = (slot: number): boolean => this.#files.has(name.lock(slot));
    const refuseLocked = (slot: number): void => {
      if (isLocked(slot)) throw new Error(`snes9x: state slot ${slot} is locked`);
    };
    const get = (slot: number): Snes9xStateSlot => {
      checkSlot(slot);
      const state = this.#files.get(name.state(slot));
      const png = state ? this.#files.get(name.png(slot)) : undefined;
      return {
        slot,
        savedAt: state ? new Date(state.at) : null,
        thumbnail: png ? new Blob([png.bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' }) : null,
        locked: isLocked(slot),
      };
    };
    return {
      list: () => Array.from({ length: STATE_SLOTS }, (_, slot) => get(slot)),
      get,
      save: async (slot, options = {}) => {
        checkSlot(slot);
        refuseLocked(slot);
        const bytes = core.saveState();
        const thumbnail = options.thumbnail ? new Uint8Array(await options.thumbnail.arrayBuffer()) : null;
        await this.#write(name.state(slot), bytes);
        if (thumbnail) await this.#write(name.png(slot), thumbnail);
        else await this.#forget([name.png(slot)]);
        this.emit('saves', { files: [name.state(slot), name.png(slot)] });
      },
      load: (slot) => {
        checkSlot(slot);
        const state = this.#files.get(name.state(slot));
        return state ? core.loadState(state.bytes) : false;
      },
      copy: async (from, to) => {
        checkSlot(from);
        checkSlot(to);
        refuseLocked(to);
        const state = this.#files.get(name.state(from));
        if (!state) throw new Error(`snes9x: state slot ${from} is empty`);
        const png = this.#files.get(name.png(from));
        await this.#write(name.state(to), state.bytes);
        if (png) await this.#write(name.png(to), png.bytes);
        else await this.#forget([name.png(to)]);
        this.emit('saves', { files: [name.state(to), name.png(to)] });
      },
      lock: async (slot, locked) => {
        checkSlot(slot);
        if (locked) {
          if (!this.#files.has(name.state(slot))) throw new Error(`snes9x: state slot ${slot} is empty`);
          await this.#write(name.lock(slot), new Uint8Array([1]));
        } else await this.#forget([name.lock(slot)]);
        this.emit('saves', { files: [name.lock(slot)] });
      },
      remove: async (slot) => {
        checkSlot(slot);
        refuseLocked(slot);
        const names = [name.state(slot), name.png(slot)];
        await this.#forget(names);
        this.emit('saves', { files: names });
      },
    };
  }

  /**
   * Freeze emulation and sound. The first caller owns the pause, and only that owner's
   * {@link resume} lifts it, so an overlay cannot resume a game the host had already
   * frozen. Battery RAM is flushed, since a paused game is often a closed one.
   */
  pause(owner = 'host'): void {
    const core = this.#core;
    if (!core || this.#pauseOwner) return;
    this.#pauseOwner = owner;
    core.pause();
    void this.flushSaves();
    this.emit('pause', { owner });
  }

  resume(owner = 'host'): void {
    const core = this.#core;
    if (!core || this.#pauseOwner !== owner) return;
    this.#pauseOwner = null;
    core.resume();
    this.emit('resume', { owner });
  }

  /** Battery RAM to OPFS `snes9x/<namespace>/sram.bin`, when it changed. Emits `saves`. */
  async flushSaves(): Promise<void> {
    if (!this.#core || !this.#persist) return;
    if (await this.#core.persistSram()) this.emit('saves', { files: ['sram.bin'] });
  }

  // ---- Contract hooks ----

  protected override mounted(target: HTMLElement): void {
    if (target instanceof HTMLCanvasElement) {
      this.#canvas = target;
      this.#ownsCanvas = false;
      this.#box = target.parentElement;
    } else {
      this.#canvas = document.createElement('canvas');
      this.#ownsCanvas = true;
      this.#box = target;
      target.appendChild(this.#canvas);
    }
    const canvas = this.#canvas;
    canvas.width = SNES9X_VIDEO.width;
    canvas.height = SNES9X_VIDEO.height;
    canvas.tabIndex = 0;
    canvas.style.display = 'block';
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());

    if (this.#box && this.#ownsCanvas) {
      this.#boxObserver?.disconnect();
      this.#boxObserver = new ResizeObserver(() => this.#fit());
      this.#boxObserver.observe(this.#box);
      this.#fit();
    }
  }

  protected override async open(_options: Snes9xOptions): Promise<void> {
    if (this.#destroyed) {
      throw new Error('snes9x: this engine has been destroyed and cannot be started again — build a new Snes9xSDK');
    }
    if (this.#core) {
      // Already running: a restart is a power cycle.
      if (this.#pauseOwner) this.resume(this.#pauseOwner);
      this.#core.reset();
      return;
    }
    await this.#boot();
  }

  protected override patched(kind: string, patch: object): void {
    if (kind !== 'options' || !this.#core) return;
    for (const [key, value] of Object.entries(patch)) {
      this.#core.config.write(key, value as Snes9xOptionValue);
    }
  }

  protected override async close(): Promise<void> {
    document.removeEventListener('visibilitychange', this.#onHidden);
    window.removeEventListener('pagehide', this.#onHidden);
    const core = this.#core;
    if (core) await core.destroy();
    this.#boxObserver?.disconnect();
    this.#boxObserver = null;
    if (this.#ownsCanvas) this.#canvas?.remove();
    this.#canvas = null;
    this.#core = null;
    this.#pauseOwner = null;
    this.#destroyed = true;
  }

  // ---- Boot ----

  async #boot(): Promise<void> {
    const config = await this.#values<Snes9xEngineConfig>('config');
    const options = await this.#values<Record<string, unknown>>('options');
    const assets = await this.#values<{ rom?: Snes9xAsset }>('assets');
    const storage = await this.#values<{ namespace?: string; persist?: 'opfs' | null }>('storage');

    const canvas = this.#canvas;
    if (!canvas) throw new Error('snes9x: mount() an element (or a canvas) before start()');

    const rom = await resolveAsset(assets.rom);
    if (!rom) throw new Error('snes9x: no ROM — hand one over as assets.rom (bytes or a thunk)');

    const resolved = storagePath(ENGINE_ID, storage.namespace);
    this.#namespace = resolved.namespace;
    this.#storagePath = resolved.path;
    this.#persist = storage.persist !== null;
    if (this.#persist) await this.#readFiles();

    this.#core = await createSnes9xCore({
      canvas,
      rom,
      storagePath: this.#storagePath,
      settingsKey: this.#namespace,
      persist: this.#persist,
      options,
      jsUrl: config.jsUrl,
      wasmUrl: config.wasmUrl,
      menuMount: this.#box ?? document.body,
      onResize: () => this.#fit(),
    });
    this.#core.start();

    if (this.#persist) {
      document.addEventListener('visibilitychange', this.#onHidden);
      window.addEventListener('pagehide', this.#onHidden);
    }
    this.#fit();
  }

  /** The plain values behind one payload's descriptors. */
  async #values<T>(kind: 'config' | 'options' | 'assets' | 'storage'): Promise<T> {
    const described = (await this[kind]()) as Record<string, { value: unknown }>;
    const out: Record<string, unknown> = {};
    for (const [key, property] of Object.entries(described)) {
      if (property.value !== undefined) out[key] = property.value;
    }
    return out as T;
  }

  #requireCore(): Snes9xCore {
    if (!this.#core) throw new Error('snes9x: the engine is not running — start() it first');
    return this.#core;
  }

  // ---- Files ----

  /** The slot files of this namespace into memory (battery RAM is the core's). */
  async #readFiles(): Promise<void> {
    const dir = await opfsDir(this.#storagePath, false);
    if (!dir) return;
    const iterable = dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> };
    for await (const [fileName, handle] of iterable.entries()) {
      if (handle.kind !== 'file' || !fileName.startsWith('slot_')) continue;
      const file = await (handle as FileSystemFileHandle).getFile();
      this.#files.set(fileName, { bytes: new Uint8Array(await file.arrayBuffer()), at: file.lastModified });
    }
  }

  async #write(fileName: string, bytes: Uint8Array): Promise<void> {
    this.#files.set(fileName, { bytes, at: Date.now() });
    if (!this.#persist) return;
    const dir = await opfsDir(this.#storagePath, true);
    if (!dir) return;
    const writable = await (await dir.getFileHandle(fileName, { create: true })).createWritable();
    await writable.write(bytes as Uint8Array<ArrayBuffer>);
    await writable.close();
  }

  async #forget(fileNames: string[]): Promise<void> {
    for (const fileName of fileNames) this.#files.delete(fileName);
    if (!this.#persist) return;
    const dir = await opfsDir(this.#storagePath, false);
    for (const fileName of fileNames) await dir?.removeEntry(fileName).catch(() => {});
  }

  // ---- Picture ----

  #fit(): void {
    const canvas = this.#canvas;
    const box = this.#box;
    if (!canvas || !box || !this.#ownsCanvas) return;
    const { width, height } = box.getBoundingClientRect();
    if (!width || !height) return;
    const aspect = this.#core?.aspect() ?? 4 / 3;
    const w = Math.min(width, height * aspect);
    canvas.style.width = `${Math.floor(w)}px`;
    canvas.style.height = `${Math.floor(w / aspect)}px`;
  }
}

/**
 * The factory a host constructs: static identity, the configuration chain, and a
 * `start()` that boots Snes9x and opens a session.
 */
export class Snes9xSDK extends EngineSDKBase<Snes9xPayloads> {
  static readonly id = ENGINE_ID;
  /** Kept in step with package.json. */
  static readonly version = '0.1.1';
  static readonly name = 'Snes9x';
  static readonly description =
    'Snes9x, the Super Nintendo / Super Famicom emulator, compiled to WebAssembly — enhancement chips included. Ships no games: the player provides the ROM, and it never leaves their browser.';

  protected override createPlay(
    init: EngineInit<Snes9xPayloads>,
    events: EventEmitter<EventsOf<Snes9xPayloads>>,
  ): Snes9xPlay {
    return new Snes9xPlay(init, events);
  }
}

/** CI's conformance line: if this class stops satisfying the contract, `make test` fails. */
export const SNES9X_ENGINE: EngineSDKConstructor<Snes9xPayloads> = Snes9xSDK;

export default Snes9xSDK;
