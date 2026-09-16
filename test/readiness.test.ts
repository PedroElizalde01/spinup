import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";

import { parseConfig, formatConfigError } from "../src/core/config.ts";
import { executeAction } from "../src/core/executor.ts";
import { ReadinessFailure, scheduleServices, waitUntilReady, type ServiceView } from "../src/core/readiness.ts";
import type { SpinupConfig, Task } from "../src/types/config.ts";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";

const tempDirs: string[] = [];
const servers: Array<{ close(): void }> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(tempDirs.splice(0).map((dir) => cleanupTempDir(dir)));
});

function view(overrides: Partial<{ status: number; matches: boolean }> = {}): ServiceView {
  return {
    exitStatus: async () => overrides.status,
    outputMatches: async () => overrides.matches ?? false,
  };
}

async function freePort(): Promise<number> {
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("conditions", () => {
  test("port holds once something listens", async () => {
    const port = await freePort();
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    servers.push(server);

    await waitUntilReady("db", { port }, view(), new AbortController().signal);
  });

  test("http holds for any answer below 500, including 404", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 404 }) });
    servers.push({ close: () => server.stop(true) });

    await waitUntilReady("api", { http: `http://127.0.0.1:${server.port}/health` }, view(), new AbortController().signal);
  });

  test("log holds once output matched", async () => {
    await waitUntilReady("web", { log: "ready" }, view({ matches: true }), new AbortController().signal);
  });

  test("exit 0 holds on success and fails on any other status", async () => {
    await waitUntilReady("migrate", { exit: 0 }, view({ status: 0 }), new AbortController().signal);
    await expect(waitUntilReady("migrate", { exit: 0 }, view({ status: 3 }), new AbortController().signal)).rejects.toThrow(
      "[migrate] exit 0 failed: exited with status 3",
    );
  });

  test("a service that exits before its condition holds fails immediately", async () => {
    const started = Date.now();
    await expect(
      waitUntilReady("api", { port: await freePort(), timeout: 60_000 }, view({ status: 1 }), new AbortController().signal),
    ).rejects.toThrow("exited with status 1 first");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("a condition that never holds fails after its timeout, naming it", async () => {
    const port = await freePort();
    await expect(waitUntilReady("db", { port, timeout: 600 }, view(), new AbortController().signal)).rejects.toThrow(
      `[db] port localhost:${port} did not hold within 600ms`,
    );
  });
});

describe("scheduling", () => {
  test("a dependent starts only after its dependency is ready; unrelated services do not wait", async () => {
    const events: string[] = [];
    let dbReady = false;
    const items = [
      { name: "db", ready: { log: "ready", timeout: 5000 } },
      { name: "api", dependsOn: ["db"] },
      { name: "worker" },
    ];

    await scheduleServices(
      items,
      async (item) => {
        events.push(`start ${item.name}`);

        if (item.name === "db") {
          setTimeout(() => {
            dbReady = true;
            events.push("db ready");
          }, 600);
        }

        return { exitStatus: async () => undefined, outputMatches: async () => item.name === "db" && dbReady };
      },
      new AbortController(),
    );

    expect(events.indexOf("start worker")).toBeLessThan(events.indexOf("db ready"));
    expect(events.indexOf("db ready")).toBeLessThan(events.indexOf("start api"));
  });

  test("a readiness failure aborts waiting services and surfaces as the failure", async () => {
    const started: string[] = [];
    const controller = new AbortController();

    const failure = await scheduleServices(
      [
        { name: "migrate", ready: { exit: 0 as const } },
        { name: "app", dependsOn: ["migrate"] },
        { name: "slow", ready: { log: "never", timeout: 60_000 } },
      ],
      async (item) => {
        started.push(item.name);
        return { exitStatus: async () => (item.name === "migrate" ? 2 : undefined), outputMatches: async () => false };
      },
      controller,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ReadinessFailure);
    expect((failure as Error).message).toContain("[migrate]");
    expect(started).not.toContain("app");
    expect(controller.signal.aborted).toBe(true);
  }, 10_000);
});

