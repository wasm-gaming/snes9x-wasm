#!/usr/bin/env bash
set -euo pipefail

# Build Snes9x (Super Nintendo emulator) to WebAssembly with Emscripten.
#
# Like the Geolith port, upstream needs no patching: the source list below
# mirrors SOURCES_CXX from libretro/Makefile.common (minus libretro.cpp and
# the NTSC filter) and links scripts/shim/s9x_shim.cpp in place of a frontend
# port. Compiled straight with emcc — no upstream Makefile, no autotools.
#
# Outputs: dist/snes9x/snes9x.js (MODULARIZE factory `createSnes9xModule`)
#          dist/snes9x/snes9x.wasm

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${PROJECT_DIR}/.tmp/snes9x-build"
SRC_DIR="${BUILD_DIR}"
OUT_DIR="${PROJECT_DIR}/dist/snes9x"

SNES9X_REPO="${SNES9X_REPO:-https://github.com/snes9xgit/snes9x.git}"
# snes9x master, 2026-07-13
SNES9X_REF="${SNES9X_REF:-b5cc7651f9fc02189cb51b5a43848877db5aec42}"

OPT="${SNES9X_OPT:--O3}"

mkdir -p "${BUILD_DIR}" "${OUT_DIR}"

# --- Fetch pinned source ----------------------------------------------------
if [ ! -d "${SRC_DIR}/.git" ]; then
    echo "Cloning snes9x..."
    git clone "${SNES9X_REPO}" "${SRC_DIR}"
fi
git -C "${SRC_DIR}" fetch --quiet origin "${SNES9X_REF}" || true
git -C "${SRC_DIR}" checkout --quiet "${SNES9X_REF}"

cd "${SRC_DIR}"

# --- Source list (libretro/Makefile.common SOURCES_CXX, minus the port) -----
CORE_SRCS=(
    apu/apu.cpp
    apu/bapu/dsp/sdsp.cpp
    apu/bapu/smp/smp.cpp
    apu/bapu/smp/smp_state.cpp
    bml.cpp
    bsx.cpp
    c4.cpp
    c4emu.cpp
    cheats.cpp
    cheats2.cpp
    clip.cpp
    conffile.cpp
    controls.cpp
    cpu.cpp
    cpuexec.cpp
    cpuops.cpp
    crosshairs.cpp
    dma.cpp
    dsp.cpp
    dsp1.cpp
    dsp2.cpp
    dsp3.cpp
    dsp4.cpp
    fscompat.cpp
    fxemu.cpp
    fxinst.cpp
    gfx.cpp
    globals.cpp
    memmap.cpp
    movie.cpp
    msu1.cpp
    obc1.cpp
    ppu.cpp
    sa1.cpp
    sa1cpu.cpp
    screenshot.cpp
    sdd1.cpp
    sdd1emu.cpp
    seta.cpp
    seta010.cpp
    seta011.cpp
    seta018.cpp
    sha256.cpp
    snapshot.cpp
    snes9x.cpp
    spc7110.cpp
    srtc.cpp
    stream.cpp
    tile.cpp
    tileimpl-h2x1.cpp
    tileimpl-n1x1.cpp
    tileimpl-n2x1.cpp
)

CFLAGS=(
    "${OPT}"
    -std=c++17
    -I.
    -Iapu
    -Iapu/bapu
    # RGB565 keeps the 16-bit framebuffer one shift away from RGBA8888.
    -DPIXEL_FORMAT=RGB565
    # UNZIP_SUPPORT is an #ifdef, so it must stay undefined: ROMs arrive as
    # raw bytes from JS and never go through the bundled unzip.
    -DHAVE_STDINT_H
    -DNDEBUG
    -fno-exceptions
    -fno-rtti
    -Wno-deprecated-declarations
    -Wno-unused-value
)

LDFLAGS=(
    "${OPT}"
    --no-entry
    -sMODULARIZE=1
    -sEXPORT_NAME=createSnes9xModule
    -sENVIRONMENT=web,node  # node: enables the headless smoke test harness
    -sALLOW_MEMORY_GROWTH=1
    -sINITIAL_MEMORY=67108864    # 64MB: largest carts are 6MB + APU/PPU state
    -sMAXIMUM_MEMORY=536870912
    -sSTACK_SIZE=5242880         # snapshot.cpp recurses over large struct lists
    # MEMFS stays enabled deliberately. ROMs, SRAM and states all travel
    # through memory, but the core still probes for optional side files
    # (MSU-1 audio, cheats, movies); with FILESYSTEM=0 those fopen() calls
    # succeed against a stub and the core acts on files that do not exist.
    -sEXPORTED_FUNCTIONS=_malloc,_free
    -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP16,HEAPU32,UTF8ToString
)

echo "Compiling Snes9x core + shim with emcc..."
emcc \
    "${CFLAGS[@]}" \
    "${CORE_SRCS[@]}" \
    "${PROJECT_DIR}/scripts/shim/s9x_shim.cpp" \
    "${LDFLAGS[@]}" \
    -o "${OUT_DIR}/snes9x.js"

echo "Built artifacts:"
ls -lh "${OUT_DIR}/snes9x.js" "${OUT_DIR}/snes9x.wasm"
