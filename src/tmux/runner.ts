import path from "node:path";

import { execa } from "execa";

import { buildDependencyGraph } from "../core/dependencies.ts";
import { applyWindowLayout, createPanes, createWindow, getPaneId } from "./layout.ts";
import { attachSession, createSession, ensureTmuxInstalled, killSession, sessionExists } from "./session.ts";
import type { Pane, RunitConfig, TmuxAction } from "../types/config.ts";

async function runTmux(args: string[]): Promise<void> {
  await execa("tmux", args);
}

function escapeShellValue(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolvePaneCwd(projectRoot: string, config: RunitConfig, cwd: string): string {
  const actionRoot = path.resolve(projectRoot, config.root);
  return path.resolve(actionRoot, cwd);
}

function countPanes(action: TmuxAction): number {
  return action.windows.reduce((total, window) => total + window.panes.length, 0);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendPaneCommand(target: string, command: string): Promise<void> {
  await runTmux(["send-keys", "-t", target, command, "C-m"]);
}

async function prepareWindow(
  sessionName: string,
  windowIndex: number,
  action: TmuxAction,
): Promise<void> {
  const window = action.windows[windowIndex];

  await createWindow(sessionName, windowIndex, window);
  await createPanes(sessionName, windowIndex, window.panes.length);
  await applyWindowLayout(sessionName, windowIndex, window.layout);
}

function escapeEnvAssignment(key: string, value: string): string {
  return `${key}=${escapeShellValue(value)}`;
}

function flattenPanes(
  sessionName: string,
  action: TmuxAction,
): Array<{ pane: Pane; target: string }> {
  return action.windows.flatMap((window, windowIndex) =>
    window.panes.map((pane, paneIndex) => ({
      pane,
      target: getPaneId(sessionName, windowIndex, paneIndex),
    })),
  );
}

async function seedPaneCommands(
  sessionName: string,
  projectRoot: string,
  config: RunitConfig,
  action: TmuxAction,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const ordered = buildDependencyGraph(flattenPanes(sessionName, action).map(({ pane }) => pane));
  const paneTargets = new Map(flattenPanes(sessionName, action).map(({ pane, target }) => [pane.name, target]));

  for (const pane of ordered) {
    const target = paneTargets.get(pane.name)!;
    const cwd = resolvePaneCwd(projectRoot, config, pane.cwd);
    const envEntries = Object.entries({
      ...environment,
      ...pane.env,
    }).filter(([, value]) => value !== undefined);

    const commandParts = [`cd ${escapeShellValue(cwd)}`];

    if (envEntries.length > 0) {
      commandParts.push(`export ${envEntries.map(([key, value]) => escapeEnvAssignment(key, String(value))).join(" ")}`);
    }

    // "exec <cmd>" replaced the pane's shell at the first word, truncating compound
    // commands and breaking inline assignments. Handing the whole program to "sh -c"
    // keeps exec's benefit -- the pane closes when the command exits -- without
    // reinterpreting the command itself.
    commandParts.push(`exec sh -c ${escapeShellValue(pane.cmd)}`);
    await sendPaneCommand(target, commandParts.join(" && "));

    if (pane.delay) {
      await delay(pane.delay);
    }
  }
}

export async function launchTmuxWorkspace(
  projectRoot: string,
  config: RunitConfig,
  action: TmuxAction,
  sessionName: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  await ensureTmuxInstalled();

  console.log("[tmux] launching tmux workspace\n");
  console.log(`Session: ${sessionName}`);
  console.log(`Windows: ${action.windows.length}`);
  console.log(`Panes: ${countPanes(action)}`);

  if (await sessionExists(sessionName)) {
    console.log("[tmux] resetting existing session");
    await killSession(sessionName);
  }

  await createSession(sessionName);

  for (const windowIndex of action.windows.keys()) {
    await prepareWindow(sessionName, windowIndex, action);
  }

  console.log("[deps] resolving dependencies");
  await seedPaneCommands(sessionName, projectRoot, config, action, environment);

  await attachSession(sessionName);
}
