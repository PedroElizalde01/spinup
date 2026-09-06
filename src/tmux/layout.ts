import { execa } from "execa";

export type PaneSpawn = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  cmd: string;
};

async function runTmux(args: string[]): Promise<string> {
  const { stdout } = await execa("tmux", args);
  return stdout.trim();
}

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
  await runTmux([
    "respawn-pane",
    "-k",
    "-t",
    paneId,
    "-c",
    spawn.cwd,
    ...toEnvArgs(spawn.env),
    spawn.cmd,
  ]);
}
