import { execa } from "execa";

const TMUX_NOT_INSTALLED_MESSAGE = 'tmux is not installed.\n\nPlease install tmux or change action mode to "simple".';

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

async function runTmux(args: string[]): Promise<void> {
  await execa("tmux", args);
}

export async function ensureTmuxInstalled(): Promise<void> {
  try {
    await runTmux(["-V"]);
  } catch (error) {
    if (isTmuxMissing(error)) {
      throw new Error(TMUX_NOT_INSTALLED_MESSAGE);
    }

    throw error;
  }
}

// tmux resolves -t by exact name, then name prefix, then pattern. Without the "="
// prefix, alias "api" matches a user's unrelated "api-staging" session -- which
// sessionExists/killSession would then destroy.
function exactTarget(sessionName: string): string {
  return `=${sessionName}`;
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

export async function createSession(sessionName: string): Promise<void> {
  await runTmux(["new-session", "-d", "-s", sessionName]);
}

export async function killSession(sessionName: string): Promise<void> {
  await runTmux(["kill-session", "-t", exactTarget(sessionName)]);
}

export async function attachSession(sessionName: string): Promise<void> {
  if (!process.stdout.isTTY) {
    console.log(`[tmux] session "${sessionName}" is ready`);
    console.log(`[tmux] attach manually with: tmux attach -t ${sessionName}`);
    return;
  }

  await execa("tmux", ["attach", "-t", exactTarget(sessionName)], { stdio: "inherit" });
}
