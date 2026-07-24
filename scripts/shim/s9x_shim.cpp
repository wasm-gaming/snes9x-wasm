// Flat C ABI over the Snes9x core, replacing an upstream frontend port.
//
// Snes9x expects its frontend to supply a set of S9x* callbacks (declared in
// display.h / controls.h / fscompat.h) and to drive one frame per
// S9xMainLoop() call. Upstream ships several such frontends (unix/, gtk/,
// libretro/); none of them suit a browser, so this file plays that role:
// the callbacks below are the minimum the core links against, and the
// s9xwasm_* exports are what the JS SDK drives.
//
// No SDL, no ASYNCIFY, no main loop of our own — the SDK calls
// s9xwasm_exec() once per emulated frame, reads the RGBA framebuffer, and
// drains the audio the APU produced during that frame.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "snes9x.h"
#include "memmap.h"
#include "apu/apu.h"
#include "gfx.h"
#include "ppu.h"
#include "controls.h"
#include "snapshot.h"
#include "display.h"
#include "fscompat.h"
#include "conffile.h"

#include <emscripten.h>

#define WASM_EXPORT extern "C" EMSCRIPTEN_KEEPALIVE

// ---------------------------------------------------------------- state

namespace {

// Latest completed frame, converted to RGBA8888 for direct ImageData use.
std::vector<uint8_t> g_rgba;
int g_frame_w = SNES_WIDTH;
int g_frame_h = SNES_HEIGHT;

// Audio drained after each frame. The APU resamples to
// Settings.SoundPlaybackRate, so this is already at the AudioContext rate.
std::vector<int16_t> g_audio;
int g_audio_len = 0; // interleaved int16 count (frames * 2)

// Savestate staging buffer; sized per save via nulStream.
std::vector<uint8_t> g_state;

// Active-high button masks per pad, pushed from JS. Bit order matches
// BTN_* below (and libretro's RETRO_DEVICE_ID_JOYPAD_* ordering).
uint32_t g_pad_mask[5] = {0, 0, 0, 0, 0};

bool g_rom_loaded = false;
int g_log_level = 1; // 0 silent, 1 errors/warnings, 2 everything

// Button ids inside a pad, matching the libretro port's mapping order so the
// "Joypad<N> <Button>" command names line up.
enum {
    BTN_B = 0, BTN_Y, BTN_SELECT, BTN_START,
    BTN_UP, BTN_DOWN, BTN_LEFT, BTN_RIGHT,
    BTN_A, BTN_X, BTN_L, BTN_R,
    BTN_COUNT
};

#define MAKE_BUTTON(pad, btn) (((pad) << 4) | (btn))

const char *const BUTTON_NAMES[BTN_COUNT] = {
    "B", "Y", "Select", "Start",
    "Up", "Down", "Left", "Right",
    "A", "X", "L", "R",
};

void map_buttons()
{
    for (int pad = 1; pad <= 5; pad++) {
        for (int btn = 0; btn < BTN_COUNT; btn++) {
            char name[32];
            snprintf(name, sizeof(name), "Joypad%d %s", pad, BUTTON_NAMES[btn]);
            S9xMapButton(MAKE_BUTTON(pad, btn), S9xGetCommandT(name), false);
        }
    }
}

void report_buttons()
{
    for (int pad = 0; pad < 5; pad++) {
        const uint32_t mask = g_pad_mask[pad];
        for (int btn = 0; btn < BTN_COUNT; btn++) {
            S9xReportButton(MAKE_BUTTON(pad + 1, btn), (mask >> btn) & 1);
        }
    }
}

// RGB565 (PIXEL_FORMAT=RGB565) → RGBA8888, replicating high bits into the
// low ones so full-intensity channels reach 0xff.
void convert_frame(int width, int height)
{
    g_frame_w = width;
    g_frame_h = height;

    const size_t needed = static_cast<size_t>(width) * height * 4;
    if (g_rgba.size() < needed)
        g_rgba.resize(needed);

    uint8_t *dst = g_rgba.data();
    for (int y = 0; y < height; y++) {
        const uint16_t *src =
            reinterpret_cast<const uint16_t *>(
                reinterpret_cast<const uint8_t *>(GFX.Screen) + y * GFX.Pitch);
        for (int x = 0; x < width; x++) {
            const uint16_t p = src[x];
            const uint8_t r = (p >> 11) & 0x1f;
            const uint8_t g = (p >> 5) & 0x3f;
            const uint8_t b = p & 0x1f;
            *dst++ = (r << 3) | (r >> 2);
            *dst++ = (g << 2) | (g >> 4);
            *dst++ = (b << 3) | (b >> 2);
            *dst++ = 0xff;
        }
    }
}

} // namespace

