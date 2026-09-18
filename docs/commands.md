# Commands

`spinup [alias] [options]`. Inside a project directory the alias can usually be
left out: spinup uses the directory's registered alias, or the config's name when
the directory is not registered. Each alias command, such as `my-app`, accepts the
same options.

## Registering

| Command | What it does |
|---|---|
| `spinup <alias>` | Registers the current directory, generating `.spinup.yml` if there is none, and installs the `<alias>` command. For an alias that already exists, prints its card. |
| `spinup --init` | The same, step by step: choose the alias, review and edit detected commands, preview, confirm. |
| `spinup <alias> --path <dir>` | Registers `<dir>` instead of the current directory. |
| `spinup <alias> --relink` | Points the alias at the current directory, or `--path`. For moved checkouts and worktrees. |
| `spinup <alias> --regenerate` | Rescans and replaces the config after showing what changes. Keeps the old file as `.spinup.yml.bak`. |
| `spinup <alias> --edit` | Opens the config in `$VISUAL` or `$EDITOR`. Add `--interactive` to edit services with prompts, keeping comments. |
| `spinup <alias> --remove` | Removes the command and the registration. The project's files are untouched. |
| `spinup --list` | Registered projects with their default action and whether their config is valid. |

## Inspecting

| Command | What it does |
|---|---|
| `--plan` | Start order, resolved directories, dependencies, readiness conditions and delays. |
| `--graph` | A timeline: one row per service, a bar for the wave it starts in, what it waits for and when it counts as ready. Bars are start positions, not durations. |
| `--env` | Environment keys, their source file, and shell overrides. Values are never shown. |
| `--check` | Required tools, directories and busy ports for the selected action. |
| `--doctor` | Everything `--check` does, plus actions, detection with the origin of each command, and notes. |
| `--dry-run` | With a launch: what would run, the environment sources and busy ports. Starts nothing. |

`--plan`, `--graph`, `--env`, `--check`, `--doctor`, `--status` and `--list` accept
`--json`, which prints one JSON document and nothing else on stdout.

## Running

| Command | What it does |
|---|---|
| `<alias>` or `spinup --start <alias>` | Launches the default action. |
| `spinup --start` | Launches the current directory's config without registering anything. |
| `--action <name>` | Selects another action, for launching and for every inspection and session command. |
| `--logs` | Also writes each service's output to a private log file. |

## Sessions

These act only on the tmux session spinup created for the project and action, and
refuse any other session with the same name.

| Command | What it does |
|---|---|
| `--status` | Whether the session is running, and each service's state, pid or exit status. |
| `--attach` | Attaches to the session, or switches to it from inside tmux. |
| `--restart <service>` | Restarts one service from the current config and waits until it is ready. |
| `--restart` | Stops and relaunches the whole session. |
| `--stop` | Ends the session. Stopping a session that is not running is not an error. |

## Maintenance

| Command | What it does |
|---|---|
| `spinup --update [version]` | Replaces the binary with a verified release. |
| `spinup --completion bash\|zsh\|fish` | Prints a shell completion script. |
| `spinup --version` | Prints the version. |

## Global options

| Option | Effect |
|---|---|
| `-y`, `--yes` | Answers yes to confirmations. Without a terminal, confirmations fail unless this is given. |
| `--no-color` | Disables color. `NO_COLOR` does the same. |

## Exit status

| Status | Meaning |
|---|---|
| 0 | Success |
| 1 | Usage, configuration or registration error |
| 2 | `--check` or `--doctor` found the selected action cannot run |
| 3 | `--status` found the session is not running |
| n | A task in a `simple` action exited with status n |
| 130, 143 | Stopped by Ctrl+C or SIGTERM, after every task was shut down |
