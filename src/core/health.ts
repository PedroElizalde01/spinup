import { stat } from "node:fs/promises";
import path from "node:path";

import { execa } from "execa";

import type { Action, Pane, SpinupConfig, Task } from "../types/config.ts";

export type ToolCheck = {
  name: string;
  installed: boolean;
  /** Which candidate satisfied the check, e.g. "python3" for "python". */
  resolvedCommand?: string;
  version?: string;
};

type ToolDefinition = {
  /** Tried in order; the first that responds satisfies the check. */
  commands: string[];
  args: string[];
};

// A probe must not hang a diagnostic command.
const TOOL_PROBE_TIMEOUT_MS = 5000;

const TOOL_COMMANDS: Record<string, ToolDefinition> = {
  tmux: { commands: ["tmux"], args: ["-V"] },
  docker: { commands: ["docker"], args: ["-v"] },
  node: { commands: ["node"], args: ["-v"] },
  // Many distributions ship only python3, so probing "python" alone reported a
  // false negative on a perfectly working project.
  python: { commands: ["python3", "python"], args: ["-V"] },
  npm: { commands: ["npm"], args: ["-v"] },
  pnpm: { commands: ["pnpm"], args: ["-v"] },
  yarn: { commands: ["yarn"], args: ["-v"] },
  bun: { commands: ["bun"], args: ["-v"] },
  uv: { commands: ["uv"], args: ["--version"] },
  poetry: { commands: ["poetry"], args: ["--version"] },
  just: { commands: ["just"], args: ["--version"] },
  make: { commands: ["make"], args: ["--version"] },
  task: { commands: ["task"], args: ["--version"] },
  mise: { commands: ["mise"], args: ["--version"] },
  go: { commands: ["go"], args: ["version"] },
  air: { commands: ["air"], args: ["-v"] },
  cargo: { commands: ["cargo"], args: ["--version"] },
  ruby: { commands: ["ruby"], args: ["-v"] },
  bundle: { commands: ["bundle"], args: ["-v"] },
  php: { commands: ["php"], args: ["-v"] },
  java: { commands: ["java"], args: ["-version"] },
  gradle: { commands: ["gradle"], args: ["--version"] },
  mvn: { commands: ["mvn"], args: ["-v"] },
  deno: { commands: ["deno"], args: ["--version"] },
};

/**
 * What the first word of a command needs installed. Only that word is read: a
 * shell program cannot be analyzed in general, and scanning for "python"
 * anywhere demanded a system Python for `uv run uvicorn`, which uv provides.
 */
const COMMAND_TOOLS: Record<string, string[]> = {
  npm: ["npm", "node"],
  npx: ["npm", "node"],
  pnpm: ["pnpm", "node"],
  yarn: ["yarn", "node"],
  node: ["node"],
  // Bun is its own runtime; it does not need Node.
  bun: ["bun"],
  bunx: ["bun"],
  python: ["python"],
  python3: ["python"],
  uvicorn: ["python"],
  flask: ["python"],
  gunicorn: ["python"],
  uv: ["uv"],
  poetry: ["poetry"],
  docker: ["docker"],
  just: ["just"],
  make: ["make"],
  task: ["task"],
  mise: ["mise"],
  go: ["go"],
  air: ["air", "go"],
  cargo: ["cargo"],
  "bin/rails": ["ruby"],
  bundle: ["bundle", "ruby"],
  php: ["php"],
  // The wrappers download their own build tool but still need a JDK.
  "./gradlew": ["java"],
  gradle: ["gradle", "java"],
  "./mvnw": ["java"],
  mvn: ["mvn", "java"],
  deno: ["deno"],
};

/** Leading `VAR=value` assignments are part of the shell line, not the program. */
function programOf(command: string): string {
  const words = command.trim().split(/\s+/);
  const program = words.find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) ?? "";
  return program;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function getActionEntries(action: Action): Array<Task | Pane> {
  return action.mode === "tmux" ? action.windows.flatMap((window) => window.panes) : action.tasks ?? [];
}

