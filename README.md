<div align="center">
<pre>
    ███████╗██████╗ ██╗███╗   ██╗██╗   ██╗██████╗
     ██╔════╝██╔══██╗██║████╗  ██║██║   ██║██╔══██╗
     ███████╗██████╔╝██║██╔██╗ ██║██║   ██║██████╔╝
    ╚════██║██╔═══╝ ██║██║╚██╗██║██║   ██║██╔═══╝
███████║██║     ██║██║ ╚████║╚██████╔╝██║
╚══════╝╚═╝     ╚═╝╚═╝  ╚═══╝ ╚═════╝ ╚═╝
</pre>

Project environment launcher CLI
</div>

---

`spinup` registers project aliases, generates a `.spinup.yml`, and launches your dev
environment from anywhere.

**Documentation:** [quick start](docs/quick-start.md) · [installation](docs/installation.md) ·
[configuration](docs/configuration.md) · [commands](docs/commands.md) ·
[detection](docs/detection.md) · [tmux sessions](docs/sessions.md) · [upgrading](docs/upgrading.md)

> **Renamed from `runit`.** The old name collides with the UNIX service supervisor of
> the same name on apt, Homebrew and npm. Existing installs migrate themselves on the
> next run: the registry moves to `~/.config/spinup`, generated commands are rewritten,
> and a project's existing `.runit.yml` keeps being used as-is.

## Platform support

| Platform | Build | Tested in CI |
|---|---|---|
| Linux x64 | glibc and musl (Alpine) | test suite and binary smoke test |
| Linux arm64 | glibc and musl (Alpine) | test suite and binary smoke test |
| macOS arm64 (Apple Silicon) | native | test suite and binary smoke test |
| macOS x64 (Intel) | native | test suite and binary smoke test |

Every release runs its smoke test on each published file, on the machine it is for.
On Windows, use WSL.

## Requirements

- **tmux 3.0 or newer**, only for actions using `mode: tmux`. `spinup` passes each
  pane its command, working directory, and environment through tmux itself, which
  needs the `-e` flag added in 3.0. Actions using `mode: simple` need no tmux.
- **Docker**, only for projects with a Compose file.

`spinup <alias> --check` reports what a given project actually needs.

## Alias rules

An alias becomes a real command in `~/.local/bin`, so the accepted format is narrow:

- lowercase letters, digits, `-` and `_`
- must start with a letter or digit, at most 64 characters

Uppercase input is lowercased, so `MyApp` and `myapp` are the same project. `.` and
`:` are rejected because tmux reads them as session/window/pane separators.

`spinup` refuses an alias that would shadow a command already on your `PATH`, and
refuses to overwrite a file in the shim directory that it did not create. Aliases
registered before these rules existed are renamed automatically on the next run,
and the change is reported.

## Detection

Registering a project without a config scans it and writes `.spinup.yml`. Nothing
is executed during the scan except `docker compose config`, which starts nothing.
The command for each service is chosen in this order:

1. **A command the project defines for development:** an executable `bin/dev`, the
   entries of `Procfile.dev` (except `release`), or a `dev` recipe, target or task
   in `justfile`, `Makefile`, `Taskfile.yml` or `mise.toml`. It runs on its own,
   because it already starts what it needs. Other launchers found are reported.
2. **A root `dev` script in a monorepo**, which is its orchestrator (turbo, nx, …).
3. **Each workspace member**: `dev`, `start:dev`, `develop`, `serve`, then `start`.
   `test` and `check` are never chosen. Declared `workspaces` and
   `pnpm-workspace.yaml` globs are expanded, including `!` exclusions; without a
   declaration, `apps/*`, `services/*` and `packages/*` are considered.
4. **Python apps whose entrypoint is found in source**: `manage.py`, or an
   `app = FastAPI()` / `app = Flask()` object, run through `uv run`, `poetry run`
   or a local `.venv` when the project uses one.
5. **Compose** as a single `docker compose up`, using Compose's own file
   precedence, override file and profiles. Profiled services stay optional.

The package manager comes from `packageManager` in `package.json`, then the
lockfile, and a disagreement between them is reported. Services with the same name
are told apart by runtime (`app-node`, `app-python`) or path (`apps-api`,
`services-api`).

