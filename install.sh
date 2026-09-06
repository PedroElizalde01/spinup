#!/usr/bin/env bash

set -euo pipefail

OWNER="PedroElizalde01"
REPO="runit"   # GitHub repository name; the installed binary is "spinup"
INSTALL_DIR="${HOME}/.local/bin"
VERSION=""

usage() {
  cat <<'EOF'
Install spinup from GitHub Releases.

Usage:
  install.sh [--version vX.Y.Z] [--bin-dir PATH]

Options:
  --version   Install a specific release tag. Defaults to the latest release.
  --bin-dir   Install destination. Defaults to ~/.local/bin
  -h, --help  Show this help text.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      VERSION="${2:-}"
      shift 2
      ;;
    --bin-dir)
      INSTALL_DIR="${2:-}"
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

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to install spinup." >&2
  exit 1
fi

detect_os() {
  case "$(uname -s)" in
    Linux) echo "linux" ;;
    Darwin) echo "darwin" ;;
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

resolve_latest_version() {
  curl -fsSL "https://api.github.com/repos/${OWNER}/${REPO}/releases/latest" |
    sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' |
    head -n 1
}

if [[ -z "${VERSION}" ]]; then
  VERSION="$(resolve_latest_version)"
fi

if [[ -z "${VERSION}" ]]; then
  echo "Unable to resolve the latest spinup release." >&2
  exit 1
fi

OS="$(detect_os)"
ARCH="$(detect_arch)"
ASSET_NAME="spinup-${OS}-${ARCH}"
DOWNLOAD_URL="https://github.com/${OWNER}/${REPO}/releases/download/${VERSION}/${ASSET_NAME}"
TMP_DIR="$(mktemp -d)"
TMP_FILE="${TMP_DIR}/spinup"

cleanup() {
  rm -rf "${TMP_DIR}"
}

trap cleanup EXIT

mkdir -p "${INSTALL_DIR}"

echo "Installing spinup ${VERSION} for ${OS}/${ARCH}..."
curl -fL "${DOWNLOAD_URL}" -o "${TMP_FILE}"
chmod +x "${TMP_FILE}"
mv "${TMP_FILE}" "${INSTALL_DIR}/spinup"

echo "Installed to ${INSTALL_DIR}/spinup"

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo "Add this to your shell profile if needed:"
    echo "export PATH=\"${INSTALL_DIR}:\$PATH\""
    ;;
esac
