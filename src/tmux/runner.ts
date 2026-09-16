import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { buildDependencyGraph } from "../core/dependencies.ts";
import { addPane, applyWindowLayout, renameWindow, respawnPane } from "./layout.ts";
import {
  attachSession,
  createSession,
  createWindow,
  ensureTmuxInstalled,
  exactTarget,
  killSession,
  killSessionQuietly,
  sessionExists,
} from "./session.ts";
import type { Pane, SpinupConfig, TmuxAction } from "../types/config.ts";

type PlacedPane = {
  pane: Pane;
  paneId: string;
};

function resolvePaneCwd(projectRoot: string, config: SpinupConfig, cwd: string): string {
  const actionRoot = path.resolve(projectRoot, config.root);
  return path.resolve(actionRoot, cwd);
}

function countPanes(action: TmuxAction): number {
  return action.windows.reduce((total, window) => total + window.panes.length, 0);
}

/**
 * Builds every window and pane up front, recording the id tmux assigned to each.
 * Panes start as the default shell and are replaced with their real command later,
 * so layout position stays in config order while start order follows dependencies.
 */
async function buildWorkspace(
  sessionId: string,
  firstWindowId: string,
  firstPaneId: string,
  action: TmuxAction,
): Promise<PlacedPane[]> {
  const placed: PlacedPane[] = [];

  for (const [windowIndex, window] of action.windows.entries()) {
    let windowId: string;
    let initialPaneId: string;

    if (windowIndex === 0) {
      // Reuse the window the session was created with.
      windowId = firstWindowId;
      initialPaneId = firstPaneId;
      await renameWindow(windowId, window.name);
    } else {
      const created = await createWindow(sessionId, window.name);
      windowId = created.windowId;
      initialPaneId = created.paneId;
    }

    placed.push({ pane: window.panes[0]!, paneId: initialPaneId });

    for (const pane of window.panes.slice(1)) {
      placed.push({ pane, paneId: await addPane(windowId, window.layout) });
    }

    await applyWindowLayout(windowId, window.layout);
  }

  return placed;
}

async function startPanes(
  projectRoot: string,
  config: SpinupConfig,
  placed: PlacedPane[],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const paneIds = new Map(placed.map(({ pane, paneId }) => [pane.name, paneId]));
  const ordered = buildDependencyGraph(placed.map(({ pane }) => pane));

  for (const pane of ordered) {
    await respawnPane(paneIds.get(pane.name)!, {
      cwd: resolvePaneCwd(projectRoot, config, pane.cwd),
      env: { ...environment, ...pane.env },
      cmd: pane.cmd,
    });

    if (pane.delay) {
      await delay(pane.delay);
    }
  }
}

export async function launchTmuxWorkspace(
  projectRoot: string,
  config: SpinupConfig,
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
    await killSession(exactTarget(sessionName));
  }

  const { sessionId, windowId, paneId } = await createSession(sessionName);

  try {
    const placed = await buildWorkspace(sessionId, windowId, paneId, action);
    console.log("[deps] resolving dependencies");
    await startPanes(projectRoot, config, placed, environment);
  } catch (error) {
    // Never leave a half-built workspace behind; remove only the session we made.
    await killSessionQuietly(sessionId);
    throw error;
  }

  await attachSession(sessionName, sessionId);
}
