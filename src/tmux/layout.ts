import type { ServiceView } from "../core/readiness.ts";
import { runTmux } from "./session.ts";

export type PaneSpawn = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  cmd: string;
};

/**
 * tmux takes environment as repeated -e KEY=VALUE arguments and hands them to the
 * spawned process directly. Nothing is written to a shell line, so values never
 * reach the pane's scrollback.
 */
function toEnvArgs(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env).flatMap(([key, value]) =>
    value === undefined ? [] : ["-e", `${key}=${value}`],
  );
}

/**
 * What readiness checks see of a pane: whether it has exited and with what status,
 * and its recent output. A pane that no longer exists counts as exited (-1).
 */
export function paneView(paneId: string): ServiceView {
  return {
    async exitStatus() {
      try {
        const [dead, status] = (await runTmux(["display-message", "-p", "-t", paneId, "#{pane_dead} #{pane_dead_status}"])).split(" ");
        return dead === "1" ? Number(status || -1) : undefined;
      } catch {
        return -1;
      }
    },
    async outputMatches(pattern) {
      // -J joins wrapped lines so a long line matches as the program wrote it.
      const text = await runTmux(["capture-pane", "-p", "-J", "-t", paneId, "-S", "-2000"]).catch(() => "");
      return text.split("\n").some((line) => pattern.test(line));
    },
  };
}

/** Keeps a pane that exits on screen with its status, so an `exit` condition can read it. */
export async function keepPaneOnExit(paneId: string): Promise<void> {
  await runTmux(["set-option", "-p", "-t", paneId, "remain-on-exit", "on"]);
}

export async function renameWindow(windowId: string, name: string): Promise<void> {
  await runTmux(["rename-window", "-t", windowId, name]);
}

/**
 * Adds a pane and immediately reapplies the layout. Splitting repeatedly before
 * laying out exhausts the window: eight services in an 80x24 window produced
 * "no space for new pane" after the fourth.
 */
export async function addPane(windowId: string, layout?: string): Promise<string> {
  const paneId = await runTmux(["split-window", "-t", windowId, "-P", "-F", "#{pane_id}"]);

  if (layout) {
    await applyWindowLayout(windowId, layout);
  }

  return paneId;
}

export async function applyWindowLayout(windowId: string, layout?: string): Promise<void> {
  if (!layout) {
    return;
  }

  await runTmux(["select-layout", "-t", windowId, layout]);
}

/**
 * Replaces whatever a pane is running with the configured command, in the right
 * directory and environment. -k kills the placeholder shell first.
 */
export async function respawnPane(paneId: string, spawn: PaneSpawn): Promise<void> {
  const values = Object.values(spawn.env).filter((value): value is string => typeof value === "string");

  await runTmux(
    ["respawn-pane", "-k", "-t", paneId, "-c", spawn.cwd, ...toEnvArgs(spawn.env), spawn.cmd],
    { redact: values },
  );
}
