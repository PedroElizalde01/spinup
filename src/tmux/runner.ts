import path from "node:path";

import { buildDependencyGraph } from "../core/dependencies.ts";
import { ReadinessFailure, scheduleServices } from "../core/readiness.ts";
import { addPane, applyWindowLayout, keepPaneOnExit, paneView, renameWindow, respawnPane } from "./layout.ts";
import {
  attachSession,
  createSession,
  createWindow,
  canonicalProject,
  ensureTmuxInstalled,
  findSessionId,
  isolateSessionEnvironment,
  killSessionQuietly,
  markPaneService,
  markSessionOwner,
  readSessionOwner,
  TMUX_OWNED_KEYS,
} from "./session.ts";
import type { Pane, SpinupConfig, TmuxAction } from "../types/config.ts";

type PlacedPane = {
  pane: Pane;
  paneId: string;
};

export function resolvePaneCwd(projectRoot: string, config: SpinupConfig, cwd: string): string {
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

    for (const { pane, paneId } of placed.slice(-window.panes.length)) {
      await markPaneService(paneId, pane.name);
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

  await scheduleServices(
    ordered,
    async (pane) => {
      const paneId = paneIds.get(pane.name)!;
      const env: NodeJS.ProcessEnv = { ...environment, ...pane.env };

      for (const key of TMUX_OWNED_KEYS) {
        delete env[key];
      }

      if (pane.ready && "exit" in pane.ready) {
        await keepPaneOnExit(paneId);
      }

      await respawnPane(paneId, {
        cwd: resolvePaneCwd(projectRoot, config, pane.cwd),
        env,
        cmd: pane.cmd,
      });

      return paneView(paneId);
    },
    new AbortController(),
  );
}

export async function launchTmuxWorkspace(
  projectRoot: string,
  config: SpinupConfig,
  action: TmuxAction,
  sessionName: string,
  environment: NodeJS.ProcessEnv,
  actionName = config.default,
): Promise<void> {
  await ensureTmuxInstalled();

  const owner = { project: await canonicalProject(projectRoot), action: actionName };

  const runningId = await findSessionId(sessionName);

  if (runningId) {
    const existing = await readSessionOwner(runningId);

    if (existing && existing.project === owner.project && existing.action === owner.action) {
      // Same project, same action: the user's running work is what they asked for.
      console.log(`[tmux] session "${sessionName}" is already running, attaching`);
      await attachSession(sessionName, runningId);
      return;
    }

    const who = existing
      ? `it belongs to ${existing.project} (action "${existing.action}")`
      : "it was not created by spinup";
    throw new Error(
      `tmux session "${sessionName}" already exists and ${who}.\n` +
        `Attach with: tmux attach -t =${sessionName}\n` +
        `Or end it with: tmux kill-session -t =${sessionName}`,
    );
  }

  console.log("[tmux] launching tmux workspace\n");
  console.log(`Session: ${sessionName}`);
  console.log(`Windows: ${action.windows.length}`);
  console.log(`Panes: ${countPanes(action)}`);

  const { sessionId, windowId, paneId } = await createSession(sessionName);

  try {
    await markSessionOwner(sessionId, owner);
    await isolateSessionEnvironment(sessionId, new Set(Object.keys(environment)));
    const placed = await buildWorkspace(sessionId, windowId, paneId, action);
    console.log("[deps] resolving dependencies");
    await startPanes(projectRoot, config, placed, environment);
  } catch (error) {
    if (error instanceof ReadinessFailure) {
      // The services are up and their output explains the failure; keep them to look at.
      error.message +=
        `\nThe tmux session "${sessionName}" is still running so you can inspect it: tmux attach -t =${sessionName}` +
        `\nEnd it with: tmux kill-session -t =${sessionName}`;
      throw error;
    }

    // Never leave a half-built workspace behind; remove only the session we made.
    await killSessionQuietly(sessionId);
    throw error;
  }

  await attachSession(sessionName, sessionId);
}
