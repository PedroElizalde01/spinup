# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

A reliability release. Every entry below was reproduced against v0.2.2 and
re-verified after the change; see `RUNIT_REVIEW.md` section 11 for the evidence.

### Security

- Aliases now accept one narrow format everywhere. Previously `../../name` wrote a
  file outside the shim directory, an alias containing `$(...)` ran that substitution
  on every invocation, and an existing executable in the shim directory was replaced
  without warning.
- `runit` refuses an alias that would shadow a command already on `PATH`, and refuses
  to overwrite or delete a file in the shim directory that it did not create.
- Compiled binaries no longer absorb the `.env` of the directory they are invoked
  from. Launching one project from inside another handed over that directory's
  environment, including credentials.
- tmux panes receive their environment through tmux rather than having `export`
  statements typed into a shell, so values are no longer recoverable from pane
  scrollback.
- Replaced `js-yaml` and updated `yaml`, clearing four published advisories (two
  high). `bun audit` now runs in CI.

### Fixed

- Commands are no longer prefixed with `exec` before being handed to a shell. That
  replaced the shell at the first word, so `a && b` ran only `a`, pipelines lost
  their tail, and `FOO=bar cmd` failed outright.
- A failing task now aborts its siblings instead of leaving them running until the
  longest-lived one exits on its own, and the originating exit code is preserved.
- Multi-task runs terminate the whole process group, so a shell's descendants no
  longer survive as orphans holding ports.
- Task output is streamed rather than buffered. A task emitting more than 100MB was
  previously killed mid-run.
- tmux sessions are targeted by exact name. Launching `api` previously matched and
  destroyed an unrelated `api-staging` session.
- tmux windows and panes are addressed by the ids tmux assigns, fixing startup under
  `base-index`/`pane-base-index` set to 1.
- Layout is reapplied as panes are added; eight services in a small window previously
  failed with `no space for new pane` after the fourth.
- `runit` switches the current client instead of failing when already inside tmux.
- A failure while building a workspace tears down only the session `runit` created.
- Concurrent registrations no longer lose entries. Twenty parallel registrations kept
  16 of 20 while creating all 20 shims; they now keep all 20.
- The registry and `.runit.yml` are replaced atomically, so an interrupted write
  leaves either the old file or the new one.
- Shim creation precedes registration, so a refused alias cannot leave a registered
  project with no runnable command.

### Added

- `runit --version`, sourced from `package.json` so source and compiled builds agree.
- `XDG_CONFIG_HOME` support for the registry, ignoring a relative value as the spec
  requires, and `RUNIT_SHIM_DIR` to relocate generated commands.
- A one-time migration for aliases registered before the format was enforced: they
  are renamed, their shims moved, and each change reported. Entries that cannot be
  rescued are reported and left in place rather than dropped.
- A CI workflow gating typecheck, tests, `bun audit`, ShellCheck, and a binary smoke
  test that verifies version parity and the dotenv isolation above. Releases now
  require it to pass. Actions are pinned to commit SHAs and build jobs run read-only.

### Changed

- Unrecognized command-line arguments are rejected instead of silently discarded.
- tmux workspace mode requires tmux 3.0 or newer, the first release with the `-e`
  flag used to pass environment to a pane. `mode: simple` needs no tmux.
- tmux panes are created in configuration order and started in dependency order, so
  pane position no longer depends on the dependency graph.

### Known issues

Carried over from v0.2.2 and tracked in `RUNIT_REVIEW.md`:

- Generated `docker`, `prisma-generate`, and `prisma-migrate` actions still cannot be
  selected; every start path uses the default action (F18).
- Interactive editing discards `env`, `delay`, and `dependsOn`, and the plain editor
  path strips comments. `--regenerate` compares sets of lines, so swapping two
  services' commands reports no changes (F05, F06).
- `dependsOn` orders startup only; it does not wait for readiness (F10).
- `--check` and `--doctor` can report success for an environment that cannot run
  (F16), and `--graph` draws edges between independent services (F17).
- `loadEnv` still mutates the parent process environment and always reads
  `.env.development` regardless of the action (F15).

## [0.2.2] - 2026-03-14

Initial documented release.
