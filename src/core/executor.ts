import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Transform, type Readable, type Writable } from "node:stream";

import { execa } from "execa";

import { buildDependencyGraph } from "./dependencies.ts";
import { scheduleServices, type ServiceView } from "./readiness.ts";
import { launchTmuxWorkspace } from "../tmux/runner.ts";
import type { SpinupConfig, SimpleAction, Task } from "../types/config.ts";

type ExecuteActionOptions = {
  environment?: NodeJS.ProcessEnv;
  sessionName?: string;
};

type ExitSignal = "SIGINT" | "SIGTERM";

// Guards against a command that emits megabytes without ever writing a newline.
const MAX_PENDING_LINE_LENGTH = 64 * 1024;

// How long a process group gets to exit after SIGTERM before it is killed outright.
const TERMINATION_GRACE_MS = 3000;
// How long to wait for SIGKILL to take effect before giving up on a group.
const KILL_SETTLE_MS = 1000;
const LIVENESS_POLL_MS = 50;

class TaskFailure extends Error {
  readonly exitCode: number;

  constructor(taskName: string, command: string, exitCode: number, cause?: unknown) {
    super(`[${taskName}] command failed (exit ${exitCode}): ${command}`, { cause });
    this.name = "TaskFailure";
    this.exitCode = exitCode;
  }
}

/** The run was stopped by a signal to spinup itself, after its tasks were shut down. */
class Interrupted extends Error {
  readonly exitCode: number;
  readonly signal: ExitSignal;

  constructor(signal: ExitSignal) {
    super(`stopped by ${signal}`);
    this.name = "Interrupted";
    this.signal = signal;
    // Conventional status for a handled signal: 128 + signal number.
    this.exitCode = signal === "SIGINT" ? 130 : 143;
  }
}

/** The status the CLI should exit with for an error raised by a run. */
function exitCodeFor(error: unknown): number {
  if (error instanceof TaskFailure || error instanceof Interrupted) {
    return error.exitCode;
  }

  return 1;
}

/**
 * Prefixes each line. As a Transform in a pipe() chain it inherits stream
 * backpressure: when the sink stops accepting, the child's pipe fills and the
 * child blocks, instead of this process queueing its output without bound.
 * decodeStrings:false with an upstream setEncoding keeps multi-byte characters
 * intact across chunk boundaries.
 */
class LinePrefixer extends Transform {
  private pending = "";

  constructor(private readonly prefix: string) {
    super({ decodeStrings: false });
  }

  override _transform(chunk: string | Buffer, _encoding: BufferEncoding, done: () => void): void {
    this.pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop() ?? "";

    for (const line of lines) {
      // Readiness checks that wait for a log line listen here.
      this.emit("line", line);
      this.push(`${this.prefix}${line}\n`);
    }

    // Never let an unterminated line grow without bound.
    if (this.pending.length > MAX_PENDING_LINE_LENGTH) {
      this.push(`${this.prefix}${this.pending}\n`);
      this.pending = "";
    }

    done();
  }

  override _flush(done: () => void): void {
    if (this.pending.length > 0) {
      this.push(`${this.prefix}${this.pending}\n`);
    }

    done();
  }
}

/** Exported for the backpressure regression; the executor is its only caller. */
export function pipePrefixedOutput(stream: Readable | undefined, prefix: string, sink: Writable): LinePrefixer | undefined {
  if (!stream) {
    return undefined;
  }

  stream.setEncoding("utf8");
  const prefixer = new LinePrefixer(prefix);
  // end:false, the sink is the parent's stdout/stderr and outlives every task.
  stream.pipe(prefixer).pipe(sink, { end: false });
  return prefixer;
}

function resolveTaskCwd(projectRoot: string, config: SpinupConfig, task: Task): string {
  const actionRoot = path.resolve(projectRoot, config.root);
  return path.resolve(actionRoot, task.cwd);
}

function isCanceledError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "isCanceled" in error &&
    (error as { isCanceled?: boolean }).isCanceled,
  );
}

function getExitCode(error: unknown): number {
  if (error && typeof error === "object" && "exitCode" in error) {
    const exitCode = (error as { exitCode?: unknown }).exitCode;

    if (typeof exitCode === "number") {
      return exitCode;
    }
  }

  return 1;
}

function createTerminationController(): {
  abortController: AbortController;
  signalReceived: () => ExitSignal | undefined;
  cleanup: () => void;
} {
  const abortController = new AbortController();
  let received: ExitSignal | undefined;

  const abortOnSignal = (signal: ExitSignal) => {
    received ??= signal;

    if (!abortController.signal.aborted) {
      abortController.abort(new Error(`Received ${signal}`));
    }
  };

  const handleSigint = () => abortOnSignal("SIGINT");
  const handleSigterm = () => abortOnSignal("SIGTERM");

  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);

  return {
    abortController,
    signalReceived: () => received,
    cleanup: () => {
      process.off("SIGINT", handleSigint);
      process.off("SIGTERM", handleSigterm);
    },
  };
}

/**
 * Every task is started detached, so its pid is also a process group id that
 * covers the shell and everything the shell spawned. The group outlives the
 * shell: "npm run dev" style wrappers can exit while their child keeps a port.
 */
type OwnedGroup = {
  name: string;
  pgid: number;
};

/** Signal 0 probes without delivering: true while any member of the group exists. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // Already gone.
  }
}

async function waitForGroups(groups: OwnedGroup[], timeoutMs: number): Promise<OwnedGroup[]> {
  const deadline = Date.now() + timeoutMs;
  let survivors = groups.filter((group) => groupAlive(group.pgid));

  while (survivors.length > 0 && Date.now() < deadline) {
    await delay(LIVENESS_POLL_MS);
    survivors = survivors.filter((group) => groupAlive(group.pgid));
  }

  return survivors;
}

/**
 * Terminates only the groups this run created: SIGTERM, a bounded grace period,
 * then SIGKILL for whatever ignored it. Never signals spinup's own group.
 */
