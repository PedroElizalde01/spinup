import { afterEach, describe, expect, test } from "bun:test";

import { executeAction, TaskFailure } from "../src/core/executor.ts";
import type { SpinupConfig, Task } from "../src/types/config.ts";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => cleanupTempDir(dir)));
});

function simpleConfig(tasks: Task[]): SpinupConfig {
  return {
    name: "executor-test",
    root: ".",
    default: "dev",
    actions: { dev: { mode: "simple", tasks } },
  };
}

async function runTasks(tasks: Task[]): Promise<{ output: string; error?: unknown }> {
  const projectRoot = await makeTempDir("spinup-exec-");
  tempDirs.push(projectRoot);

  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalErrorWrite = process.stderr.write.bind(process.stderr);
  const capture = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  };

  process.stdout.write = capture as typeof process.stdout.write;
  process.stderr.write = capture as typeof process.stderr.write;

  let error: unknown;

  try {
    await executeAction(projectRoot, simpleConfig(tasks), "dev", { environment: process.env });
  } catch (caught) {
    error = caught;
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalErrorWrite;
  }

  return { output: chunks.join(""), error };
}

describe("simple-mode execution", () => {
  // Commands were prefixed with "exec", which replaced the shell at the first word.
  test("runs a compound command to completion", async () => {
    const { output, error } = await runTasks([
      { name: "compound", cwd: ".", cmd: "printf FIRST && printf SECOND" },
    ]);

    expect(error).toBeUndefined();
    expect(output).toContain("[compound] FIRSTSECOND");
  });

  test("honors an inline environment assignment", async () => {
    const { output, error } = await runTasks([
      { name: "inline", cwd: ".", cmd: "SPINUP_INLINE=ok printenv SPINUP_INLINE" },
    ]);

    expect(error).toBeUndefined();
    expect(output).toContain("[inline] ok");
  });

  test("runs a pipeline", async () => {
    const { output } = await runTasks([
      { name: "pipe", cwd: ".", cmd: "echo hello | tr a-z A-Z" },
    ]);

    expect(output).toContain("[pipe] HELLO");
  });

  test("routes task stderr to the prefixed stream", async () => {
    const { output } = await runTasks([
      { name: "noisy", cwd: ".", cmd: "echo to-stderr 1>&2" },
    ]);

    expect(output).toContain("[noisy] to-stderr");
  });

  // Promise.allSettled() waited for every task, so a failed startup hung until the
  // longest-lived sibling exited on its own.
  test("a failing task aborts its siblings instead of waiting for them", async () => {
    const started = Date.now();
    const { error } = await runTasks([
      { name: "doomed", cwd: ".", cmd: "exit 3" },
      { name: "longrunner", cwd: ".", cmd: "sleep 30" },
    ]);

    expect(error).toBeInstanceOf(TaskFailure);
    expect((error as TaskFailure).exitCode).toBe(3);
    expect((error as TaskFailure).message).toContain("doomed");
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 20_000);

  test("reports the originating exit code rather than a generic failure", async () => {
    const { error } = await runTasks([{ name: "code", cwd: ".", cmd: "exit 42" }]);

    expect((error as TaskFailure).exitCode).toBe(42);
  });

  test("streams more output than the previous 100MB buffer ceiling", async () => {
    const { output, error } = await runTasks([
      {
        name: "firehose",
        cwd: ".",
        // ~110MB, above execa's default maxBuffer, which used to abort the task.
        cmd: `yes padding-padding-padding-padding-padding | head -c 110000000; printf '\\nSTREAM_COMPLETE\\n'`,
      },
    ]);

    expect(error).toBeUndefined();
    expect(output).toContain("STREAM_COMPLETE");
  }, 240_000);
});

// Signals are delivered to a child process running the executor, so a test
// cannot take the runner down with it. Every task lives in its own process
// group, and each check proves the group's descendants are gone afterwards.
const FIXTURE = new URL("./fixtures/run-tasks.ts", import.meta.url).pathname;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDeath(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!pidAlive(pid)) {
      return true;
    }

    await Bun.sleep(50);
  }

  return !pidAlive(pid);
}

