# tmux sessions

An action with `mode: tmux` runs in a tmux session named after the alias, or
`<alias>-<action>` for a non-default action.

## Ownership

spinup records which project directory and action created each session. It only
ever acts on a session it created for the same project and action:

- Launching again while the session runs attaches to it instead of restarting it.
- A session with the same name that spinup did not create, or that belongs to
  another project or action, is never touched. The command fails and tells you how
  to attach to it or end it yourself.

## Commands

```bash
my-app --status            # running? each service's state, pid or exit status, log path
my-app --attach            # attach, or switch client from inside tmux
my-app --restart api       # respawn one pane from the current config, wait until ready
my-app --restart           # the whole session
my-app --stop              # end it
```

`--status --json` is available for scripts, and `--status` exits 3 when the session
is not running.

Restarting a service reports the services that depend on it without restarting
them; whether they need it depends on the application.

## Readiness failures

If a service's `ready` condition fails or times out, the run stops and names the
condition, and the session is kept so the failing pane can be inspected. End it with
`my-app --stop`.

## Logs

```bash
my-app --logs
```

Each pane's output is also written to
`$XDG_STATE_HOME/spinup/logs/<alias>/<service>.log` (by default
`~/.local/state/spinup/logs/`). Files are private to your user, the previous run is
kept as `.log.1`, and each file stops at 10 MB. A pane that already has a
`pipe-pane` of its own is left alone.

## Environment

Panes receive exactly the environment spinup resolved: the invoking shell, the
environment files and each service's `env:`. Variables set in the tmux server long
ago are removed for the session, so a pane does not inherit stale values. tmux's own
`TMUX` and `TMUX_PANE` are kept.

## Terminal size

A new session takes the size of the terminal it was launched from, so several panes
fit before you attach; tmux resizes it when a client attaches. Settings such as
`base-index 1` are respected.
