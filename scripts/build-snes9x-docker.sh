#!/usr/bin/env bash
set -euo pipefail

# Local wrapper: run the Snes9x WASM build inside Docker (emscripten/emsdk).

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_SCRIPT="/workspace/scripts/build-snes9x.sh"

echo "Building Snes9x WASM via Docker..."
docker run --rm \
    -v "$PROJECT_DIR:/workspace" \
    -w /workspace \
    emscripten/emsdk:7.0.0 \
    bash -c "
      set -euo pipefail
      test -x $BUILD_SCRIPT || chmod +x $BUILD_SCRIPT
      $BUILD_SCRIPT
    "
