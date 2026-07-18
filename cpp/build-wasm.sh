#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v emcc >/dev/null 2>&1 || {
  echo "Emscripten non trovato. Installa/attiva emsdk, poi rilancia npm run build:wasm." >&2
  exit 1
}
emcc cpp/motion_processor.cpp \
  -O3 \
  -msimd128 \
  -s STANDALONE_WASM=1 \
  -s EXPORTED_FUNCTIONS='["_alloc","_release","_reset_processor","_process_frame"]' \
  -Wl,--no-entry \
  -Wl,--export=alloc \
  -Wl,--export=release \
  -Wl,--export=reset_processor \
  -Wl,--export=process_frame \
  -o public/wasm/motion_processor.wasm
echo "Creato public/wasm/motion_processor.wasm"
