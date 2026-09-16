# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `--action <name>` selects a generated action for launching, `--plan`, `--graph`,
  `--env`, `--check` and `--doctor`. Inspection uses exactly the action a launch
  would; an unknown name fails before anything happens and lists the alternatives.
  A non-default action launches in its own tmux session, `<alias>-<action>`.
- `--json` on `--list`, `--plan`, `--graph`, `--env`, `--check` and `--doctor`
  prints one JSON document on stdout and nothing else. Environment values are
  never included.
- `--dry-run` with a launch resolves the action, start order, directories and
  environment origins and starts nothing.
- `--no-color`, alongside `NO_COLOR`.
- `--plan` prints start order, resolved directories, dependencies and delays.
  `--graph` prints each service with the services it actually depends on;
  independent services no longer appear chained together.
- `--list` shows each project's default action, mode and whether its config is
  present and valid.
- Configs carry an optional `version: 1`. A newer version is refused with an
  upgrade message.

- `spinup` with no arguments and `spinup --help` print the wordmark, version and a
  one-line tagline before the usage text. Nothing is printed when stdout is not a
  terminal.
- Interactive edits patch the existing YAML document node by node, so comments and
  formatting on everything that did not change survive a save. Saving without
  changing anything leaves the file's bytes alone and reports "No changes."
- Regenerating keeps the previous config bytes in a private `.spinup.yml.bak`
  before replacing the file.

### Changed

- The CLI exits with the failed task's own status, 130 after a handled Ctrl+C and
  143 after a handled SIGTERM. Every failure used to exit 1. `--check` and
  `--doctor` exit 2 when the selected action cannot run.
- Validation is strict. Unknown keys, blank commands, unexportable environment
  variable names, dependency cycles and empty `simple` actions are rejected at
  load, with the real window and pane path of the offending field.
- The generated command's `--start` means "launch unless a management flag was
  given", so `my-app --doctor` inspects through the wrapper. An explicit
  `spinup --start <alias>` for an unregistered alias fails instead of registering
  the current directory.
- Both backends receive one effective environment, decided once: the invoking
  shell, then the selected files where the shell did not set a key. A tmux pane no
  longer inherits stale keys from a server started long ago.
- Regeneration describes itself as a replacement, lists changed environment keys
  without their values, reports reordering and window changes, and refuses to
  proceed without a terminal to confirm in. An unregistered project with an
  existing config gets the same preview instead of a silent overwrite.
- Switching a multi-window tmux action to `simple` asks before dropping the other
  windows, naming them and their services.
- `--interactive` fails clearly without a terminal instead of hanging on a prompt.
- `--remove` reports when no generated command was found for the alias.
- `--env` reports the action, which files were read, the origin of each key, and
  which keys the shell is overriding. Values remain masked.
- The favicon is an S mark; the `RunitConfig` type is `SpinupConfig`.

### Fixed

- Launching an alias whose tmux session already existed killed that session and
  rebuilt it, restarting the user's running work or destroying an unrelated
  session that happened to share the name. Sessions spinup creates now record
  their project and action; a relaunch attaches to its own session, and any other
  session with that name is left alone with an error naming its owner.
- tmux failures echoed the full command line, which for pane creation included
  every `-e KEY=VALUE`. Failures now report the operation, target and exit status
  with redacted output.
- A lone task ran in spinup's own process group, so SIGTERM sent to spinup left
  its descendants running. Multi-task cleanup skipped any group whose shell had
  exited even when its child still held a port. Every task now runs in its own
  group; shutdown sends SIGTERM, waits a bounded grace period, then SIGKILLs
  survivors, checking group liveness rather than the shell's exit state.
- Registration wrote the project config before the wrapper, so a rejected alias
  had already rewritten `.spinup.yml`, and a failed registry write left a runnable
  wrapper with no entry. The wrapper is created first and removed again if a later
  step fails.
- Removal deleted the registry entry before the wrapper, so a failed unlink left a
  command that launched nothing. The wrapper goes first; a failed removal keeps the
  registration and reports failure.
- The registry lock was evicted on age alone, deleting a slow but live holder's
  lock. The lock now records its holder's pid and is recovered only when that
  process is gone; otherwise the timeout names the holder.
- Interactive saves moved the edited tmux window to the front, invented a layout
  when none was configured, and dropped dependencies on services in other windows.
  Edits now apply to the original window in place, and only references to services
  the user removed are dropped, across every window.
- A real v0.2.2 wrapper carries no marker, so upgrading left it exec'ing the
  removed `runit` binary while spinup refused to repair it as a foreign file.
  Ownership is now established by matching the whole body against the formats
  spinup has written for that alias. Legacy alias collisions no longer produce a
  66-character key; migration creates the new wrapper before reclaiming the old.
- A dangling symlink in the shim directory looked like a missing file and the
  wrapper was created at the link's target. Destinations are classified with
  `lstat`, symlinks and directories are refused, new wrappers are created
  exclusively, and approved wrappers are replaced through a rename.
- Saving an existing `0600` config republished it with the umask default. The
  original mode is preserved, intermediate files are private, and a symlinked
  config has its target replaced rather than the link becoming a regular file.
- `spinup --help | head` no longer prints an EPIPE stack trace.
- Output forwarding in `simple` mode honors backpressure: a slow consumer stalls
  the task instead of the parent queueing its whole output in memory.
- A detached tmux session was created at 80x24, where a few splits already failed
  with "no space for new pane". It now takes the terminal's size or a generous
  default and is resized on attach.
- A wrapper for a new alias was briefly visible empty between creation and write.
  It is now staged privately and published atomically; a lost creation race
  accepts the winner's wrapper instead of failing.

- Environment precedence is defined and documented. A value set in the invoking
  shell now wins over an environment file, and a task's own `env:` block wins over
  both. Files were previously applied on top of the shell, so an explicit
  `PORT=4000 my-app` was silently discarded.
- `.env.development` is no longer read for every action. It was applied even to a
  `build` action, conflating an action with a deployment mode. Files are now
  `.env`, `.env.local`, `.env.<action>`, `.env.<action>.local`, and a mode file for
  a different action is reported as skipped instead of being ignored in silence.
- Environment files resolve against the action's `root` rather than the directory
  the project was registered from.
- `loadEnv` no longer mutates the parent process environment, so `--env` cannot
  change how a later command runs.
- `--check` and `--doctor` exit non-zero when the project cannot run. Both reported
  success while printing the failure: `--check` exited 0 with a missing working
  directory, and `--doctor` printed `ready` with a required tool absent.
- A working directory that exists but is a regular file is now reported. `access()`
  succeeds for a file, so such a config passed validation.
- Tool requirements are inferred from the action that will actually run, instead of
  every action in the file, which demanded tmux from projects that never use it.
- `python` is probed as `python3` first, removing a false negative on the many
  distributions that ship no `python` executable.
- The Docker CLI, the Compose plugin, and a reachable daemon are checked separately.
  `docker -v` proved only the first.
- Tool probes are bounded by a timeout so a diagnostic cannot hang.

## [0.3.0] - 2026-09-06

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
- `--graph` draws edges between independent services (F17).

## [0.2.2] - 2026-03-14

Initial documented release.
