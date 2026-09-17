#!/usr/bin/env bash

set -euo pipefail

OWNER="PedroElizalde01"
REPO="spinup"
INSTALL_DIR="${HOME}/.local/bin"
MAN_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}/man/man1"
VERSION=""

# Overridable for mirrors and for the installer's own tests.
API_URL="${SPINUP_INSTALL_API_URL:-https://api.github.com/repos/${OWNER}/${REPO}}"
DOWNLOAD_URL="${SPINUP_INSTALL_DOWNLOAD_URL:-https://github.com/${OWNER}/${REPO}/releases/download}"

# Releases published before SHA256SUMS existed. Anything newer must have checksums.
UNCHECKSUMMED_RELEASES=" v0.3.0 v0.4.0 "

usage() {
  cat <<'USAGE'
Install spinup from GitHub Releases.

Usage:
  install.sh [--version vX.Y.Z] [--bin-dir PATH]

Options:
  --version   Install a specific release tag. Defaults to the latest release.
  --bin-dir   Install destination. Defaults to ~/.local/bin
  -h, --help  Show this help text.

The download is verified against the release's SHA256SUMS before anything is
replaced. On any failure an existing spinup is left untouched.
USAGE
}

fail() {
  echo "error: $*" >&2
  exit 1
}

require_value() {
  if [[ $# -lt 2 || -z "$2" || "$2" == --* ]]; then
    fail "$1 needs a value. Run with --help for usage."
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      require_value "$@"
      VERSION="$2"
      shift 2
      ;;
    --bin-dir)
      require_value "$@"
      INSTALL_DIR="$2"
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

if [[ -n "${VERSION}" && ! "${VERSION}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-.+][0-9A-Za-z.-]+)?$ ]]; then
  fail "--version must look like v1.2.3, got '${VERSION}'."
fi

command -v curl >/dev/null 2>&1 || fail "curl is required to install spinup."

detect_os() {
  case "$(uname -s)" in
    Linux) echo "linux" ;;
    Darwin) echo "darwin" ;;
    *) fail "unsupported operating system: $(uname -s). On Windows, use WSL." ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "x64" ;;
    arm64|aarch64) echo "arm64" ;;
    *) fail "unsupported architecture: $(uname -m)." ;;
  esac
}

# Alpine and other musl systems cannot run the glibc build; they get their own asset.
detect_libc_suffix() {
  if [[ "$1" != "linux" ]]; then
    return
  fi

  if ls /lib/ld-musl-* >/dev/null 2>&1 || (ldd --version 2>&1 | grep -qi musl); then
    echo "-musl"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    fail "neither sha256sum nor shasum is available, so the download cannot be verified."
  fi
}

resolve_latest_version() {
  curl -fsSL "${API_URL}/releases/latest" |
    sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' |
    head -n 1
}

if [[ -z "${VERSION}" ]]; then
  VERSION="$(resolve_latest_version)" || true
fi

[[ -n "${VERSION}" ]] || fail "unable to resolve the latest spinup release."

# Releases before v0.3.0 shipped a binary named runit, under asset names this
# script does not build. Refuse them instead of requesting a URL that 404s.
if [[ "$(printf '%s\n%s\n' "v0.3.0" "${VERSION}" | sort -V | head -n 1)" != "v0.3.0" ]]; then
  fail "${VERSION} predates the rename to spinup and cannot be installed with this script. Install v0.3.0 or newer."
fi

OS="$(detect_os)"
ARCH="$(detect_arch)"
LIBC="$(detect_libc_suffix "${OS}")"
ASSET_NAME="spinup-${OS}-${ARCH}${LIBC}"
BASE="${DOWNLOAD_URL}/${VERSION}"

if [[ -n "${LIBC}" && " v0.3.0 v0.4.0 " == *" ${VERSION} "* ]]; then
  fail "${VERSION} has no musl build. Install v0.5.0 or newer."
fi

mkdir -p "${INSTALL_DIR}"
INSTALL_DIR="$(cd "${INSTALL_DIR}" && pwd)"

# Staged in the destination directory, so the final rename cannot cross
# filesystems and is atomic: the old binary stays until the new one is complete.
STAGED="$(mktemp "${INSTALL_DIR}/.spinup.XXXXXX")"
SUMS="$(mktemp "${INSTALL_DIR}/.spinup-sums.XXXXXX")"
MAN_STAGED=""

cleanup() {
  rm -f "${STAGED}" "${SUMS}" ${MAN_STAGED:+"${MAN_STAGED}"}
}
trap cleanup EXIT

echo "Installing spinup ${VERSION} for ${OS}/${ARCH}${LIBC}..."

curl -fsSL "${BASE}/${ASSET_NAME}" -o "${STAGED}" ||
  fail "could not download ${BASE}/${ASSET_NAME}. Check that ${VERSION} exists and publishes ${ASSET_NAME}."

if curl -fsSL "${BASE}/SHA256SUMS" -o "${SUMS}" 2>/dev/null; then
  expected="$(awk -v name="${ASSET_NAME}" '$2 == name || $2 == "*" name { print $1 }' "${SUMS}")"
  [[ -n "${expected}" ]] || fail "SHA256SUMS for ${VERSION} has no entry for ${ASSET_NAME}."
  actual="$(sha256_of "${STAGED}")"
  [[ "${actual}" == "${expected}" ]] ||
    fail "checksum mismatch for ${ASSET_NAME}: expected ${expected}, got ${actual}. Nothing was installed."
  echo "Verified ${ASSET_NAME} against SHA256SUMS."
elif [[ "${UNCHECKSUMMED_RELEASES}" == *" ${VERSION} "* ]]; then
  echo "warning: ${VERSION} was published before releases carried checksums; installing it unverified." >&2
else
  fail "could not download SHA256SUMS for ${VERSION}, so ${ASSET_NAME} cannot be verified. Nothing was installed."
fi

chmod 755 "${STAGED}"

# A binary for the wrong platform or libc passes a checksum but does not start.
reported="$("${STAGED}" --version 2>/dev/null)" ||
  fail "the downloaded binary does not run on this system${LIBC:+ (musl: install libstdc++ and libgcc)}. Nothing was installed."
[[ "${reported}" == "${VERSION#v}" ]] ||
  fail "the downloaded binary reports version '${reported}', expected ${VERSION#v}. Nothing was installed."

mv -f "${STAGED}" "${INSTALL_DIR}/spinup"
echo "Installed to ${INSTALL_DIR}/spinup"

# The man page is a convenience; its absence never fails an install.
if grep -q ' spinup\.1$' "${SUMS}" 2>/dev/null && mkdir -p "${MAN_DIR}" 2>/dev/null; then
  MAN_STAGED="$(mktemp "${MAN_DIR}/.spinup.1.XXXXXX")"

  if curl -fsSL "${BASE}/spinup.1" -o "${MAN_STAGED}" 2>/dev/null &&
    [[ "$(sha256_of "${MAN_STAGED}")" == "$(awk '$2 == "spinup.1" { print $1 }' "${SUMS}")" ]]; then
    chmod 644 "${MAN_STAGED}"
    mv -f "${MAN_STAGED}" "${MAN_DIR}/spinup.1"
    MAN_STAGED=""
  fi
fi

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo "Add this to your shell profile if needed:"
    echo "export PATH=\"${INSTALL_DIR}:\$PATH\""
    ;;
esac