// ------------------------------------------------- core frontend callbacks
//
// Everything the core links against but a browser frontend has no use for.
// Kept together so it is obvious which are deliberate no-ops.

bool8 S9xInitUpdate() { return TRUE; }

bool8 S9xDeinitUpdate(int width, int height)
{
    convert_frame(width, height);
    return TRUE;
}

bool8 S9xContinueUpdate(int width, int height)
{
    convert_frame(width, height);
    return TRUE;
}

// The host paces frames (audio-clocked in the SDK), so the core must never
// sleep or throttle here.
void S9xSyncSpeed() {}

// Audio is pulled with S9xMixSamples() after each frame rather than pushed to
// a device, so there is no device to open.
bool8 S9xOpenSoundDevice() { return TRUE; }

void S9xMessage(int type, int, const char *message)
{
    if (g_log_level <= 0 || !message)
        return;
    // S9X_ERROR/S9X_WARNING carry the failures worth surfacing; the rest is
    // in-game info text.
    if (g_log_level < 2 && type != S9X_ERROR && type != S9X_WARNING)
        return;
    printf("snes9x: %s\n", message);
}

void S9xExit() {}

void S9xPutImage(int, int) {}
void S9xInitDisplay(int, char **) {}
void S9xDeinitDisplay() {}
void S9xTextMode() {}
void S9xGraphicsMode() {}
void S9xSetTitle(const char *) {}
void S9xToggleSoundChannel(int) {}
void S9xSetPalette() {}

void S9xExtraUsage() {}
void S9xParseArg(char **, int &, int) {}

void S9xParsePortConfig(ConfigFile &, int) {}
void S9xInitInputDevices() {}
void S9xHandlePortCommand(s9xcommand_t, int16, int16) {}

// Input is pushed from JS via s9xwasm_input(), never polled by the core.
bool S9xPollButton(uint32, bool *) { return false; }
bool S9xPollAxis(uint32, int16 *) { return false; }
bool S9xPollPointer(uint32, int16 *, int16 *) { return false; }

const char *S9xStringInput(const char *) { return NULL; }
void S9xProcessEvents(bool8) {}

// Snapshots go through memory (S9xFreezeGameMem), so the file-backed path is
// never taken.
bool8 S9xOpenSnapshotFile(const char *, bool8, STREAM *) { return FALSE; }
void S9xCloseSnapshotFile(STREAM) {}

// SRAM is handed to JS for OPFS persistence instead of being written to disk.
void S9xAutoSaveSRAM() {}

// No writable filesystem: every path the core might build resolves to ".".
// (S9xGetFilename/S9xBasename are already provided by fscompat.cpp, which
// builds on top of these.)
std::string S9xGetDirectory(enum s9x_getdirtype) { return "."; }
std::string S9xGetFilenameInc(std::string ext, enum s9x_getdirtype) { return "rom" + ext; }

// ------------------------------------------------------------- exports

/** 0 silent, 1 errors/warnings (default), 2 everything. */
WASM_EXPORT void s9xwasm_set_loglevel(int level) { g_log_level = level; }

/**
 * Initialize the core. `region`: 0 auto, 1 force NTSC, 2 force PAL.
 * `samplerate` should be the host AudioContext rate — the APU resamples to
 * it, so no second resampling stage is needed in JS.
 * Returns 1 on success.
 */
