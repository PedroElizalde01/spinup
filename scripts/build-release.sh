#!/usr/bin/env bash

set -euo pipefail

OUTPUT=""
TARGET=""

usage() {
  cat <<'EOF'
Build a standalone spinup binary for the current host platform.

Usage:
  scripts/build-release.sh [--output PATH] [--target TARGET]

Examples:
  scripts/build-release.sh
  scripts/build-release.sh --output dist/spinup
  scripts/build-release.sh --target bun-darwin-arm64 --output dist/spinup-darwin-arm64
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      OUTPUT="${2:-}"
      shift 2
      ;;
    --target)
      TARGET="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

detect_os() {
  case "$(uname -s)" in
    Linux) echo "linux" ;;
    Darwin) echo "darwin" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *)
      echo "Unsupported operating system: $(uname -s)" >&2
      exit 1
      ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "x64" ;;
    arm64|aarch64) echo "arm64" ;;
    *)
      echo "Unsupported architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac
}

OS="$(detect_os)"
ARCH="$(detect_arch)"
EXTENSION=""

if [[ -n "${TARGET}" ]]; then
  case "${TARGET}" in
    bun-linux-x64|bun-linux-x64-baseline|bun-linux-x64-modern|bun-linux-x64-musl)
      OS="linux"
      ARCH="x64"
      ;;
    bun-linux-arm64|bun-linux-arm64-musl)
      OS="linux"
      ARCH="arm64"
      ;;
    bun-darwin-x64|bun-darwin-x64-baseline)
      OS="darwin"
      ARCH="x64"
      ;;
    bun-darwin-arm64)
      OS="darwin"
      ARCH="arm64"
      ;;
    bun-windows-x64|bun-windows-x64-baseline|bun-windows-x64-modern)
      OS="windows"
      ARCH="x64"
      ;;
    bun-windows-arm64)
      OS="windows"
      ARCH="arm64"
      ;;
    *)
      echo "Unsupported Bun target: ${TARGET}" >&2
      exit 1
      ;;
  esac
fi

if [[ "${OS}" == "windows" ]]; then
  EXTENSION=".exe"
fi

if [[ -z "${OUTPUT}" ]]; then
  OUTPUT="dist/spinup-${OS}-${ARCH}${EXTENSION}"
fi

mkdir -p "$(dirname "${OUTPUT}")"

echo "Building ${OUTPUT}"

# Bun autoloads .env and bunfig.toml from the *invocation* directory into compiled
# executables by default. spinup launches projects from anywhere, so that would leak
# the caller's environment into an unrelated project's services. Always disable it.
BUILD_ARGS=(
  src/cli.ts
  --compile
  --no-compile-autoload-dotenv
  --no-compile-autoload-bunfig
  --outfile "${OUTPUT}"
)

if [[ -n "${TARGET}" ]]; then
  BUILD_ARGS+=(--target "${TARGET}")
fi

bun build "${BUILD_ARGS[@]}"
