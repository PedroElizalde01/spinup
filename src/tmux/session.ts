import { execa } from "execa";

const TMUX_NOT_INSTALLED_MESSAGE = 'tmux is not installed.\n\nPlease install tmux or change action mode to "simple".';

// -e on window/pane creation, needed to pass environment without typing it into a
// shell, landed in tmux 3.0.
const MINIMUM_TMUX_VERSION = 3.0;

export type CreatedSession = {
  sessionId: string;
  windowId: string;
  paneId: string;
};

function isTmuxMissing(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      error.message.includes("command not found") ||
      error.message.includes("No such file or directory"))
  );
}

async function runTmux(args: string[]): Promise<string> {
  const { stdout } = await execa("tmux", args);
  return stdout.trim();
}

/**
 * tmux resolves -t by exact name, then prefix, then pattern. Without "=" an alias
 * of "api" also matches an unrelated "api-staging" session.
 */
export function exactTarget(sessionName: string): string {
  return `=${sessionName}`;
}

function parseTmuxVersion(raw: string): number {
  // "tmux 3.2a" -> 3.2, "tmux next-3.4" -> 3.4
  const match = /(\d+)\.(\d+)/.exec(raw);
  return match ? Number.parseFloat(`${match[1]}.${match[2]}`) : Number.NaN;
}

export async function ensureTmuxInstalled(): Promise<void> {
  let version: string;

  try {
    version = await runTmux(["-V"]);
  } catch (error) {
    if (isTmuxMissing(error)) {
      throw new Error(TMUX_NOT_INSTALLED_MESSAGE);
    }

    throw error;
  }

  const parsed = parseTmuxVersion(version);

  if (!Number.isNaN(parsed) && parsed < MINIMUM_TMUX_VERSION) {
    throw new Error(
      `runit needs tmux ${MINIMUM_TMUX_VERSION} or newer for its workspace mode, found "${version}".\n` +
        'Upgrade tmux or change the action mode to "simple".',
    );
  }
}

export async function sessionExists(sessionName: string): Promise<boolean> {
  try {
    await runTmux(["has-session", "-t", exactTarget(sessionName)]);
    return true;
  } catch (error) {
    if (isTmuxMissing(error)) {
      throw new Error(TMUX_NOT_INSTALLED_MESSAGE);
    }

    if ("exitCode" in (error as Record<string, unknown>) && (error as { exitCode?: number }).exitCode === 1) {
      return false;
    }

    throw error;
  }
}

/**
 * Creates the session and reports the ids tmux assigned. Targeting by id rather
 * than by "name:0.0" keeps runit correct under base-index/pane-base-index, which
 * many users set to 1.
 */
export async function createSession(sessionName: string): Promise<CreatedSession> {
  const output = await runTmux([
    "new-session",
    "-d",
    "-s",
    sessionName,
    "-P",
    "-F",
    "#{session_id} #{window_id} #{pane_id}",
  ]);

  const [sessionId, windowId, paneId] = output.split(" ");

  if (!sessionId || !windowId || !paneId) {
    throw new Error(`Could not read tmux session identifiers from "${output}".`);
  }

  return { sessionId, windowId, paneId };
}

export async function createWindow(sessionId: string, name: string): Promise<{ windowId: string; paneId: string }> {
  const output = await runTmux([
    "new-window",
    "-t",
    sessionId,
    "-n",
    name,
    "-P",
    "-F",
    "#{window_id} #{pane_id}",
  ]);

  const [windowId, paneId] = output.split(" ");

  if (!windowId || !paneId) {
    throw new Error(`Could not read tmux window identifiers from "${output}".`);
  }

  return { windowId, paneId };
}

export async function killSession(target: string): Promise<void> {
  await runTmux(["kill-session", "-t", target]);
}

export async function killSessionQuietly(target: string): Promise<void> {
  try {
    await killSession(target);
  } catch {
    // Nothing to clean up.
  }
}

export async function attachSession(sessionName: string, sessionId?: string): Promise<void> {
  const target = sessionId ?? exactTarget(sessionName);

  // Attaching from inside tmux fails with "sessions should be nested with care".
  // Switching the current client is what the user actually wants there.
  if (process.env.TMUX) {
    await execa("tmux", ["switch-client", "-t", target], { stdio: "inherit" });
    return;
  }

  if (!process.stdout.isTTY) {
    console.log(`[tmux] session "${sessionName}" is ready`);
    console.log(`[tmux] attach manually with: tmux attach -t ${sessionName}`);
    return;
  }

  await execa("tmux", ["attach", "-t", target], { stdio: "inherit" });
}
