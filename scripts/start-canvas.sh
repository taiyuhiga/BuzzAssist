#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CALLER_DIR="$PWD"
PROJECT_DIR="${EXCALIDRAW_PROJECT_DIR:-${1:-$CALLER_DIR}}"
CANVAS_DIR="${EXCALIDRAW_CANVAS_DIR:-$PROJECT_DIR/canvas}"

export EXCALIDRAW_PROJECT_DIR="$PROJECT_DIR"
export EXCALIDRAW_CANVAS_DIR="$CANVAS_DIR"

cd "$ROOT_DIR"

if [ ! -d node_modules/@excalidraw/excalidraw ] || [ ! -d node_modules/vite ]; then
  npm install
fi

EXTRA_ARGS=("$@")
if [ $# -gt 0 ] && [ -z "${EXCALIDRAW_PROJECT_DIR:-}" ]; then
  EXTRA_ARGS=("${@:2}")
fi

exec node scripts/serve-canvas.mjs "$PROJECT_DIR" "${EXTRA_ARGS[@]}"
