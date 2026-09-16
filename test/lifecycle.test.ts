import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { execa } from "execa";

// The real CLI in a child process, a private registry and shim directory, and a
// private tmux server, so these cover routing, ownership and exit statuses end to end.
const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const tmuxAvailable = Bun.spawnSync(["tmux", "-V"]).success;

let root: string;
let project: string;
let env: NodeJS.ProcessEnv;

const CONFIG = [
  "version: 1",
  "name: lifecycle",
  "root: .",
  "default: dev",
  "actions:",
  "  dev:",
  "    mode: tmux",
  "    windows:",
  "      - name: services",
  "        panes:",
  "          - name: db",
  "            cwd: .",
  "            cmd: sleep 300",
  "          - name: api",
  "            cwd: .",
  "            cmd: sleep 300",
  "            dependsOn: [db]",
  "          - name: web",
  "            cwd: .",
  "            cmd: sleep 300",
  "            dependsOn: [api]",
  "  once:",
  "    mode: simple",
  "    tasks:",
  "      - name: hello",
  "        cwd: .",
  "        cmd: echo hi",
  "",
].join("\n");

beforeEach(async () => {
  // Short: the tmux socket path lives under this directory and is length-limited.
  root = await mkdtemp(path.join(tmpdir(), "sl-"));
  project = path.join(root, "p");
  await mkdir(path.join(root, "config"), { recursive: true });
  await mkdir(path.join(root, "bin"), { recursive: true });
  await mkdir(path.join(root, "t"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, ".spinup.yml"), CONFIG);

  env = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, "config"),
    SPINUP_SHIM_DIR: path.join(root, "bin"),
    TMUX_TMPDIR: path.join(root, "t"),
    TMUX: undefined,
    NO_COLOR: "1",
  };
});

afterEach(async () => {
  await execa("tmux", ["kill-server"], { env, reject: false });
  await rm(root, { recursive: true, force: true });
});

function spinup(args: string[], cwd = project) {
  return execa("bun", ["run", CLI, ...args], { cwd, env, reject: false, stdin: "ignore" });
}

function tmux(args: string[]) {
  return execa("tmux", args, { env, reject: false });
}

async function servicePids(): Promise<Record<string, string>> {
  const { stdout } = await tmux(["list-panes", "-s", "-t", "=lifecycle", "-F", "#{@spinup_service} #{pane_pid}"]);
  return Object.fromEntries(stdout.split("\n").filter(Boolean).map((row) => row.split(" ") as [string, string]));
}

describe.if(tmuxAvailable)("session lifecycle", () => {
  test("a local config runs without registering, then status, restart and stop act on its session", async () => {
    const start = await spinup(["--start"]);
    expect(`${start.exitCode} ${start.stderr}`).toBe("0 ");

    // Nothing was registered and no command was installed.
    expect(JSON.parse(String((await spinup(["--list", "--json"])).stdout))).toEqual([]);
    expect(await readdir(path.join(root, "bin"))).toEqual([]);

    const status = await spinup(["--status", "--json"]);
    expect(status.exitCode).toBe(0);
    const report = JSON.parse(String(status.stdout)) as { running: boolean; session: string; services: Array<{ name: string; state: string }> };
    expect(report.running).toBe(true);
    expect(report.session).toBe("lifecycle");
    expect(report.services.map((service) => [service.name, service.state])).toEqual([
      ["db", "running"],
      ["api", "running"],
      ["web", "running"],
    ]);

    const before = await servicePids();
    const restart = await spinup(["--restart", "api"]);
    expect(restart.exitCode).toBe(0);
    expect(restart.stdout).toContain("Restarted api.");
    expect(restart.stdout).toContain("may need a restart too: web");

    const after = await servicePids();
    expect(after.api).not.toBe(before.api);
    expect(after.db).toBe(before.db);
    expect(after.web).toBe(before.web);

    const stop = await spinup(["--stop"]);
    expect(stop.stdout).toContain("Stopped lifecycle (dev).");
    expect((await tmux(["has-session", "-t", "=lifecycle"])).exitCode).not.toBe(0);

    // Status reports not running with its own status; stopping again is not an error.
    expect((await spinup(["--status"])).exitCode).toBe(3);
    const again = await spinup(["--stop"]);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("was not running");
  }, 60_000);

  test("restarting the whole session replaces every service", async () => {
    await spinup(["--start"]);
    const before = await servicePids();

    const restart = await spinup(["--restart"]);
    expect(`${restart.exitCode} ${restart.stderr}`).toBe("0 ");

    const after = await servicePids();
    for (const service of ["db", "api", "web"]) {
      expect(after[service]).toBeDefined();
      expect(after[service]).not.toBe(before[service]);
    }
  }, 60_000);

  test("a registered project is reached by its alias from anywhere, and the directory uses the same session", async () => {
    expect((await spinup(["myproj"])).exitCode).toBe(0);
    expect((await spinup(["--start", "myproj"], root)).exitCode).toBe(0);

    expect(JSON.parse(String((await spinup(["myproj", "--status", "--json"], root)).stdout)).session).toBe("myproj");
    // From inside the directory, no alias still finds the registered session.
    expect(JSON.parse(String((await spinup(["--status", "--json"])).stdout)).session).toBe("myproj");
  }, 60_000);

  test("a session with the same name that spinup did not create is never touched", async () => {
    await tmux(["new-session", "-d", "-s", "lifecycle", "sleep 300"]);
    const { stdout: before } = await tmux(["list-panes", "-t", "=lifecycle", "-F", "#{pane_pid}"]);

    for (const command of [["--status"], ["--stop"], ["--restart"], ["--restart", "api"], ["--attach"]]) {
      const result = await spinup(command);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("spinup will not");
    }

    expect((await tmux(["list-panes", "-t", "=lifecycle", "-F", "#{pane_pid}"])).stdout).toBe(before);
  }, 60_000);

  test("a simple action has no session to manage", async () => {
    const result = await spinup(["--stop", "--action", "once"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("runs in the foreground");
  });

  test("without an alias or a config there is nothing to run and nothing is generated", async () => {
    const empty = path.join(root, "empty");
    await mkdir(empty);

    const result = await spinup(["--start"], empty);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("has no .spinup.yml");
    expect(await readdir(empty)).toEqual([]);
  });
});
