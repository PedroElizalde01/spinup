# Upgrading

Update with `spinup --update`. Each release's full list of changes is in the
[changelog](https://github.com/PedroElizalde01/spinup/blob/main/CHANGELOG.md).

## To 0.6.0

`--graph` prints a tree instead of one line per service. Scripts that read it
should use `--graph --json`, which is unchanged apart from a new `wave` field.

## To 0.5.0

Nothing in an existing config needs to change.

- Release files now include musl builds. The installer picks them on Alpine.
- `--check` reports ports the action needs that are already in use, and exits 2.
- Generated configs start with a schema line for editor completion. Existing files
  are unchanged until `--regenerate`.
- Go, Rust, Ruby, PHP, Java/Kotlin and Deno projects are detected, which affects
  only newly generated configs.

## To 0.4.0

- **Strict validation.** A misspelled or unsupported key, a blank command, an invalid
  environment variable name, a dependency cycle or an empty `simple` action is now
  an error. `spinup <alias> --doctor` names the field.
- **Exit statuses.** A failed task's own status is returned; 130 or 143 after a
  signal; 2 from `--check` and `--doctor`; 3 from `--status`.
- **`delay`** holds back only that service's dependents.
- **Relaunching** a running tmux session attaches to it. Use `--restart` to restart.
- **Compose** is one `compose` service in newly generated configs.

## From runit

spinup was called runit before 0.3.0. The first run migrates an old installation:
the registry moves from `~/.config/runit` to `~/.config/spinup`, generated commands
are rewritten, and an existing `.runit.yml` keeps being used where it is.
