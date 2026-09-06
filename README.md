<div align="center">
<pre>
   ██████╗ ██╗   ██╗███╗   ██╗██╗████████╗
   ██╔══██╗██║   ██║████╗  ██║██║╚══██╔══╝
██████╔╝██║   ██║██╔██╗ ██║██║   ██║
██╔══██╗██║   ██║██║╚██╗██║██║   ██║
██║  ██║╚██████╔╝██║ ╚████║██║   ██║
╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝   ╚═╝
</pre>

Project environment launcher CLI
</div>

---

`runit` registers project aliases, generates a `.runit.yml`, and launches your dev environment from anywhere.

## Platform support

- Linux x64: supported
- macOS x64 and arm64: supported
- Windows: not officially supported yet

For Windows today, use WSL if you want the same Bash and tmux-oriented workflow.

## Requirements

- **tmux 3.0 or newer**, only for actions using `mode: tmux`. `runit` passes each
  pane its command, working directory, and environment through tmux itself, which
  needs the `-e` flag added in 3.0. Actions using `mode: simple` need no tmux.
- **Docker**, only for projects with a Compose file.

`runit <alias> --check` reports what a given project actually needs.

## Alias rules

An alias becomes a real command in `~/.local/bin`, so the accepted format is narrow:

- lowercase letters, digits, `-` and `_`
- must start with a letter or digit, at most 64 characters

Uppercase input is lowercased, so `MyApp` and `myapp` are the same project. `.` and
`:` are rejected because tmux reads them as session/window/pane separators.

`runit` refuses an alias that would shadow a command already on your `PATH`, and
refuses to overwrite a file in the shim directory that it did not create. Aliases
registered before these rules existed are renamed automatically on the next run,
and the change is reported.

## Stack detection

`runit` currently detects these stack types:

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
runit --help
```

Install a specific version:

```bash
curl -fsSL https://raw.githubusercontent.com/PedroElizalde01/runit/main/install.sh | \
  bash -s -- --version v0.2.2
```

If `runit` is not found after install, add this to your shell profile:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## Usage

Register the current project and create the alias command:

```bash
runit my-app
```

Then run it with the generated shim:

```bash
my-app
```

If the alias already exists, running `runit my-app` will only tell you that it is already registered.

Inspect and manage a registered project:

```bash
runit my-app --doctor
runit my-app --check
runit my-app --plan
runit my-app --graph
runit my-app --env
runit my-app --edit
runit my-app --edit --interactive
runit my-app --remove
```

Regenerate the config from the current project structure:

```bash
runit my-app --regenerate
```

List registered projects:

```bash
runit --list
```

## Commands

- `runit <alias>`: register if needed, otherwise report that the alias already exists
- `runit <alias> --regenerate`: rescan the repo and refresh `.runit.yml`
- `runit <alias> --doctor`: inspect config, stack detection, and tool availability
- `runit <alias> --check`: validate required tools and config paths
- `runit <alias> --plan`: print the execution plan
- `runit <alias> --graph`: show the dependency graph
- `runit <alias> --env`: show loaded environment variables with values masked
- `runit <alias> --edit`: open the config in `$EDITOR`
- `runit <alias> --edit --interactive`: edit the default action with prompts
- `runit <alias> --remove`: remove the registered project and generated shim
- `runit --list`: list registered projects
- `runit --version`: print the installed version

## Terminal Examples

Examples below use a sample monorepo with three detected services: `postgres`, `api`, and `web`.

### `runit my-app` (first run)

```text
$ runit my-app
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

### `runit my-app` (already registered)

```text
$ runit my-app
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

### `runit my-app --doctor`

```text
$ runit my-app --doctor
+------------------+
|  Project Doctor  |
+------------------+

Project: my-app
Path: /home/user/code/my-app

Config file:
  /home/user/code/my-app/.runit.yml ✓

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

### `runit my-app --check`

```text
$ runit my-app --check
+--------------------+
| Environment Check  |
+--------------------+

tmux ✓
node ✓
docker ✓
npm ✓
```

### `runit my-app --plan`

```text
$ runit my-app --plan
+------------------+
|  Execution Plan  |
+------------------+

Mode: tmux

Window: services
  pane postgres -> docker compose up postgres (.)
  pane api -> npm run dev (apps/api)
  pane web -> npm run dev (apps/web)
```

### `runit my-app --graph`

```text
$ runit my-app --graph
+-----------------+
|  Service Graph  |
+-----------------+

postgres
  ↓
api
  ↓
web
```

### `runit my-app --env`

```text
$ runit my-app --env
+---------------+
|  Environment  |
+---------------+

Loaded environment variables:

API_URL=***
DATABASE_URL=***
SESSION_SECRET=***
```

### `runit my-app --edit`

```text
$ runit my-app --edit
# opens $EDITOR with .runit.yml
# no terminal output on success
```

### `runit my-app --edit --interactive`

```text
$ runit my-app --edit --interactive
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

### `runit my-app --regenerate`

```text
$ runit my-app --regenerate
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

### `runit my-app --remove`

```text
$ runit my-app --remove
Removed project "my-app" (/home/user/code/my-app)
```

### `runit --list`

```text
$ runit --list
Registered projects:

my-app -> ~/code/my-app
```

```text
$ runit --list
Registered projects:

(none)
```

### `runit --help`

```text
$ runit --help
Usage: runit [options] [alias]

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
  -r, --regenerate  re-scan the project and overwrite .runit.yml
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
./dist/runit --help
```

## Release

```bash
git tag v0.2.2
git push origin main v0.2.2
```

Pushing a `v*` tag triggers GitHub Actions to build release binaries and publish a GitHub Release.

## Files and environment

| Path | Purpose |
|---|---|
| `.runit.yml` | Per-project config, committed with the repo |
| `${XDG_CONFIG_HOME:-~/.config}/runit/projects.json` | Alias-to-path registry |
| `~/.local/bin/<alias>` | Generated command for each registered project |

`XDG_CONFIG_HOME` relocates the registry; a relative value is ignored, as the XDG
spec requires. `RUNIT_SHIM_DIR` relocates generated commands, which is mainly useful
for testing.

Environment files are read from the project root in this order, with later files
winning: `.env`, `.env.local`, `.env.development`, `.env.<action>`. Values are passed
to each service directly, never echoed into a terminal. Use `runit <alias> --env` to
see which keys are loaded, with values masked.

## Config

Generated projects use a `.runit.yml` file like this:

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
