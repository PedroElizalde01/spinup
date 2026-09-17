// Renders spinup.1 from the CLI's own --help, so the man page cannot drift from
// the options. Usage: bun run scripts/build-man.ts > dist/spinup.1

import packageJson from "../package.json" with { type: "json" };

const help = Bun.spawnSync(["bun", "run", new URL("../src/cli.ts", import.meta.url).pathname, "--help"], {
  env: { ...process.env, NO_COLOR: "1" },
});

if (!help.success) {
  throw new Error(`spinup --help failed: ${help.stderr.toString()}`);
}

const text = help.stdout.toString();
const options = text.slice(text.indexOf("Options:") + "Options:".length).trimEnd();

/** roff treats a leading "." or "'" as a request and "\" as an escape. */
function escape(line: string): string {
  return line.replace(/\\/g, "\\e").replace(/^([.'])/, "\\&$1").replace(/-/g, "\\-");
}

const page = [
  `.TH SPINUP 1 "${new Date().toISOString().slice(0, 10)}" "spinup ${packageJson.version}" "User Commands"`,
  ".SH NAME",
  "spinup \\- register a project once and reopen its dev environment from anywhere",
  ".SH SYNOPSIS",
  ".B spinup",
  "[\\fIalias\\fR] [\\fIoptions\\fR]",
  ".SH DESCRIPTION",
  "spinup scans a project, writes \\fI.spinup.yml\\fR, and installs a command named after the alias",
  "that launches the project's services from any directory, as foreground processes or a tmux workspace.",
  "Inside a project directory the alias can be omitted.",
  ".SH OPTIONS",
  ".nf",
  ...options.split("\n").map(escape),
  ".fi",
  ".SH EXIT STATUS",
  ".TP", "0", "Success.",
  ".TP", "1", "Usage, configuration or registration error.",
  ".TP", "2", "\\-\\-check or \\-\\-doctor found the selected action cannot run.",
  ".TP", "3", "\\-\\-status found the session is not running.",
  ".TP", "\\fIn\\fR", "A task in a simple action exited with status \\fIn\\fR.",
  ".TP", "130, 143", "Stopped by SIGINT or SIGTERM after the tasks were shut down.",
  ".SH FILES",
  ".TP", "\\fI.spinup.yml\\fR", "Per-project configuration.",
  ".TP", "\\fI$XDG_CONFIG_HOME/spinup/projects.json\\fR", "Alias registry.",
  ".TP", "\\fI~/.local/bin/<alias>\\fR", "Generated launch command.",
  ".TP", "\\fI$XDG_STATE_HOME/spinup/logs/\\fR", "Service logs written with \\-\\-logs.",
  ".SH ENVIRONMENT",
  ".TP", "NO_COLOR", "Disables colored output.",
  ".TP", "XDG_CONFIG_HOME, XDG_STATE_HOME", "Relocate the registry and logs.",
  ".TP", "SPINUP_SHIM_DIR", "Directory for generated commands.",
  ".SH SEE ALSO",
  "tmux(1), https://github.com/PedroElizalde01/spinup",
  "",
].join("\n");

process.stdout.write(page);