describe("config", () => {
  const base = (ready: string) =>
    ["name: r", "root: .", "default: dev", "actions:", "  dev:", "    mode: simple", "    tasks:", "      - name: db", "        cwd: .", '        cmd: "true"', `        ready: ${ready}`].join("\n");

  test.each([["{ port: 5432 }"], ["{ http: 'http://localhost:3000/health', timeout: 5000 }"], ["{ log: 'listening on' }"], ["{ exit: 0 }"]])(
    "accepts %s",
    (ready) => {
      expect(() => parseConfig(base(ready))).not.toThrow();
    },
  );

  test.each([
    ["{ port: 70000 }", "port"],
    ["{ log: '(' }", "not a valid regular expression"],
    ["{ exit: 1 }", "ready"],
    ["{ port: 5432, log: 'x' }", "ready"],
  ])("rejects %s", (ready, message) => {
    try {
      parseConfig(base(ready));
      throw new Error("expected a validation failure");
    } catch (error) {
      expect(formatConfigError(error)).toContain(message);
    }
  });
});

describe("simple mode end to end", () => {
  async function run(tasks: Task[]) {
    const projectRoot = await makeTempDir("spinup-ready-");
    tempDirs.push(projectRoot);
    const config: SpinupConfig = { name: "r", root: ".", default: "dev", actions: { dev: { mode: "simple", tasks } } };
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    const writeError = process.stderr.write.bind(process.stderr);
    const capture = (chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    };
    process.stdout.write = capture as typeof process.stdout.write;
    process.stderr.write = capture as typeof process.stderr.write;

    try {
      const error = await executeAction(projectRoot, config, "dev", { environment: process.env }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      return { output: chunks.join(""), error };
    } finally {
      process.stdout.write = write;
      process.stderr.write = writeError;
    }
  }

  test("a migration must finish before the app starts, and the app sees its result", async () => {
    const { output, error } = await run([
      { name: "migrate", cwd: ".", cmd: "sleep 0.5; touch migrated", ready: { exit: 0 } },
      { name: "app", cwd: ".", cmd: "test -f migrated && echo SAW_MIGRATION", dependsOn: ["migrate"] },
    ]);

    expect(error).toBeUndefined();
    expect(output).toContain("[app] SAW_MIGRATION");
  }, 20_000);

  test("a log condition gates the dependent", async () => {
    const { output, error } = await run([
      { name: "db", cwd: ".", cmd: "sleep 0.5; echo 'database system is ready'; sleep 2", ready: { log: "system is ready" } },
      { name: "api", cwd: ".", cmd: "echo API_UP", dependsOn: ["db"] },
    ]);

    expect(error).toBeUndefined();
    // Task output is captured; the executor's own console.log lines are not.
    expect(output.indexOf("[api] API_UP")).toBeGreaterThan(output.indexOf("[db] database system is ready"));
    expect(output.indexOf("[db] database system is ready")).toBeGreaterThan(-1);
  }, 20_000);

  test("a failed migration stops the run, names the condition, and never starts the app", async () => {
    const { output, error } = await run([
      { name: "migrate", cwd: ".", cmd: "exit 4", ready: { exit: 0 } },
      { name: "app", cwd: ".", cmd: "echo SHOULD_NOT_RUN", dependsOn: ["migrate"] },
    ]);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("migrate");
    expect(output).not.toContain("SHOULD_NOT_RUN");
  }, 20_000);

  test("a port that never opens fails after the timeout and stops the other services", async () => {
    const started = Date.now();
    const { error } = await run([
      { name: "db", cwd: ".", cmd: "sleep 30", ready: { port: await freePort(), timeout: 800 } },
      { name: "api", cwd: ".", cmd: "echo nope", dependsOn: ["db"] },
    ]);

    expect(error).toBeInstanceOf(ReadinessFailure);
    expect((error as Error).message).toContain("did not hold within 800ms");
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);
});