async function terminateGroups(groups: OwnedGroup[]): Promise<void> {
  const alive = groups.filter((group) => groupAlive(group.pgid));

  if (alive.length === 0) {
    return;
  }

  for (const group of alive) {
    signalGroup(group.pgid, "SIGTERM");
  }

  const stubborn = await waitForGroups(alive, TERMINATION_GRACE_MS);

  for (const group of stubborn) {
    console.error(`[${group.name}] did not stop after ${TERMINATION_GRACE_MS}ms, killing`);
    signalGroup(group.pgid, "SIGKILL");
  }

  await waitForGroups(stubborn, KILL_SETTLE_MS);
}

async function runSimpleAction(
  projectRoot: string,
  config: SpinupConfig,
  action: SimpleAction,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const tasks = buildDependencyGraph(action.tasks ?? []);
  const { abortController, signalReceived, cleanup } = createTerminationController();

  // A lone task may read the terminal; with several there is no single
  // foreground process, so none of them gets stdin.
  const single = tasks.length === 1;
  const groups: OwnedGroup[] = [];
  const waits: Promise<unknown>[] = [];
  let firstFailure: Error | undefined;

  // One owner for shutdown: whoever asks first starts it, everyone awaits the same run.
  let shutdown: Promise<void> | undefined;
  const stopEverything = (): Promise<void> => (shutdown ??= terminateGroups(groups));

  const failFast = (failure: Error) => {
    firstFailure ??= failure;

    if (!abortController.signal.aborted) {
      abortController.abort(failure);
    }
  };

  // Aborting only stops *new* tasks. Without this, waiting on the already-running
  // ones would still block on the survivors of a failed startup.
  abortController.signal.addEventListener("abort", () => void stopEverything(), { once: true });

  const startTask = async (task: Task): Promise<ServiceView> => {
    const prefix = `[${task.name}] `;
    const cwd = resolveTaskCwd(projectRoot, config, task);
    console.log(`${prefix}starting ${task.cmd}`);

    // The command is a shell program, not an argv list. Prefixing it with "exec"
    // replaced the shell at the first word, so "a && b" ran only "a" and inline
    // assignments such as "FOO=bar cmd" were treated as a program name.
    const subprocess = execa(task.cmd, {
      cwd,
      env: {
        ...environment,
        ...task.env,
      },
      shell: true,
      // The environment given here is the whole environment; nothing is merged in.
      extendEnv: false,
      buffer: false,
      // Own process group, so shutdown reaches the shell's descendants too.
      detached: true,
      stdin: single ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      cleanup: true,
      forceKillAfterDelay: TERMINATION_GRACE_MS,
    });

    if (subprocess.pid !== undefined) {
      groups.push({ name: task.name, pgid: subprocess.pid });
    }

    if (single && subprocess.stdin) {
      // pipe() applies backpressure; a detached child cannot inherit the terminal.
      process.stdin.pipe(subprocess.stdin);
      waits.push(subprocess.finally(() => process.stdin.unpipe(subprocess.stdin!)).catch(() => undefined));
    }

    const outputs = [
      pipePrefixedOutput(subprocess.stdout, prefix, process.stdout),
      pipePrefixedOutput(subprocess.stderr, prefix, process.stderr),
    ];

    // Attached before any output can arrive, so a readiness line is never missed.
    const pattern = task.ready && "log" in task.ready ? new RegExp(task.ready.log) : undefined;
    let matched = false;

    if (pattern) {
      for (const output of outputs) {
        output?.on("line", (line: string) => {
          matched ||= pattern.test(line);
        });
      }
    }

    let status: number | undefined;

    waits.push(
      subprocess.then(
        (result) => {
          status = result.exitCode ?? 0;
        },
        (error: unknown) => {
          status = getExitCode(error);

          if (isCanceledError(error) || abortController.signal.aborted) {
            return;
          }

          failFast(new TaskFailure(task.name, task.cmd, status, error));
        },
      ),
    );

    return {
      exitStatus: async () => status,
      outputMatches: async () => matched,
    };
  };

  console.log("[deps] resolving dependencies");

  try {
    try {
      await scheduleServices(tasks, startTask, abortController);
    } catch (error) {
      // A readiness failure is a run failure; an abort caused by a signal is not.
      if (!signalReceived()) {
        failFast(error instanceof Error ? error : new Error(String(error)));
      }
    }

    await Promise.allSettled(waits);

    // The shells have exited; anything still alive in their groups is ours to stop.
    await stopEverything();

    if (firstFailure) {
      throw firstFailure;
    }

    const signal = signalReceived();

    if (signal) {
      throw new Interrupted(signal);
    }
  } finally {
    await stopEverything();
    cleanup();

    if (single) {
      // Let the process exit: a piped stdin keeps reading otherwise.
      process.stdin.pause();
    }
  }
}

export async function executeAction(
  projectRoot: string,
  config: SpinupConfig,
  actionName = config.default,
  options: ExecuteActionOptions = {},
): Promise<void> {
  const action = config.actions[actionName];

  if (!action) {
    throw new Error(`Action "${actionName}" is not defined.`);
  }

  if (action.mode === "tmux") {
    const sessionName = options.sessionName ?? config.name;
    await launchTmuxWorkspace(projectRoot, config, action, sessionName, options.environment ?? process.env, actionName);
    return;
  }

  await runSimpleAction(projectRoot, config, action, options.environment ?? process.env);
}

export { exitCodeFor, Interrupted, TaskFailure };
