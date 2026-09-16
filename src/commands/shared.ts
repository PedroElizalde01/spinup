import path from "node:path";

import { CONFIG_FILENAME, configExists, formatConfigError, loadConfig } from "../core/config.ts";
import { loadEnv, type LoadedEnv } from "../core/env.ts";
import { getProject, listProjects, sanitizeLegacyAlias } from "../core/registry.ts";
import { canonicalProject } from "../tmux/session.ts";
import type { Action, Pane, SpinupConfig, Task } from "../types/config.ts";

export type LoadedProject = {
  alias: string;
  projectRoot: string;
  config: SpinupConfig;
  /** False when working from the current directory's config without a registration. */
  registered: boolean;
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
    return { alias, projectRoot, config: await loadConfig(projectRoot), registered: true };
  } catch (error) {
    throw new Error(formatConfigError(error));
  }
}

/**
 * The project an alias names, or with no alias, the one in the current directory.
 * A directory that is registered keeps its alias, so its sessions are the same
 * ones the alias command sees. Otherwise the config's name is the identity.
 * Nothing is registered and no command is installed either way.
 */
export async function loadProject(alias: string | undefined): Promise<LoadedProject> {
  if (alias) {
    return loadRegisteredProject(alias);
  }

  const projectRoot = process.cwd();

  if (!(await configExists(projectRoot))) {
    throw new Error(
      `No alias was given and ${projectRoot} has no ${CONFIG_FILENAME}.\n` +
        "Pass a registered alias, or run this from a project directory. Nothing is generated here.",
    );
  }

  let config: SpinupConfig;

  try {
    config = await loadConfig(projectRoot);
  } catch (error) {
    throw new Error(formatConfigError(error));
  }

  const here = await canonicalProject(projectRoot);

  for (const [registeredAlias, registeredRoot] of Object.entries(await listProjects())) {
    if ((await canonicalProject(registeredRoot)) === here) {
      return { alias: registeredAlias, projectRoot, config, registered: true };
    }
  }

  const derived = sanitizeLegacyAlias(config.name);

  if (!derived) {
    throw new Error(`The config name "${config.name}" cannot be used as a session name. Register the project with an alias instead.`);
  }

  return { alias: derived, projectRoot, config, registered: false };
}

/**
 * The whole application environment, decided once: the invoking shell, then the
 * selected files where the shell did not already set a key. Both backends get
 * exactly this; a task's own env: block is layered on top by the backend.
 */
export async function resolveLaunchEnvironment(
  projectRoot: string,
  config: SpinupConfig,
  actionName: string,
): Promise<{ environment: NodeJS.ProcessEnv; loaded: LoadedEnv }> {
  // Environment files live next to the action's root, not necessarily the
  // directory the project was registered from.
  const loaded = await loadEnv(resolveActionRoot(projectRoot, config), actionName);
  return { environment: { ...process.env, ...loaded.applied }, loaded };
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