Each generated service carries a comment saying where its command came from, and
`--doctor` shows the same for a fresh scan. When nothing runnable is found, spinup
asks for the command in a terminal and fails elsewhere; it never writes a guess.

## Install

Latest release:

```bash
curl -fsSL https://raw.githubusercontent.com/PedroElizalde01/spinup/main/install.sh | bash
```

The installer picks the build for your OS, architecture and C library, verifies it
against the release's `SHA256SUMS`, confirms it runs, and only then replaces an
existing binary. Update later with `spinup --update`. See
[installation](docs/installation.md) for verifying provenance, shell completion and
uninstalling.

Then run:

```bash
spinup --help
```

Install a specific version:

```bash
curl -fsSL https://raw.githubusercontent.com/PedroElizalde01/spinup/main/install.sh | \
  bash -s -- --version v0.5.0
```

If `spinup` is not found after install, add this to your shell profile:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## Usage

Register the current project and create the alias command:

```bash
spinup my-app
```

Or step by step, reviewing every detected command before anything is written:

```bash
spinup --init
```

Then run it with the generated shim:

```bash
my-app
```

If the alias already exists, running `spinup my-app` will only tell you that it is already registered.

Running the alias again while its tmux session is still up attaches to that session
instead of rebuilding it. A session with the same name that spinup did not create,
or that belongs to another project or action, is never touched: the launch fails and
tells you how to attach to or end it.

Inspect and manage a registered project:

```bash
spinup my-app --doctor
spinup my-app --check
spinup my-app --plan
spinup my-app --graph
spinup my-app --env
spinup my-app --edit
spinup my-app --edit --interactive
spinup my-app --remove
```

Every generated config can hold several actions (`dev`, `docker`, `prisma-migrate`,
…). `--action` selects one for inspection or launch; the default action is used
otherwise:

```bash
my-app --action prisma-migrate        # launch a non-default action
spinup my-app --plan --action docker  # inspect exactly what that launch would do
my-app --dry-run                      # resolve everything, start nothing
```

Manage a running tmux workspace. These act only on the session spinup created for
this project and action, and refuse any other session with the same name:

```bash
my-app --status            # running? each service's state; exits 3 when not running
my-app --attach
my-app --restart api       # respawn one service and wait until it is ready
my-app --restart           # the whole session
my-app --stop
```

Inside a project directory the alias can be left out. `spinup --start` runs the
directory's `.spinup.yml` as it is, without registering anything or installing a
command, and `spinup --status`, `--stop`, `--plan` and the rest act on that project.

The generated command forwards its flags, so `my-app --doctor` inspects instead of
launching. Inspection commands accept `--json` and then print one JSON document on
stdout with nothing else; environment values are never included.

Regenerate the config from the current project structure:

```bash
spinup my-app --regenerate
```

List registered projects:

```bash
spinup --list
```

## Commands

- `spinup <alias>`: register if needed, otherwise report that the alias already exists
- `spinup <alias> --regenerate`: rescan the repo and replace `.spinup.yml` after a preview and confirmation; the previous file is kept as `.spinup.yml.bak`
- `spinup <alias> --doctor`: inspect config, actions, stack detection, and tool availability
- `spinup <alias> --check`: validate required tools and config paths for the selected action
- `spinup <alias> --plan`: print start order, resolved directories, dependencies and delays
- `spinup <alias> --graph`: a tree of what waits for what, with readiness conditions
- `spinup <alias> --env`: show loaded environment keys and their origin, values masked
- `spinup <alias> --edit`: open the config in `$EDITOR`
- `spinup <alias> --edit --interactive`: edit the default action with prompts, keeping comments
- `spinup <alias> --remove`: remove the registered project and generated shim
- `spinup --list`: list registered projects with their default action and config state
- `spinup <alias> --status`: whether the tmux session is running and each service's state
- `spinup <alias> --attach`: attach to the running tmux session
- `spinup <alias> --stop`: end the tmux session
- `spinup <alias> --restart [service]`: restart one service, or the whole session
- `spinup --version`: print the installed version
- `spinup --init`: register step by step, reviewing detected commands and previewing what is written
- `spinup <alias> --path <dir>`: register a directory other than the current one
- `spinup <alias> --relink`: point an alias at the current directory, or `--path`, after a move or for a worktree
- `spinup --update [version]`: replace the binary with a verified release
- `spinup --completion bash|zsh|fish`: print a shell completion script

