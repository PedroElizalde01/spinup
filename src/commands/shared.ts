import path from "node:path";

import { CONFIG_FILENAME, configExists, formatConfigError, loadConfig } from "../core/config.ts";
import { getProject } from "../core/registry.ts";
import type { Action, Pane, SpinupConfig, Task } from "../types/config.ts";

export type LoadedProject = {
  alias: string;
  projectRoot: string;
  config: SpinupConfig;
};

export type SelectedAction = {
  actionName: string;
  action: Action;
};

/** A registered project with a valid config, or a clear reason it is not. */
export async function loadRegisteredProject(alias: string): Promise<LoadedProject> {
  const projectRoot = await getProject(alias);

  if (!projectRoot) {
    throw new Error(`Project alias "${alias}" not registered`);
  }

  if (!(await configExists(projectRoot))) {
    throw new Error(`${CONFIG_FILENAME} not found\nRegenerate using:\n\nspinup ${alias} -r`);
  }

  try {
    return { alias, projectRoot, config: await loadConfig(projectRoot) };
  } catch (error) {
    throw new Error(formatConfigError(error));
  }
}

/**
 * The action every inspection and launch agrees on. Rejected before any side
 * effect, so an unknown name never creates a session or touches a file.
 */
export function selectAction(config: SpinupConfig, requested?: string): SelectedAction {
  const actionName = requested ?? config.default;
  const action = config.actions[actionName];

  if (!action) {
    const available = Object.keys(config.actions).join(", ");
    throw new Error(`Action "${actionName}" is not defined. Available actions: ${available}`);
  }

  return { actionName, action };
}

export function actionEntries(action: Action): Array<Task | Pane> {
  return action.mode === "tmux" ? action.windows.flatMap((window) => window.panes) : action.tasks ?? [];
}

/** The tmux session an alias/action pair owns; the default action keeps the bare alias. */
export function sessionNameFor(alias: string, config: SpinupConfig, actionName: string): string {
  return actionName === config.default ? alias : `${alias}-${actionName}`;
}

export function resolveActionRoot(projectRoot: string, config: SpinupConfig): string {
  return path.resolve(projectRoot, config.root);
}