function getConfigEntries(config: SpinupConfig, actionName?: string): Array<Task | Pane> {
  if (actionName) {
    const action = config.actions[actionName];
    return action ? getActionEntries(action) : [];
  }

  return Object.values(config.actions).flatMap((action) => {
    if (action.mode === "tmux") {
      return action.windows.flatMap((window) => window.panes);
    }

    return action.tasks ?? [];
  });
}

function getActionTaskPaths(config: SpinupConfig, actionName?: string): Array<{ name: string; cwd: string }> {
  return getConfigEntries(config, actionName).map((entry) => ({
    name: entry.name,
    cwd: entry.cwd,
  }));
}

export async function checkTool(name: string): Promise<ToolCheck> {
  const definition = TOOL_COMMANDS[name];

  if (!definition) {
    throw new Error(`Unknown tool check: ${name}`);
  }

  let lastError: unknown;

  for (const command of definition.commands) {
    try {
      const result = await execa(command, definition.args, { timeout: TOOL_PROBE_TIMEOUT_MS });
      return {
        name,
        resolvedCommand: command,
        installed: true,
        version: result.stdout.trim() || result.stderr.trim() || undefined,
      };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    name,
    installed: false,
    version:
      (lastError as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
        ? undefined
        : lastError instanceof Error
          ? lastError.message
          : undefined,
  };
}

/**
 * The Docker CLI, the Compose plugin and a reachable daemon are three separate
 * things. "docker -v" proves only the first, so a project needing Compose could
 * report a clean check and then fail at launch.
 */
export type DockerCapability = {
  cli: boolean;
  compose: boolean;
  daemon: boolean;
};

export async function checkDocker(): Promise<DockerCapability> {
  const probe = async (args: string[]): Promise<boolean> => {
    try {
      await execa("docker", args, { timeout: TOOL_PROBE_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  };

  const cli = await probe(["-v"]);

  if (!cli) {
    return { cli: false, compose: false, daemon: false };
  }

  return {
    cli,
    compose: await probe(["compose", "version"]),
    daemon: await probe(["info", "--format", "{{.ServerVersion}}"]),
  };
}

export async function checkTools(names: string[]): Promise<ToolCheck[]> {
  return Promise.all(unique(names).map((name) => checkTool(name)));
}

/**
 * Tools required by the commands of the action that will actually run. Neither
 * other actions nor the detected stack count: a Bun command does not need Node,
 * and a project's Python service does not matter to its `docker` action.
 */
export function inferRequiredTools(config: SpinupConfig, actionName?: string): string[] {
  const tools = new Set<string>();
  const actions = actionName ? [config.actions[actionName]].filter(Boolean) : Object.values(config.actions);

  for (const action of actions) {
    if (action?.mode === "tmux") {
      tools.add("tmux");
    }
  }

  for (const entry of getConfigEntries(config, actionName)) {
    for (const tool of COMMAND_TOOLS[programOf(entry.cmd)] ?? []) {
      tools.add(tool);
    }
  }

  return [...tools];
}

export async function validateConfigPaths(
  projectRoot: string,
  config: SpinupConfig,
  actionName?: string,
): Promise<string[]> {
  const warnings: string[] = [];

  for (const task of getActionTaskPaths(config, actionName)) {
    const absolutePath = path.resolve(projectRoot, config.root, task.cwd);

    try {
      // access() succeeds for a regular file, so a cwd pointing at one passed.
      const stats = await stat(absolutePath);

      if (!stats.isDirectory()) {
        warnings.push(`Service "${task.name}" cwd is not a directory: ${task.cwd}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        warnings.push(`Service "${task.name}" cwd not found: ${task.cwd}`);
        continue;
      }

      throw error;
    }
  }

  return warnings;
}

export function collectToolWarnings(tools: ToolCheck[]): string[] {
  const warnings: string[] = [];

  if (tools.some((tool) => !tool.installed)) {
    for (const tool of tools.filter((entry) => !entry.installed)) {
      warnings.push(`${tool.name} is required but not installed.`);
    }
  }

  return unique(warnings);
}
