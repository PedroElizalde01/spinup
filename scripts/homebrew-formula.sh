#!/usr/bin/env bash
# Renders the Homebrew formula for a release from its SHA256SUMS.
# Usage: scripts/homebrew-formula.sh <version-without-v> <SHA256SUMS> > Formula/spinup.rb

set -euo pipefail

version="$1"
sums="$2"
base="https://github.com/PedroElizalde01/spinup/releases/download/v${version}"

sha() {
  local value
  value="$(awk -v name="$1" '$2 == name || $2 == "*" name { print $1 }' "${sums}")"

  if [[ -z "${value}" ]]; then
    echo "no checksum for $1 in ${sums}" >&2
    exit 1
  fi

  echo "${value}"
}

cat <<FORMULA
class Spinup < Formula
  desc "Register a project once and reopen its dev environment from anywhere"
  homepage "https://github.com/PedroElizalde01/spinup"
  version "${version}"
  license "MIT"

  on_macos do
    on_arm do
      url "${base}/spinup-darwin-arm64"
      sha256 "$(sha spinup-darwin-arm64)"
    end
    on_intel do
      url "${base}/spinup-darwin-x64"
      sha256 "$(sha spinup-darwin-x64)"
    end
  end

  on_linux do
    on_arm do
      url "${base}/spinup-linux-arm64"
      sha256 "$(sha spinup-linux-arm64)"
    end
    on_intel do
      url "${base}/spinup-linux-x64"
      sha256 "$(sha spinup-linux-x64)"
    end
  end

  resource "man" do
    url "${base}/spinup.1"
    sha256 "$(sha spinup.1)"
  end

  def install
    bin.install Dir["spinup-*"].first => "spinup"
    resource("man").stage { man1.install "spinup.1" }
  end

  def caveats
    <<~EOS
      Actions using mode: tmux need tmux 3.0 or newer:
        brew install tmux
    EOS
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/spinup --version").strip
  end
end
FORMULA