Modifiers: `--action <name>` (launch, plan, graph, env, check, doctor, status,
attach, stop, restart), `--logs` (launch, restart a whole session: write each
service's output to a private log), `-y/--yes` (answer confirmations, for scripts),
`--json` (list, plan, graph, env, check, doctor, status), `--dry-run` (launch), `--no-color` or the
`NO_COLOR` environment variable.

## Exit status

| Status | Meaning |
|---|---|
| 0 | Success |
| 1 | Usage, configuration or registration error |
| 2 | `--check` or `--doctor` found the selected action cannot run |
| 3 | `--status`: the session is not running |
| _n_ | A task in a `simple` action exited with status _n_; spinup returns it unchanged |
| 130 | Stopped by Ctrl+C after the tasks were shut down |
| 143 | Stopped by SIGTERM after the tasks were shut down |

In `simple` mode every task runs in its own process group. On failure or on a
signal, spinup sends SIGTERM to each group, waits three seconds, and kills whatever
is still running, so a shell's children do not outlive the run.

## Terminal Examples

Examples below use a sample npm workspace with `apps/api`, `apps/web` and a `compose.yaml` running Postgres and Redis.

### `spinup my-app` (first run)

```text
$ spinup my-app
┌────────────────────────────────────────────────────────────┐
│  █▀▀ █▀█ █ █▄ █ █ █ █▀█                                    │
│  ▄▄█ █▀▀ █ █ ▀█ █▄█ █▀▀                                    │
│                                                            │
│ alias      my-app                                          │
│ status     registered                                      │
│ command    ~/.local/bin/my-app                             │
│ root       ~/code/my-app                                   │
├────────────────────────────────────────────────────────────┤
│ stack      mixed                                           │
│ package    npm                                             │
│ frameworks Docker Compose, Express, React, Vite            │
│ services   compose, api, web                               │
├────────────────────────────────────────────────────────────┤
│ actions    dev (default), docker                           │
│ action     dev                                             │
│ mode       tmux                                            │
│ windows    1 (services)                                    │
│ panes      3 (compose, api, web)                           │
│ layout     tiled                                           │
├────────────────────────────────────────────────────────────┤
│ next       my-app                                          │
└────────────────────────────────────────────────────────────┘
```

### `spinup my-app` (already registered)

```text
$ spinup my-app
┌────────────────────────────────────────────────────────────┐
│  █▀▀ █▀█ █ █▄ █ █ █ █▀█                                    │
│  ▄▄█ █▀▀ █ █ ▀█ █▄█ █▀▀                                    │
│                                                            │
│ alias      my-app                                          │
│ status     already registered                              │
│ command    ~/.local/bin/my-app                             │
│ root       ~/code/my-app                                   │
├────────────────────────────────────────────────────────────┤
│ stack      mixed                                           │
│ package    npm                                             │
│ frameworks Docker Compose, Express, React, Vite            │
│ services   compose, api, web                               │
├────────────────────────────────────────────────────────────┤
│ actions    dev (default), docker                           │
│ action     dev                                             │
│ mode       tmux                                            │
│ windows    1 (services)                                    │
│ panes      3 (compose, api, web)                           │
│ layout     tiled                                           │
├────────────────────────────────────────────────────────────┤
│ next       my-app                                          │
└────────────────────────────────────────────────────────────┘
```

### `spinup my-app --doctor`

```text
$ spinup my-app --doctor
+------------------+
|  Project Doctor  |
+------------------+

Project: my-app
Path: /home/user/code/my-app

Config file:
  /home/user/code/my-app/.spinup.yml ✓

Actions:
  dev (default)
  docker

Inspecting: dev (tmux)

Stack detection:
  mixed ✓
  frameworks Docker Compose, Express, React, Vite

A fresh scan would generate:
  compose: docker compose up  (compose.yaml)
  api: npm run dev  (apps/api/package.json scripts.dev)
  web: npm run dev  (apps/web/package.json scripts.dev)

Services in this action:
  compose
  api
  web

Package manager:
  npm

Tmux: required
  installed ✓

Docker: required
  installed ✓

Status:
  ready
```

### `spinup my-app --check`

```text
$ spinup my-app --check
+--------------------+
| Environment Check  |
+--------------------+

tmux ✓
node ✓
docker ✓
npm ✓
```

### `spinup my-app --plan`

```text
$ spinup my-app --plan
+------------------+
|  Execution Plan  |
+------------------+

Action: dev (tmux)
Root:   /home/user/code/my-app

Start order:
  1. compose  ready when port localhost:5432
     cwd /home/user/code/my-app
     docker compose up
  2. api  after compose
     cwd /home/user/code/my-app/apps/api
     npm run dev
  3. web  after compose, api
     cwd /home/user/code/my-app/apps/web
     npm run dev

Windows:
  services (tiled): compose, api, web
```

### `spinup my-app --graph`

```text
$ spinup my-app --graph
+-----------------+
|  Service Graph  |
+-----------------+

Action: dev

compose  ready when port localhost:5432
└─ api
   └─ web  also after compose
```

### `spinup my-app --env`

```text
$ spinup my-app --env
+---------------+
|  Environment  |
+---------------+

Action: dev
Files:  .env, .env.local

Loaded environment variables:

API_URL=*** [.env]
DATABASE_URL=*** [.env.local]
SESSION_SECRET=*** [.env] (overridden by the shell)
```

### `spinup my-app --edit`

```text
$ spinup my-app --edit
# opens $EDITOR with .spinup.yml
# no terminal output on success
```

### `spinup my-app --edit --interactive`

```text
$ spinup my-app --edit --interactive
? Edit action "dev"
❯ Add service
  Remove service
  Change command
  Change cwd
  Toggle mode (current: tmux)
  Save changes
  Cancel

↑↓ navigate • ⏎ select

✔ Edit action "dev" Cancel
Edit cancelled.
```

### `spinup my-app --regenerate`

```text
$ spinup my-app --regenerate
[scan] scanning project

[detect] stack: mixed
[detect] package manager: npm
[detect] frameworks:
  - Docker Compose
  - Express
  - React
  - Vite
[detect] services:
  - compose: docker compose up  (compose.yaml)
  - api: npm run dev  (apps/api/package.json scripts.dev)
  - web: npm run dev  (apps/web/package.json scripts.dev)

[config] proposed changes:

~ dev.api.cmd: npm start -> npm run dev

[config] regenerating replaces .spinup.yml entirely.
[config] custom actions, comments and formatting not listed above are lost.

? Replace the config? (y/N) y
[config] updated .spinup.yml (previous copy in .spinup.yml.bak)
```

### `spinup my-app --remove`

```text
$ spinup my-app --remove
Removed project "my-app" (/home/user/code/my-app)
```

### `spinup --list`

```text
$ spinup --list
Registered projects:

my-app  dev (tmux)  ~/code/my-app
```

### `spinup my-app --status`

```text
$ spinup my-app --status
my-app (dev) is running in tmux session "my-app".

  compose  running  pid 48211
  api      running  pid 48230
  web      exited   status 1

$ spinup my-app --restart web
Restarted web.

$ spinup my-app --stop
Stopped my-app (dev).
```

### `spinup --help`

```text
$ spinup --help
Usage: spinup [options] [alias]

Run registered project environments from anywhere.

Arguments:
  alias             registered project alias

Options:
  -v, --version        output the version number
  -a, --action <name>  act on this action instead of the default
  --check              validate required tools for a registered project
  --doctor             inspect a registered project
  --env                show loaded environment variables
  --edit               edit the project config
  --graph              show what waits for what, as a tree
  --interactive        use interactive prompts with --edit
  --plan               preview the execution plan
  --dry-run            with --start: resolve everything and start nothing
  --json               print inspection results as JSON
  --no-color           disable colored output
  -r, --regenerate     re-scan the project and overwrite the project config
  --remove             remove a registered project and its shim
  --list               list registered projects
  --status             show whether the tmux session is running and each service's state
  --attach             attach to the running tmux session
  --stop               end the tmux session
  --restart [service]  restart one service in the tmux session, or the whole session
  -h, --help           display help for command
```

`--start` is omitted from the help because the generated command passes it. It means
"launch unless a management flag was given", so `my-app --plan` previews and `my-app`
launches. `spinup --start <alias>` never registers anything.

## Build

```bash
bun install
bun run check
bun run build
./dist/spinup --help
```

## Release

Bump `version` in `package.json`, move the CHANGELOG's unreleased notes under the new
version, then:

```bash
git tag -a v0.5.0 -m "v0.5.0"
git push origin main v0.5.0
```

The release workflow refuses a tag that disagrees with `package.json`, runs the full
CI, builds every target, runs the smoke test on each file on its own platform, and
publishes the binaries, `spinup.1`, `SHA256SUMS` and build provenance. With a
`HOMEBREW_TAP_TOKEN` secret it also updates the `PedroElizalde01/homebrew-spinup` tap.

Generated files are checked by tests; regenerate them after changing their source:

```bash
bun run scripts/build-schema.ts       # schema/spinup.schema.json from the config schema
bun run scripts/site-hero-card.ts     # site/hero-card.json from the setup card code
```

## Files and environment

| Path | Purpose |
|---|---|
| `.spinup.yml` | Per-project config, committed with the repo (`.runit.yml` is still read if present) |
| `${XDG_CONFIG_HOME:-~/.config}/spinup/projects.json` | Alias-to-path registry |
| `~/.local/bin/<alias>` | Generated command for each registered project |

`XDG_CONFIG_HOME` relocates the registry; a relative value is ignored, as the XDG
spec requires. `SPINUP_SHIM_DIR` relocates generated commands, which is mainly useful
for testing.

Environment files are read from the action's root (`root` in the config) in this
order, with later files winning:

```
.env  ->  .env.local  ->  .env.<action>  ->  .env.<action>.local
```

`<action>` is the action's own name, so a `dev` action reads `.env.dev`. A file for
a different action, such as `.env.production` while running `dev`, is reported as
skipped rather than silently ignored.

Precedence, highest first:

1. A task's own `env:` block in the config
2. A value already set in the invoking shell, e.g. `PORT=4000 my-app`
3. The environment files above

Values are passed to each service directly and never echoed into a terminal. Use
`spinup <alias> --env` to see which keys are loaded, which file each came from, and
which are being overridden by your shell. Values stay masked.

## Config

Generated projects use a `.spinup.yml` file like this:

```yaml
version: 1
name: my-app
root: .
default: dev
actions:
  dev:
    mode: simple
    tasks:
      - name: app
        cwd: .
        cmd: npm run dev
```

Validation is strict: an unknown key, a blank command, an environment variable name
the shell cannot export, a dependency cycle or a `simple` action with no tasks is
rejected with the path of the offending field. `version` is optional and means `1`
when absent; a file with a newer version than this build understands is refused
with an upgrade message.

Every `cwd` resolves against `root`, which resolves against the project directory.

### Dependencies and readiness

Every service starts as soon as the services it `dependsOn` are ready. A service
with no `ready` condition counts as ready once it has started, plus its `delay`. A
condition makes its dependents wait for something real:

```yaml
tasks:
  - name: db
    cwd: .
    cmd: docker compose up postgres
    ready: { port: 5432 }                       # accepts TCP connections (host defaults to localhost)
  - name: migrate
    cwd: .
    cmd: npx prisma migrate deploy
    dependsOn: [db]
    ready: { exit: 0 }                          # a one-shot step that must succeed
  - name: api
    cwd: apps/api
    cmd: npm run dev
    dependsOn: [migrate]
    ready: { http: "http://localhost:3000/health", timeout: 60000 }   # any answer below 500
  - name: web
    cwd: apps/web
    cmd: npm run dev
    dependsOn: [api]
    ready: { log: "ready in \\d+ ms" }         # a line of output matches this pattern
```

`timeout` is in milliseconds and defaults to two minutes. A condition that fails,
times out, or whose process exits first stops the run and names the condition. In
tmux the session is kept so the failing pane can be inspected. Services that do not
depend on each other are never held up by one another. A task's `env:` block wins over the invoking shell, which wins over the
selected environment files.
