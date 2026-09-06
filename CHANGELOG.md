# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Renamed

The tool is now **`spinup`**. `runit` is an established UNIX service supervisor that
already occupies `apt install runit`, `brew install runit` and the `runit` npm package,
which left no usable distribution channel and made the project hard to search for.

Existing installations migrate on the next run, with each change reported:

- `~/.config/runit` moves to `~/.config/spinup`, and only when the new path is absent.
- Generated commands that still exec `runit` are rewritten to exec `spinup`.
- A project's existing `.runit.yml` keeps being read and written in place. New projects
  get `.spinup.yml`. No project ends up with both.
- `RUNIT_SHIM_DIR` is still honored; `SPINUP_SHIM_DIR` is the current name.

The GitHub repository and installer URL are unchanged.

A reliability release. Every entry below was reproduced against v0.2.2 and
re-verified after the change; see `RUNIT_REVIEW.md` section 11 for the evidence.

### Security

- Aliases now accept one narrow format everywhere. Previously `../../name` wrote a
  file outside the shim directory, an alias containing `$(...)` ran that substitution
  on every invocation, and an existing executable in the shim directory was replaced
  without warning.
- `spinup` refuses an alias that would shadow a command already on `PATH`, and refuses
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
- `spinup` switches the current client instead of failing when already inside tmux.
- A failure while building a workspace tears down only the session `spinup` created.
- Concurrent registrations no longer lose entries. Twenty parallel registrations kept
  16 of 20 while creating all 20 shims; they now keep all 20.
- The registry and the project config are replaced atomically, so an interrupted write
  leaves either the old file or the new one.
- Shim creation precedes registration, so a refused alias cannot leave a registered
  project with no runnable command.
- Interactive editing preserves `env`, `delay` and `dependsOn`, and the window's own
  name and layout, instead of rebuilding each service from name, cwd and command.
  Removing a service also drops references to it, so the result still validates.
- Opening the config in `$EDITOR` and changing nothing now leaves the file untouched.
  It was reserialized on every edit, stripping comments and reflowing inline lists.
- `$EDITOR` values carrying arguments, such as `code --wait`, work. The value was
  treated as a single executable name and failed with ENOENT.
- `--regenerate` compares configurations structurally. It previously diffed sets of
  trimmed lines, so swapping two services' commands reported no changes at all and
  the change was never applied.

### Added

- `linux-arm64` release binaries. The installer already resolved that platform, so it
  previously pointed at an asset that was never built.
- An MIT `LICENSE`. The project had none, which reserved all rights and contradicted
  distributing it.
- `spinup --version`, sourced from `package.json` so source and compiled builds agree.
- `XDG_CONFIG_HOME` support for the registry, ignoring a relative value as the spec
  requires, and `SPINUP_SHIM_DIR` to relocate generated commands.
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
- `dependsOn` orders startup only; it does not wait for readiness (F10).
- `--check` and `--doctor` can report success for an environment that cannot run
  (F16), and `--graph` draws edges between independent services (F17).
- `loadEnv` still mutates the parent process environment and always reads
  `.env.development` regardless of the action (F15).

## [0.2.2] - 2026-03-14

Initial documented release.
