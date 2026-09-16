import { stat } from "node:fs/promises";
import path from "node:path";

import { execa } from "execa";

import type { ProjectDetection } from "./detectors/types.ts";
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
};

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

function commandUses(command: string, prefix: string): boolean {
  return command === prefix || command.startsWith(`${prefix} `);
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
 * Tools required by the action that will actually run. Considering every action in
 * the file demanded tmux for a project whose selected action is `simple`.
 */
export function inferRequiredTools(
  config: SpinupConfig,
  detection: ProjectDetection,
  actionName?: string,
): string[] {
  const tools = new Set<string>();
  const entries = getConfigEntries(config, actionName);
  const actions = actionName
    ? [config.actions[actionName]].filter(Boolean)
    : Object.values(config.actions);

  for (const action of actions) {
    if (action?.mode === "tmux") {
      tools.add("tmux");
    }
  }

  if (
    detection.services.some((service) => service.runtime === "node") ||
    entries.some((entry) => /(^|\s)(npm|pnpm|yarn|bun|node)\b/.test(entry.cmd))
  ) {
    tools.add("node");
  }

  if (
    detection.services.some((service) => service.runtime === "python") ||
    entries.some((entry) => /(^|\s)(python|uvicorn|flask)\b/.test(entry.cmd))
  ) {
    tools.add("python");
  }

  if (
    detection.services.some((service) => service.runtime === "docker") ||
    entries.some((entry) => commandUses(entry.cmd, "docker"))
  ) {
    tools.add("docker");
  }

  if (detection.packageManager && detection.packageManager !== "unknown") {
    tools.add(detection.packageManager);
  } else {
    for (const entry of entries) {
      for (const manager of ["pnpm", "npm", "yarn", "bun"] as const) {
        if (commandUses(entry.cmd, manager)) {
          tools.add(manager);
        }
      }
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

export function collectToolWarnings(detection: ProjectDetection, tools: ToolCheck[]): string[] {
  const warnings: string[] = [];
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));

  if (detection.services.some((service) => service.runtime === "docker") && toolMap.get("docker")?.installed === false) {
    warnings.push("Docker not installed but docker-compose detected.");
  }

  if (tools.some((tool) => !tool.installed)) {
    for (const tool of tools.filter((entry) => !entry.installed)) {
      warnings.push(`${tool.name} is required but not installed.`);
    }
  }

  return unique(warnings);
}
