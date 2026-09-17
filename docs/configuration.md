# Configuration

A project is described by `.spinup.yml` in its root. A generated file starts with
a line that gives editors with the YAML language server completion and validation:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/PedroElizalde01/spinup/main/schema/spinup.schema.json
version: 1
name: my-app
root: .
default: dev
actions:
  dev:
    mode: tmux
    windows:
      - name: services
        layout: tiled
        panes:
          - name: db
            cwd: .
            cmd: docker compose up
            ready: { port: 5432 }
          - name: api
            cwd: apps/api
            cmd: npm run dev
            dependsOn: [db]
          - name: web
            cwd: apps/web
            cmd: npm run dev
            dependsOn: [api]
  migrate:
    mode: simple
    tasks:
      - name: prisma
        cwd: .
        cmd: npx prisma migrate dev
```

## Writing it by hand

The generated file is a starting point. Edit it whenever the detected commands
are not how you want to run the project. Only `--regenerate` replaces it, and
that keeps the old file as `.spinup.yml.bak`.

The usual reason is a monorepo. Detection prefers the root `dev` script, so a
repository whose root runs `concurrently` or `turbo dev` becomes a single `app`
service. To run each application as its own service instead, replace that task
with one service per application:

```yaml
version: 1
name: shop
root: .
default: dev
actions:
  dev:
    mode: tmux
    windows:
      - name: apps
        layout: even-horizontal
        panes:
          - name: backend
            cwd: apps/backend
            cmd: npm run start:dev
            ready: { port: 3000 }
          - name: frontend
            cwd: apps/frontend
            cmd: npm run dev
            dependsOn: [backend]
  migrate:
    mode: simple
    tasks:
      - name: prisma
        cwd: apps/backend
        cmd: npm run db:migrate:dev
```

Each service then has its own pane, log and `--restart` target, and the
frontend waits for the backend's port. `cwd` is relative to `root`, so an
application's own `.env` is still read by its tooling from its directory.

After editing, `my-app --plan` shows the start order and `my-app --check`
validates the file. A mistake is reported by field, for example
`actions.dev.windows.0.panes.1.cwd`. `my-app --edit` opens the file in
`$VISUAL` or `$EDITOR`.

## Top level

| Key | Required | Meaning |
|---|---|---|
| `version` | no | Config format version. Omitted means `1`. A newer version than spinup understands is refused. |
| `name` | yes | Project name. Used as the session name when the directory is not registered. |
| `root` | yes | Directory that every `cwd` and environment file resolves against, relative to this file. |
| `default` | yes | The action launched when `--action` is not given. |
| `actions` | yes | Named ways to run the project. |

## Actions

An action is either `simple` or `tmux`.

**simple** runs each task as a foreground process group with its output prefixed by
the task name. Ctrl+C stops every task, including processes the task's shell
started. A single task can read the terminal.

```yaml
mode: simple
tasks:
  - name: app
    cwd: .
    cmd: npm run dev
```

**tmux** runs each service in a pane of a tmux session that spinup creates and owns.

```yaml
mode: tmux
windows:
  - name: services
    layout: even-horizontal     # optional: even-horizontal, even-vertical, main-horizontal, main-vertical, tiled
    panes:
      - name: api
        cwd: .
        cmd: npm run dev
```

## Services

Tasks and panes have the same fields.

| Key | Required | Meaning |
|---|---|---|
| `name` | yes | Unique within the action. Used for panes, dependencies, logs and `--restart`. |
| `cwd` | yes | Working directory, relative to `root`. |
| `cmd` | yes | A shell command, run exactly as written: pipes, `&&` and `VAR=value cmd` all work. |
| `dependsOn` | no | Services that must be ready before this one starts. |
| `ready` | no | When this service counts as ready for its dependents. See below. |
| `delay` | no | Milliseconds to wait after this service is ready before its dependents start. |
| `env` | no | Environment variables for this service only. Names must be valid shell names. |

Validation is strict. An unknown key, a blank command, a dependency on a service
that does not exist, a cycle, or a `simple` action with no tasks is an error that
names the exact field, for example `actions.dev.windows.1.panes.0.name`.

## Dependencies and readiness

Every service starts as soon as the services it depends on are ready, so services
that do not depend on each other start in parallel.

Without `ready`, a service is ready once it has started, plus its `delay`. A
condition makes dependents wait for something real:

| Condition | Ready when |
|---|---|
| `ready: { port: 5432 }` | The port accepts TCP connections. `host` defaults to localhost over IPv4 and IPv6. |
| `ready: { http: "http://localhost:3000/health" }` | The URL answers with any status below 500. |
| `ready: { log: "ready in \\d+ ms" }` | A line of the service's output matches the regular expression. |
| `ready: { exit: 0 }` | The process exits successfully. For one-shot steps such as migrations. |

Each accepts `timeout` in milliseconds, 120000 by default. A condition that fails,
times out, or whose process exits first stops the run and names the condition. In
tmux, the session is kept so you can look at the failing pane.

## Environment

Environment files are read from `root`, later files winning:

```
.env  ->  .env.local  ->  .env.<action>  ->  .env.<action>.local
```

Precedence, highest first:

1. The service's own `env:` block
2. A value set in the invoking shell, such as `PORT=4000 my-app`
3. The environment files

Values are passed to processes directly and never typed into a terminal.
`--env` lists the keys, which file each came from, and which the shell overrides,
with values masked. In tmux, variables left in a long-running tmux server that are
not part of this environment are removed for the session.

## Personal files

`.spinup.yml.bak` is written when `--regenerate` replaces a config. Logs from
`--logs` live under `$XDG_STATE_HOME/spinup/logs/`. Neither belongs in version
control.
