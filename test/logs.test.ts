import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { executeAction } from "../src/core/executor.ts";
import { CappedLog, LOG_LIMIT_BYTES, logDirectory, logPath, prepareLogFile } from "../src/core/logs.ts";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";

let root: string;
const savedState = process.env.XDG_STATE_HOME;

beforeEach(async () => {
  root = await makeTempDir("spinup-logs-");
  process.env.XDG_STATE_HOME = path.join(root, "state");
});

afterEach(async () => {
  process.env.XDG_STATE_HOME = savedState;
  if (savedState === undefined) delete process.env.XDG_STATE_HOME;
  await cleanupTempDir(root);
});

describe("service logs", () => {
  test("keep the previous run as .log.1 and are private", async () => {
    const first = await prepareLogFile("app", "api");
    await writeFile(first, "run one\n");
    const second = await prepareLogFile("app", "api");

    expect(second).toBe(logPath("app", "api"));
    expect(await readFile(`${second}.1`, "utf8")).toBe("run one\n");
    expect(await readFile(second, "utf8")).toBe("");
    expect((await stat(second)).mode & 0o777).toBe(0o600);
    expect((await stat(logDirectory("app"))).mode & 0o777).toBe(0o700);
  });

  test("stop at the size limit and say so once", async () => {
    const file = await prepareLogFile("app", "noisy");
    const log = new CappedLog(file);
    const line = `${"x".repeat(1023)}\n`;

    for (let index = 0; index < LOG_LIMIT_BYTES / 1024 + 50; index += 1) {
      log.write(line);
    }

    await log.close();
    const contents = await readFile(file, "utf8");
    expect(contents.length).toBeLessThan(LOG_LIMIT_BYTES + 200);
    expect(contents.match(/log reached/g)).toHaveLength(1);
  });

  test("simple mode writes each task's own output, unprefixed", async () => {
    const project = await makeTempDir("spinup-logs-project-");

    try {
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = (() => true) as typeof process.stdout.write;

      try {
        await executeAction(
          project,
          { name: "l", root: ".", default: "dev", actions: { dev: { mode: "simple", tasks: [{ name: "api", cwd: ".", cmd: "echo first; echo second" }] } } },
          "dev",
          { environment: process.env, logAlias: "logged" },
        );
      } finally {
        process.stdout.write = write;
      }

      expect(await readFile(logPath("logged", "api"), "utf8")).toBe("first\nsecond\n");
    } finally {
      await cleanupTempDir(project);
    }
  });
});