WASM_EXPORT int s9xwasm_setup(int samplerate, int region, int interpolation)
{
    memset(&Settings, 0, sizeof(Settings));

    Settings.MouseMaster = FALSE;
    Settings.SuperScopeMaster = FALSE;
    Settings.JustifierMaster = FALSE;
    Settings.MultiPlayer5Master = TRUE;
    Settings.MacsRifleMaster = FALSE;

    Settings.FrameTimePAL = 20000;
    Settings.FrameTimeNTSC = 16667;

    Settings.SixteenBitSound = TRUE;
    Settings.Stereo = TRUE;
    Settings.SoundPlaybackRate = samplerate;
    Settings.SoundInputRate = 31950; // upstream default; tuned by dynamic rate
    Settings.SoundSync = FALSE;
    Settings.InterpolationMethod = interpolation;

    Settings.Transparency = TRUE;
    Settings.AutoDisplayMessages = FALSE; // no OSD over the emulated picture
    Settings.InitialInfoStringTimeout = 0;
    Settings.HDMATimingHack = 100;
    Settings.BlockInvalidVRAMAccessMaster = TRUE;
    Settings.SeparateEchoBuffer = FALSE;
    Settings.DontSaveOopsSnapshot = TRUE;
    Settings.AutoSaveDelay = 0;

    Settings.ForceNTSC = (region == 1);
    Settings.ForcePAL = (region == 2);

    Settings.OneClockCycle = 6;
    Settings.OneSlowClockCycle = 8;
    Settings.TwoClockCycles = 12;
    Settings.MaxSpriteTilesPerLine = 34;
    Settings.SuperFXClockMultiplier = 100;

    Settings.CartAName[0] = 0;
    Settings.CartBName[0] = 0;

    CPU.Flags = 0;

    if (!Memory.Init() || !S9xInitAPU()) {
        Memory.Deinit();
        S9xDeinitAPU();
        return 0;
    }

    // 32 ms of APU buffering: the SDK drains every frame, so this only has to
    // absorb jitter between rAF ticks.
    S9xInitSound(32);
    S9xSetSoundMute(FALSE);
    S9xSetSamplesAvailableCallback(NULL, NULL);

    if (!S9xGraphicsInit()) {
        Memory.Deinit();
        S9xDeinitAPU();
        return 0;
    }

    S9xUnmapAllControls();
    for (int i = 0; i < 2; i++)
        S9xSetController(i, CTL_JOYPAD, i, 0, 0, 0);
    map_buttons();

    g_audio.resize(static_cast<size_t>(samplerate) * 2 / 10); // 100 ms headroom
    return 1;
}

/** Enable the 5-player multitap on port 2 (pads 2-5). */
WASM_EXPORT void s9xwasm_set_multitap(int enabled)
{
    if (enabled)
        S9xSetController(1, CTL_MP5, 1, 2, 3, 4);
    else
        S9xSetController(1, CTL_JOYPAD, 1, 0, 0, 0);
}

/**
 * Load a cartridge image from memory (.sfc/.smc, headered or not — the core
 * detects and strips a 512-byte copier header). Returns 1 on success.
 */
WASM_EXPORT int s9xwasm_load_rom(const uint8_t *data, int size)
{
    if (!data || size <= 0)
        return 0;
    if (!Memory.LoadROMMem(data, size, "rom"))
        return 0;
    g_rom_loaded = true;
    return 1;
}

WASM_EXPORT void s9xwasm_reset()
{
    if (g_rom_loaded)
        S9xReset();
}

WASM_EXPORT void s9xwasm_soft_reset()
{
    if (g_rom_loaded)
        S9xSoftReset();
}

/** Skip rendering for this frame (fast-forward / catch-up frames). */
WASM_EXPORT void s9xwasm_skip_render(int skip)
{
    IPPU.RenderThisFrame = skip ? FALSE : TRUE;
}

/**
 * Run exactly one frame. Returns the number of interleaved int16 samples the
 * APU produced (frames * 2), readable at s9xwasm_audio_ptr().
 */
