import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Readable, Writable } from "node:stream";

import { execa, type ResultPromise } from "execa";

import { buildDependencyGraph } from "./dependencies.ts";
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

class TaskFailure extends Error {
  readonly exitCode: number;

  constructor(taskName: string, command: string, exitCode: number, cause?: unknown) {
    super(`[${taskName}] command failed (exit ${exitCode}): ${command}`, { cause });
    this.name = "TaskFailure";
    this.exitCode = exitCode;
  }
}

/**
 * Streams prefixed output without buffering the whole run. setEncoding keeps
 * multi-byte characters intact when one lands across a chunk boundary.
 */
function pipePrefixedOutput(stream: Readable | undefined, prefix: string, sink: Writable): void {
  if (!stream) {
    return;
  }

  let pending = "";
  stream.setEncoding("utf8");

  stream.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";

    for (const line of lines) {
      sink.write(`${prefix}${line}\n`);
    }

    // Never let an unterminated line grow without bound.
    if (pending.length > MAX_PENDING_LINE_LENGTH) {
      sink.write(`${prefix}${pending}\n`);
      pending = "";
    }
  });

  stream.on("end", () => {
    if (pending.length > 0) {
      sink.write(`${prefix}${pending}\n`);
    }
  });
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
  signalReceived: () => boolean;
  cleanup: () => void;
} {
  const abortController = new AbortController();
  let received = false;

  const abortOnSignal = (signal: ExitSignal) => {
    received = true;

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
 * Signals a detached child's entire process group. Killing only the immediate
 * child leaves the shell's descendants holding ports and file handles.
 */
function signalProcessGroup(subprocess: ResultPromise, signal: NodeJS.Signals): void {
  const { pid } = subprocess;

  if (pid === undefined) {
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    // Group is already gone, or we never owned one; fall back to the child itself.
    try {
      subprocess.kill(signal);
    } catch {
      // Nothing left to signal.
    }
  }
}

async function terminateAll(running: ResultPromise[], detached: boolean): Promise<void> {
  const alive = running.filter((subprocess) => subprocess.exitCode === null && !subprocess.killed);

  if (alive.length === 0) {
    return;
  }

  for (const subprocess of alive) {
    if (detached) {
      signalProcessGroup(subprocess, "SIGTERM");
      continue;
    }

    subprocess.kill("SIGTERM");
  }

  await Promise.race([
    Promise.allSettled(alive.map((subprocess) => subprocess.catch(() => undefined))),
    delay(TERMINATION_GRACE_MS),
  ]);

  for (const subprocess of alive) {
    if (subprocess.exitCode !== null) {
      continue;
    }

    if (detached) {
      signalProcessGroup(subprocess, "SIGKILL");
      continue;
    }

    subprocess.kill("SIGKILL");
  }
}

async function runSimpleAction(
  projectRoot: string,
  config: SpinupConfig,
  action: SimpleAction,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const tasks = buildDependencyGraph(action.tasks ?? []);
  const { abortController, signalReceived, cleanup } = createTerminationController();

  // A lone task stays in this process group so the terminal drives it directly:
  // Ctrl+C reaches its descendants, and it can read stdin. With several tasks
  // there is no single foreground process, so each gets its own group that we
  // terminate explicitly, and none of them may steal the terminal's input.
  const single = tasks.length === 1;
  const running: ResultPromise[] = [];
  let firstFailure: TaskFailure | undefined;

  const failFast = (failure: TaskFailure) => {
    firstFailure ??= failure;

    if (!abortController.signal.aborted) {
      abortController.abort(failure);
    }
  };

  // Aborting only stops *new* tasks. Without this, waiting on the already-running
  // ones would still block on the survivors of a failed startup.
  abortController.signal.addEventListener(
    "abort",
    () => {
      void terminateAll(running, !single);
    },
    { once: true },
  );

  console.log("[deps] resolving dependencies");

  try {
    for (const task of tasks) {
      if (abortController.signal.aborted) {
        break;
      }

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
        buffer: false,
        detached: !single,
        stdin: single ? "inherit" : "ignore",
        stdout: "pipe",
        stderr: "pipe",
        cleanup: true,
        forceKillAfterDelay: TERMINATION_GRACE_MS,
      });

      running.push(subprocess);
      pipePrefixedOutput(subprocess.stdout, prefix, process.stdout);
      pipePrefixedOutput(subprocess.stderr, prefix, process.stderr);

      void subprocess.catch((error: unknown) => {
        if (isCanceledError(error) || abortController.signal.aborted) {
          return;
        }

        failFast(new TaskFailure(task.name, task.cmd, getExitCode(error), error));
      });

      if (task.delay) {
        try {
          await delay(task.delay, undefined, { signal: abortController.signal });
        } catch {
          // Aborted while waiting; the loop guard stops the remaining tasks.
        }
      }
    }

    await Promise.allSettled(running.map((subprocess) => subprocess.catch(() => undefined)));

    if (firstFailure) {
      await terminateAll(running, !single);
      throw firstFailure;
    }

    if (signalReceived()) {
      await terminateAll(running, !single);
      process.exitCode = 130;
    }
  } finally {
    await terminateAll(running, !single);
    cleanup();
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
    await launchTmuxWorkspace(projectRoot, config, action, sessionName, options.environment ?? process.env);
    return;
  }

  await runSimpleAction(projectRoot, config, action, options.environment ?? process.env);
}

export { TaskFailure };
