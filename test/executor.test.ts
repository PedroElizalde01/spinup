import { afterEach, describe, expect, test } from "bun:test";

import { executeAction, TaskFailure } from "../src/core/executor.ts";
import type { RunitConfig, Task } from "../src/types/config.ts";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => cleanupTempDir(dir)));
});

function simpleConfig(tasks: Task[]): RunitConfig {
  return {
    name: "executor-test",
    root: ".",
    default: "dev",
    actions: { dev: { mode: "simple", tasks } },
  };
}

async function runTasks(tasks: Task[]): Promise<{ output: string; error?: unknown }> {
  const projectRoot = await makeTempDir("runit-exec-");
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
      { name: "inline", cwd: ".", cmd: "RUNIT_INLINE=ok printenv RUNIT_INLINE" },
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