WASM_EXPORT int s9xwasm_exec()
{
    if (!g_rom_loaded)
        return 0;

    report_buttons();
    S9xMainLoop();

    int avail = S9xGetSampleCount();
    if (avail > static_cast<int>(g_audio.size()))
        avail = static_cast<int>(g_audio.size());
    if (avail > 0)
        S9xMixSamples(reinterpret_cast<uint8_t *>(g_audio.data()), avail);
    g_audio_len = avail;
    return avail;
}

WASM_EXPORT const int16_t *s9xwasm_audio_ptr() { return g_audio.data(); }
WASM_EXPORT int s9xwasm_audio_len() { return g_audio_len; }

WASM_EXPORT const uint8_t *s9xwasm_frame_rgba() { return g_rgba.data(); }
WASM_EXPORT int s9xwasm_frame_width() { return g_frame_w; }
WASM_EXPORT int s9xwasm_frame_height() { return g_frame_h; }

/** TRUE once the ROM header has been parsed, so the SDK can size the canvas. */
WASM_EXPORT int s9xwasm_is_pal() { return Settings.PAL ? 1 : 0; }

/** Frames per second of the emulated region, scaled by 1e6. */
WASM_EXPORT int s9xwasm_framerate_micro()
{
    return Settings.PAL ? 50006979 : 60098477;
}

/** Set the active-high button mask for `pad` (0-4). */
WASM_EXPORT void s9xwasm_input(int pad, uint32_t mask)
{
    if (pad >= 0 && pad < 5)
        g_pad_mask[pad] = mask;
}

WASM_EXPORT void s9xwasm_set_mute(int muted) { S9xSetSoundMute(muted ? TRUE : FALSE); }

// ------------------------------------------------------------ savestates

/**
 * Size of the next savestate, in bytes. Snes9x has no size query, so the
 * freeze is run once against a counting stream.
 */
WASM_EXPORT uint32_t s9xwasm_state_size()
{
    if (!g_rom_loaded)
        return 0;
    nulStream stream;
    S9xFreezeToStream(&stream);
    return static_cast<uint32_t>(stream.size());
}

/**
 * Serialize into the shim's staging buffer. Returns the pointer (NULL on
 * failure); the length is the s9xwasm_state_size() measured just before.
 */
WASM_EXPORT const uint8_t *s9xwasm_state_save()
{
    if (!g_rom_loaded)
        return NULL;
    const uint32_t size = s9xwasm_state_size();
    if (!size)
        return NULL;
    if (g_state.size() < size)
        g_state.resize(size);
    if (!S9xFreezeGameMem(g_state.data(), size))
        return NULL;
    return g_state.data();
}

WASM_EXPORT int s9xwasm_state_load(const uint8_t *data, uint32_t size)
{
    if (!g_rom_loaded || !data || !size)
        return 0;
    // S9xUnfreezeGameMem returns SUCCESS (== 1) on a clean restore.
    return S9xUnfreezeGameMem(data, size) == SUCCESS ? 1 : 0;
}

// ------------------------------------------------------------------ SRAM

WASM_EXPORT uint8_t *s9xwasm_sram_ptr() { return Memory.SRAM; }

/** Battery-backed SRAM size for the loaded cart (0 when it has none). */
WASM_EXPORT int s9xwasm_sram_size()
{
    if (!g_rom_loaded || Memory.SRAMSize == 0 || Memory.SRAMSize > 0x10)
        return 0;
    const int size = (1 << (Memory.SRAMSize + 3)) * 128;
    return size > static_cast<int>(Memory.SRAM_SIZE)
               ? static_cast<int>(Memory.SRAM_SIZE)
               : size;
}

// ------------------------------------------------------------- ROM info

WASM_EXPORT const char *s9xwasm_rom_name()
{
    return g_rom_loaded ? Memory.ROMName : "";
}

WASM_EXPORT int s9xwasm_rom_size() { return g_rom_loaded ? Memory.CalculatedSize : 0; }
