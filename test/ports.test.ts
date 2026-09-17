import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { execa } from "execa";

import { parseComposeServices } from "../src/docker/compose.ts";
import { claimedPorts, findBusyPorts } from "../src/core/ports.ts";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";

const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(dirs.splice(0).map((dir) => cleanupTempDir(dir)));
});

async function listen(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return (server.address() as { port: number }).port;
}

describe("compose host ports", () => {
  test("reads published host ports and ignores container-only and ranged ones", () => {
    const [web] = parseComposeServices(
      [
        "services:",
        "  web:",
        "    image: nginx",
        "    ports:",
        '      - "8080:80"',
        '      - "127.0.0.1:8443:443/tcp"',
        '      - "3000"',
        '      - "9000-9005:9000-9005"',
        "      - published: 5432",
        "        target: 5432",
      ].join("\n"),
    );

    expect(web!.ports).toEqual([8080, 8443, 5432]);
  });
});

describe("port preflight", () => {
  test("reports a declared readiness port that something already listens on", async () => {
    const busy = await listen();
    const root = await makeTempDir("spinup-ports-");
    dirs.push(root);

    const claims = await claimedPorts(root, root, {
      mode: "simple",
      tasks: [{ name: "db", cwd: ".", cmd: "sleep 1", ready: { port: busy } }],
    });
    const found = await findBusyPorts(claims);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ port: busy, source: "db ready condition" });
  });

  test("a free port is not reported", async () => {
    const port = await listen();
    servers.pop()!.close();
    await Bun.sleep(50);

    expect(await findBusyPorts([{ port, source: "x" }])).toEqual([]);
  });

  test("--check fails with the port and its owner, and --dry-run warns", async () => {
    const busy = await listen();
    const root = await makeTempDir("spinup-ports-cli-");
    dirs.push(root);
    const project = path.join(root, "p");
    await mkdir(project, { recursive: true });
    await writeFile(
      path.join(project, ".spinup.yml"),
      ["name: ports", "root: .", "default: dev", "actions:", "  dev:", "    mode: simple", "    tasks:", `      - { name: db, cwd: ., cmd: sleep 1, ready: { port: ${busy} } }`, ""].join("\n"),
    );

    const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, "c"), SPINUP_SHIM_DIR: path.join(root, "b"), NO_COLOR: "1" };
    const cli = new URL("../src/cli.ts", import.meta.url).pathname;

    const check = await execa("bun", ["run", cli, "--check", "--json"], { cwd: project, env, reject: false });
    expect(check.exitCode).toBe(2);
    const report = JSON.parse(String(check.stdout)) as { busyPorts: Array<{ port: number; owner?: string }>; problems: string[] };
    expect(report.busyPorts.map((entry) => entry.port)).toEqual([busy]);
    expect(report.problems.join("\n")).toContain(`Port ${busy} (db ready condition) is already in use`);

    const dryRun = await execa("bun", ["run", cli, "--start", "--dry-run"], { cwd: project, env, reject: false });
    expect(dryRun.stdout).toContain(`[ports] Port ${busy}`);
  }, 30_000);
});
