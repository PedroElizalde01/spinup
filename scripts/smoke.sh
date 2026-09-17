#!/usr/bin/env bash
# End-to-end check of a built binary: no tmux, Docker or network needed, so it runs
# the same on every release target, including inside an Alpine container.
#
# Usage: scripts/smoke.sh <binary> <expected-version>

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: scripts/smoke.sh <binary> <expected-version>" >&2
  exit 2
fi

bin="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
expected="$2"
root="$(mktemp -d)"
trap 'rm -rf "${root}"' EXIT

export HOME="${root}/home"
export XDG_CONFIG_HOME="${root}/config"
export SPINUP_SHIM_DIR="${root}/bin"
export NO_COLOR=1
mkdir -p "${HOME}" "${XDG_CONFIG_HOME}" "${SPINUP_SHIM_DIR}" "${root}/project" "${root}/caller"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

step() {
  echo "--- $*"
}

step "version"
actual="$("${bin}" --version)"
[[ "${actual}" == "${expected}" ]] || fail "binary reports '${actual}', expected '${expected}'"

step "help"
"${bin}" --help > /dev/null

cat > "${root}/project/.spinup.yml" <<'CONFIG'
version: 1
name: smoke
root: .
default: dev
actions:
  dev:
    mode: simple
    tasks:
      - name: probe
        cwd: .
        cmd: sh -c 'echo CANARY_VALUE=[$SPINUP_LEAK_CANARY]'
  failing:
    mode: simple
    tasks:
      - name: code
        cwd: .
        cmd: exit 42
CONFIG

step "register"
(cd "${root}/project" && "${bin}" smoke > /dev/null)
[[ -x "${SPINUP_SHIM_DIR}/smoke" ]] || fail "no generated command"

step "plan as JSON for a non-default action"
"${bin}" smoke --plan --action failing --json | grep -q '"action": "failing"' || fail "plan"

step "dry run starts nothing"
"${bin}" --start smoke --dry-run | grep -q 'nothing was started' || fail "dry run"

# F04: Bun autoloads .env from the invocation directory into compiled executables
# unless the build disables it. A project must not receive the caller's values.
step "caller-directory .env is not loaded"
echo "SPINUP_LEAK_CANARY=leaked" > "${root}/caller/.env"
output="$(cd "${root}/caller" && "${bin}" --start smoke 2>&1)"
if grep -q 'CANARY_VALUE=\[leaked\]' <<< "${output}"; then
  fail "caller .env leaked into the project"
fi
grep -q 'CANARY_VALUE=\[\]' <<< "${output}" || fail "probe did not run: ${output}"

step "a task's exit status passes through"
set +e
"${bin}" --start smoke --action failing > /dev/null 2>&1
status=$?
set -e
[[ "${status}" == "42" ]] || fail "expected exit 42, got ${status}"

step "remove"
"${bin}" smoke --remove > /dev/null
[[ ! -e "${SPINUP_SHIM_DIR}/smoke" ]] || fail "generated command left behind"

echo "smoke OK: ${expected}"