async function spawnFixture(tasks: Task[], signal?: NodeJS.Signals) {
  const { execa } = await import("execa");
  const projectRoot = await makeTempDir("spinup-signal-");
  tempDirs.push(projectRoot);

  const child = execa("bun", ["run", FIXTURE, JSON.stringify(tasks)], {
    cwd: projectRoot,
    reject: false,
    stdin: "ignore",
    env: { ...process.env, NO_COLOR: "1" },
  });

  // Tasks announce a descendant pid as PID:<n>; the signal goes out once it exists.
  const descendantPid = new Promise<number>((resolve, reject) => {
    let seen = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      seen += chunk.toString();
      const match = /PID:(\d+)/.exec(seen);
      if (match) {
        resolve(Number(match[1]));
      }
    });
    child.stdout?.on("end", () => reject(new Error(`no PID line in output:\n${seen}`)));
  });
  // Only awaited when a signal is requested; keep the other case from rejecting unhandled.
  descendantPid.catch(() => undefined);

  const started = Date.now();
  let pid: number | undefined;

  if (signal) {
    pid = await descendantPid;
    // Let the shell settle so the case "shell exited before descendant" is real.
    await Bun.sleep(300);
    child.kill(signal);
  }

  const result = await child;
  return { result, pid, elapsed: Date.now() - started };
}

describe("simple-mode lifecycle", () => {
  test("SIGTERM to spinup stops a single task's descendants and exits 143", async () => {
    const { result, pid } = await spawnFixture(
      [{ name: "svc", cwd: ".", cmd: "sh -c 'sleep 60 & echo PID:$!; wait'" }],
      "SIGTERM",
    );

    expect(result.exitCode).toBe(143);
    expect(await waitForDeath(pid!, 2000)).toBe(true);
  }, 20_000);

  test("SIGINT stops a descendant whose shell already exited and exits 130", async () => {
    const { result, pid } = await spawnFixture(
      [
        // The shell prints the pid and exits; only the group still refers to sleep.
        { name: "orphaner", cwd: ".", cmd: "sh -c '(sleep 60 & echo PID:$!)'" },
        { name: "keeper", cwd: ".", cmd: "sleep 60" },
      ],
      "SIGINT",
    );

    expect(result.exitCode).toBe(130);
    expect(await waitForDeath(pid!, 2000)).toBe(true);
  }, 20_000);

  test("kills a descendant that ignores SIGTERM once the grace period ends", async () => {
    const { result, pid, elapsed } = await spawnFixture(
      [{ name: "stubborn", cwd: ".", cmd: "sh -c 'trap \"\" TERM; echo PID:$$; sleep 60'" }],
      "SIGTERM",
    );

    expect(result.exitCode).toBe(143);
    expect(await waitForDeath(pid!, 2000)).toBe(true);
    // 3s grace plus a small allowance, not the 60s the task wanted.
    expect(elapsed).toBeLessThan(8000);
  }, 20_000);

  test("a task's exit status is the process exit status", async () => {
    const { result } = await spawnFixture([{ name: "code", cwd: ".", cmd: "exit 42" }]);

    expect(result.exitCode).toBe(42);
  }, 20_000);
});

describe("output forwarding", () => {
  // The prefixer ignored sink.write()'s return value, so a slow consumer let the
  // parent queue the task's entire output in memory.
  test("a slow sink applies backpressure to the source", async () => {
    const { PassThrough, Writable } = await import("node:stream");
    const { pipePrefixedOutput } = await import("../src/core/executor.ts");

    let buffered = 0;
    let maxBuffered = 0;
    let delivered = 0;
    const sink = new Writable({
      highWaterMark: 1024,
      write(chunk, _encoding, done) {
        buffered += chunk.length;
        maxBuffered = Math.max(maxBuffered, buffered);
        // Drain slowly, one chunk every few milliseconds.
        setTimeout(() => {
          buffered -= chunk.length;
          delivered += chunk.length;
          done();
        }, 2);
      },
    });

    const source = new PassThrough({ highWaterMark: 4096 });
    pipePrefixedOutput(source, "[slow] ", sink);

    // Push far more than the sink can absorb; a bounded pipe rejects writes.
    let rejected = 0;
    const line = `${"x".repeat(100)}\n`;

    for (let index = 0; index < 5000; index += 1) {
      if (!source.write(line)) {
        rejected += 1;
        await new Promise<void>((resolve) => source.once("drain", resolve));
      }
    }

    source.end();

    // The sink is the parent's stdout in real use and is never ended by the pipe,
    // so completion is "every prefixed byte arrived", not "finish".
    const expected = 5000 * ("[slow] ".length + line.length);
    const deadline = Date.now() + 30_000;

    while (delivered < expected && Date.now() < deadline) {
      await Bun.sleep(10);
    }

    expect(delivered).toBe(expected);

    expect(rejected).toBeGreaterThan(0);
    // The sink never held more than roughly its own high-water mark.
    expect(maxBuffered).toBeLessThan(64 * 1024);
  }, 60_000);
});
