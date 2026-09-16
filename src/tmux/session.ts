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

export type SessionOwner = {
  /** Canonical project root the session was created for. */
  project: string;
  action: string;
};

type RunTmuxOptions = {
  /** Values that must never appear in an error, such as environment values passed with -e. */
  redact?: string[];
};

/**
 * A tmux failure that reports what was attempted without echoing the argv. Execa's
 * own error carries the full command line, which for respawn-pane includes every
 * -e KEY=VALUE, and the CLI prints whatever message reaches it.
 */
export class TmuxError extends Error {
  readonly operation: string;
  readonly target: string | undefined;
  readonly exitCode: number | undefined;

  constructor(operation: string, target: string | undefined, exitCode: number | undefined, stderr: string) {
    const where = target ? ` for ${target}` : "";
    const status = exitCode === undefined ? "" : ` (exit ${exitCode})`;
    const detail = stderr ? `: ${stderr}` : "";
    super(`tmux ${operation} failed${where}${status}${detail}`);
    this.name = "TmuxError";
    this.operation = operation;
    this.target = target;
    this.exitCode = exitCode;
  }
}

function redactText(text: string, secrets: string[]): string {
  let result = text;

  for (const secret of secrets) {
    if (secret.length > 0) {
      result = result.split(secret).join("***");
    }
  }

  return result;
}

export async function runTmux(args: string[], options: RunTmuxOptions = {}): Promise<string> {
  try {
    const { stdout } = await execa("tmux", args);
    return stdout.trim();
  } catch (error) {
    if (isTmuxMissing(error)) {
      throw new Error(TMUX_NOT_INSTALLED_MESSAGE);
    }

    const failure = error as { exitCode?: number; stderr?: string };
    const targetIndex = args.indexOf("-t");
    const target = targetIndex >= 0 ? args[targetIndex + 1] : undefined;
    const stderr = redactText((failure.stderr ?? "").split("\n")[0]?.trim() ?? "", options.redact ?? []);

    // No `cause`: a serialized cause would carry the original argv back out.
    throw new TmuxError(args[0] ?? "command", target, failure.exitCode, stderr);
  }
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
      `spinup needs tmux ${MINIMUM_TMUX_VERSION} or newer for its workspace mode, found "${version}".\n` +
        'Upgrade tmux or change the action mode to "simple".',
    );
  }
}

export async function sessionExists(sessionName: string): Promise<boolean> {
  try {
    await runTmux(["has-session", "-t", exactTarget(sessionName)]);
    return true;
  } catch (error) {
    if (error instanceof TmuxError && error.exitCode === 1) {
      return false;
    }

    throw error;
  }
}

/**
 * Ownership lives in session-scoped user options, so it survives renames of the
 * project directory's contents and never touches global tmux settings.
 */
export async function markSessionOwner(sessionId: string, owner: SessionOwner): Promise<void> {
  await runTmux(["set-option", "-t", sessionId, "@spinup_project", owner.project]);
  await runTmux(["set-option", "-t", sessionId, "@spinup_action", owner.action]);
}

/**
 * The id of the session with exactly this name, or null. show-options takes a
 * target-pane, where "=name" is not understood, so ownership lookups go by id.
 */
export async function findSessionId(sessionName: string): Promise<string | null> {
  let listed: string;

  try {
    listed = await runTmux(["list-sessions", "-F", "#{session_id} #{session_name}"]);
  } catch (error) {
    // No server running is exit 1, the same as "no sessions".
    if (error instanceof TmuxError && error.exitCode === 1) {
      return null;
    }

    throw error;
  }

  for (const row of listed.split("\n")) {
    const separator = row.indexOf(" ");
    if (separator > 0 && row.slice(separator + 1) === sessionName) {
      return row.slice(0, separator);
    }
  }

  return null;
}

/** Null for a session spinup did not create. */
export async function readSessionOwner(sessionId: string): Promise<SessionOwner | null> {
  // -q keeps an unset user option from being reported as an error.
  const project = await runTmux(["show-options", "-t", sessionId, "-qv", "@spinup_project"]);
  const action = await runTmux(["show-options", "-t", sessionId, "-qv", "@spinup_action"]);

  if (!project || !action) {
    return null;
  }

  return { project, action };
}

/**
 * Creates the session and reports the ids tmux assigned. Targeting by id rather
 * than by "name:0.0" keeps spinup correct under base-index/pane-base-index, which
 * many users set to 1.
 */
export async function createSession(sessionName: string): Promise<CreatedSession> {
  // A detached session has no client to size it and defaults to 80x24, where a
  // few splits already fail with "no space for new pane". Use the launching
  // terminal's size, or a generous one; tmux resizes when a client attaches.
  const columns = String(process.stdout.columns || 200);
  const rows = String(process.stdout.rows || 50);
  const output = await runTmux([
    "new-session",
    "-d",
    "-s",
    sessionName,
    "-x",
    columns,
    "-y",
    rows,
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

/**
 * Makes the session's environment exactly the given one. A pane's environment is
 * the server's global environment plus the session's, plus -e overrides, so a
 * server started weeks ago still contributes keys nobody asked for. Every key
 * present at either level and absent from `wanted` is marked removed for this
 * session; -e on pane creation then supplies the rest. Global server state is
 * never modified. tmux's own per-pane variables are left to tmux.
 */
export async function isolateSessionEnvironment(sessionId: string, wanted: Set<string>): Promise<void> {
  const listed = await Promise.all([
    runTmux(["show-environment", "-g"]),
    runTmux(["show-environment", "-t", sessionId]),
  ]);
  const present = new Set<string>();

  for (const line of listed.flatMap((block) => block.split("\n"))) {
    // "KEY=value" for set variables, "-KEY" for ones already marked removed.
    if (line.startsWith("-") || line.length === 0) {
      continue;
    }

    present.add(line.slice(0, line.indexOf("=") === -1 ? line.length : line.indexOf("=")));
  }

  for (const key of present) {
    if (!wanted.has(key) && !TMUX_OWNED_KEYS.has(key)) {
      await runTmux(["set-environment", "-t", sessionId, "-r", key]);
    }
  }
}

/** Set by tmux itself for each pane; passing the caller's would be wrong. */
export const TMUX_OWNED_KEYS = new Set(["TMUX", "TMUX_PANE"]);

/** Only for a session this invocation created, identified by the id tmux returned. */
export async function killSessionQuietly(sessionId: string): Promise<void> {
  try {
    await runTmux(["kill-session", "-t", sessionId]);
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
