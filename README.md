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

> **Renamed from `runit`.** The old name collides with the UNIX service supervisor of
> the same name on apt, Homebrew and npm. Existing installs migrate themselves on the
> next run: the registry moves to `~/.config/spinup`, generated commands are rewritten,
> and a project's existing `.runit.yml` keeps being used as-is.

## Platform support

- Linux x64: supported
- macOS x64 and arm64: supported
- Windows: not officially supported yet

For Windows today, use WSL if you want the same Bash and tmux-oriented workflow.

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

## Stack detection

`spinup` currently detects these stack types:

- `node`
- `python`
- `docker`
- `mixed`
- `unknown`

Notes:

- `mixed` means more than one supported runtime was detected in the same project.
- `unknown` means no supported runtime matched, so you may need to edit the generated config manually.
- More coming soon.

## Install

Latest release:

```bash
curl -fsSL https://raw.githubusercontent.com/PedroElizalde01/runit/main/install.sh | bash
```

The installer supports Linux and macOS.

Then run:

```bash
spinup --help
```

Install a specific version:

```bash
curl -fsSL https://raw.githubusercontent.com/PedroElizalde01/runit/main/install.sh | \
  bash -s -- --version v0.3.0
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

Then run it with the generated shim:

```bash
my-app
```

If the alias already exists, running `spinup my-app` will only tell you that it is already registered.

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
- `spinup <alias> --regenerate`: rescan the repo and refresh `.spinup.yml`
- `spinup <alias> --doctor`: inspect config, stack detection, and tool availability
- `spinup <alias> --check`: validate required tools and config paths
- `spinup <alias> --plan`: print the execution plan
- `spinup <alias> --graph`: show the dependency graph
- `spinup <alias> --env`: show loaded environment variables with values masked
- `spinup <alias> --edit`: open the config in `$EDITOR`
- `spinup <alias> --edit --interactive`: edit the default action with prompts
- `spinup <alias> --remove`: remove the registered project and generated shim
- `spinup --list`: list registered projects
- `spinup --version`: print the installed version

## Terminal Examples

Examples below use a sample monorepo with three detected services: `postgres`, `api`, and `web`.

### `spinup my-app` (first run)

```text
$ spinup my-app
┌────────────────────────────────────────────────────────────┐
│  █▀█ █ █ █▄ █ █ ▀█▀                                        │
│  █▀▄ █▄█ █ ▀█ █  █                                         │
│                                                            │
│ alias      my-app                                          │
│ status     registered                                      │
│ command    ~/.local/bin/my-app                             │
│ root       ~/code/my-app                                   │
├────────────────────────────────────────────────────────────┤
│ stack      mixed                                           │
│ package    npm                                             │
│ frameworks Docker Compose, Express, Vite                   │
│ services   postgres, api, web                              │
├────────────────────────────────────────────────────────────┤
│ action     dev                                             │
│ mode       tmux                                            │
│ windows    1 (services)                                    │
│ panes      3 (postgres, api, web)                          │
│ layout     tiled                                           │
├────────────────────────────────────────────────────────────┤
│ next       my-app                                          │
└────────────────────────────────────────────────────────────┘
```

### `spinup my-app` (already registered)

```text
$ spinup my-app
┌────────────────────────────────────────────────────────────┐
│  █▀█ █ █ █▄ █ █ ▀█▀                                        │
│  █▀▄ █▄█ █ ▀█ █  █                                         │
│                                                            │
│ alias      my-app                                          │
│ status     already registered                              │
│ command    ~/.local/bin/my-app                             │
│ root       ~/code/my-app                                   │
├────────────────────────────────────────────────────────────┤
│ stack      mixed                                           │
│ package    npm                                             │
│ frameworks Docker Compose, Express, Vite                   │
│ services   postgres, api, web                              │
├────────────────────────────────────────────────────────────┤
│ action     dev                                             │
│ mode       tmux                                            │
│ windows    1 (services)                                    │
│ panes      3 (postgres, api, web)                          │
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

Stack detection:
  mixed ✓
  prisma ✗
  docker ✓

Services detected:
  postgres
  api
  web

Package manager:
  npm

Tmux:
  installed ✓

Docker:
  installed ✓

Status:
  ready

Default action services: 3
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

Mode: tmux

Window: services
  pane postgres -> docker compose up postgres (.)
  pane api -> npm run dev (apps/api)
  pane web -> npm run dev (apps/web)
```

### `spinup my-app --graph`

```text
$ spinup my-app --graph
+-----------------+
|  Service Graph  |
+-----------------+

postgres
  ↓
api
  ↓
web
```

### `spinup my-app --env`

```text
$ spinup my-app --env
+---------------+
|  Environment  |
+---------------+

Loaded environment variables:

API_URL=***
DATABASE_URL=***
SESSION_SECRET=***
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
  - Vite
[detect] services:
  - postgres
  - api
  - web

[config] proposed changes:

(no changes)

┌────────────────────────────────────────────────────────────┐
│  █▀█ █ █ █▄ █ █ ▀█▀                                        │
│  █▀▄ █▄█ █ ▀█ █  █                                         │
│                                                            │
│ alias      my-app                                          │
│ status     already registered                              │
│ command    ~/.local/bin/my-app                             │
│ root       ~/code/my-app                                   │
├────────────────────────────────────────────────────────────┤
│ stack      mixed                                           │
│ package    npm                                             │
│ frameworks Docker Compose, Express, Vite                   │
│ services   postgres, api, web                              │
├────────────────────────────────────────────────────────────┤
│ action     dev                                             │
│ mode       tmux                                            │
│ windows    1 (services)                                    │
│ panes      3 (postgres, api, web)                          │
│ layout     tiled                                           │
├────────────────────────────────────────────────────────────┤
│ next       my-app                                          │
└────────────────────────────────────────────────────────────┘
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

my-app -> ~/code/my-app
```

```text
$ spinup --list
Registered projects:

(none)
```

### `spinup --help`

```text
$ spinup --help
Usage: spinup [options] [alias]

Run registered project environments from anywhere.

Arguments:
  alias             registered project alias

Options:
  -v, --version     output the version number
  --check           validate required tools for a registered project
  --doctor          inspect a registered project
  --env             show loaded environment variables
  --edit            edit the project config
  --graph           show service dependency graph
  --interactive     use interactive prompts with --edit
  --plan            preview the execution plan
  -r, --regenerate  re-scan the project and overwrite .spinup.yml
  --remove          remove a registered project and its shim
  --list            list registered projects
  -h, --help        display help for command
```

`--start` is intentionally omitted here because it is an internal flag used by the generated shim command.

## Build

```bash
bun install
bun run check
bun run build
./dist/spinup --help
```

## Release

```bash
git tag v0.3.0
git push origin main v0.3.0
```

Pushing a `v*` tag triggers GitHub Actions to build release binaries and publish a GitHub Release.

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
