import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { execa } from "execa";

import { wrapText } from "../src/commands/run.ts";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";

// Drives the real CLI in a child process against an isolated registry, shim
// directory and project, so these assertions cover routing, exit statuses and
// the JSON contract end to end.
const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

let root: string;
let project: string;
let env: NodeJS.ProcessEnv;

const CONFIG = [
  "version: 1",
  "name: clitest",
  "root: .",
  "default: dev",
  "actions:",
  "  dev:",
  "    mode: simple",
  "    tasks:",
  "      - name: app",
  "        cwd: .",
  "        cmd: touch started.txt",
  "  migrate:",
  "    mode: simple",
  "    tasks:",
  "      - name: db",
  "        cwd: .",
  "        cmd: \"true\"",
  "      - name: schema",
  "        cwd: .",
  "        cmd: \"true\"",
  "        dependsOn: [db]",
  "  broken:",
  "    mode: simple",
  "    tasks:",
  "      - name: nowhere",
  "        cwd: does-not-exist",
  "        cmd: \"true\"",
  "  failing:",
  "    mode: simple",
  "    tasks:",
  "      - name: code",
  "        cwd: .",
  "        cmd: exit 42",
  "",
].join("\n");

beforeEach(async () => {
  root = await makeTempDir("spinup-cli-");
  project = path.join(root, "project");
  await mkdir(path.join(root, "config"), { recursive: true });
  await mkdir(path.join(root, "bin"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, ".spinup.yml"), CONFIG);
  // A child process reports its cwd as the real path; on macOS /var is /private/var.
  project = await realpath(project);

  env = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, "config"),
    SPINUP_SHIM_DIR: path.join(root, "bin"),
    NO_COLOR: "1",
  };
});

afterEach(async () => {
  await cleanupTempDir(root);
});

async function spinup(args: string[], cwd = project) {
  return execa("bun", ["run", CLI, ...args], { cwd, env, reject: false, stdin: "ignore" });
}

async function register(): Promise<void> {
  const result = await spinup(["clitest"]);
  if (result.exitCode !== 0) {
    throw new Error(`registration failed (exit ${result.exitCode}):\n${result.stdout}\n${result.stderr}`);
  }
}

describe("cli routing and contract", () => {
  test("registers, then lists the project with its default action", async () => {
    await register();

    const list = await spinup(["--list", "--json"]);
    expect(list.exitCode).toBe(0);
    const rows = JSON.parse(String(list.stdout)) as unknown[];
    expect(rows).toEqual([{ alias: "clitest", root: project, config: "ok", defaultAction: "dev", mode: "simple", actions: ["dev", "migrate", "broken", "failing"] }]);
  });

  test("--action selects a generated action for inspection", async () => {
    await register();

    const plan = await spinup(["clitest", "--plan", "--action", "migrate", "--json"]);
    expect(plan.exitCode).toBe(0);
    const report = JSON.parse(String(plan.stdout)) as { action: string; order: Array<{ name: string; cwd: string }> };
    expect(report.action).toBe("migrate");
    expect(report.order.map((step) => step.name)).toEqual(["db", "schema"]);
    expect(report.order[0]!.cwd).toBe(project);

    const graph = await spinup(["clitest", "--graph", "--action", "migrate"]);
    expect(graph.stdout).toContain("schema depends on db");
  });

  test("an unknown action fails before anything happens and names the alternatives", async () => {
    await register();

    const result = await spinup(["clitest", "--plan", "--action", "nope"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Action "nope" is not defined');
    expect(result.stderr).toContain("dev, migrate, broken, failing");
  });

  test("a management flag wins over the shim's --start", async () => {
    await register();

    // This is what `clitest --doctor` becomes through the generated wrapper.
    const result = await spinup(["--start", "clitest", "--doctor", "--json"], root);
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(String(result.stdout)) as { action: string; actions: string[]; ready: boolean };
    expect(report.action).toBe("dev");
    expect(report.actions).toContain("migrate");
    expect(report.ready).toBe(true);
    await expect(Bun.file(path.join(project, "started.txt")).exists()).resolves.toBe(false);
  });

  test("--start never registers the current directory", async () => {
    const result = await spinup(["--start", "orphan"], root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not registered");

    const list = await spinup(["--list", "--json"]);
    expect(JSON.parse(String(list.stdout))).toEqual([]);
  });

  test("--dry-run resolves the launch and starts nothing", async () => {
    await register();

    const result = await spinup(["--start", "clitest", "--dry-run"], root);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Action: dev (simple)");
    expect(result.stdout).toContain("touch started.txt");
    expect(result.stdout).toContain("nothing was started");
    await expect(Bun.file(path.join(project, "started.txt")).exists()).resolves.toBe(false);
  });

  test("a launch runs the selected action from any directory and passes its status through", async () => {
    await register();

    const ok = await spinup(["--start", "clitest"], root);
    expect(ok.exitCode).toBe(0);
    await expect(Bun.file(path.join(project, "started.txt")).exists()).resolves.toBe(true);

    const failing = await spinup(["--start", "clitest", "--action", "failing"], root);
    expect(failing.exitCode).toBe(42);
  });

  test("diagnostics exit 2 when the action cannot run", async () => {
    await register();

    const check = await spinup(["clitest", "--check", "--action", "broken", "--json"]);
    expect(check.exitCode).toBe(2);
    const report = JSON.parse(String(check.stdout)) as { ready: boolean; problems: string[] };
    expect(report.ready).toBe(false);
    expect(report.problems.join("\n")).toContain("does-not-exist");

    const doctor = await spinup(["clitest", "--doctor", "--action", "broken"]);
    expect(doctor.exitCode).toBe(2);
    expect(doctor.stdout).toContain("not ready");
  });

  test("--json is refused where there is no report", async () => {
    await register();
    const result = await spinup(["clitest", "--edit", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--json applies to");
  });

  test("env inspection never prints values", async () => {
    await register();
    await writeFile(path.join(project, ".env"), "SECRET_TOKEN=hunter2\n");

    const result = await spinup(["clitest", "--env", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("hunter2");
    const report = JSON.parse(String(result.stdout)) as { keys: unknown[] };
    expect(report.keys).toEqual([{ key: "SECRET_TOKEN", origin: ".env", shadowedByShell: false }]);
  });
});

describe("setup card", () => {
  test("a long value without separators wraps inside the card", () => {
    const lines = wrapText("/very/long/path/".repeat(8), 47);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.length <= 47)).toBe(true);
    expect(lines.join("")).toBe("/very/long/path/".repeat(8));
  });
});

describe("--path, --relink and --yes", () => {
  async function listRoots(): Promise<Record<string, string>> {
    const rows = JSON.parse(String((await spinup(["--list", "--json"], root)).stdout)) as Array<{ alias: string; root: string }>;
    return Object.fromEntries(rows.map((row) => [row.alias, row.root]));
  }

  test("registers a directory given with --path from anywhere", async () => {
    const result = await spinup(["clitest", "--path", project], root);
    expect(result.exitCode).toBe(0);
    expect((await listRoots()).clitest).toBe(project);
  });

  test("a --path that disagrees with the registration points at --relink", async () => {
    await register();
    const other = path.join(root, "other");
    await mkdir(other);

    const result = await spinup(["clitest", "--path", other], root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`spinup clitest --relink --path ${other}`);
  });

  test("relinking asks for consent: without a terminal it needs --yes and changes nothing", async () => {
    await register();
    const moved = path.join(root, "moved");
    await mkdir(moved);
    await writeFile(path.join(moved, ".spinup.yml"), CONFIG);

    const refused = await spinup(["clitest", "--relink"], moved);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("pass --yes");
    expect((await listRoots()).clitest).toBe(project);

    const relinked = await spinup(["clitest", "--relink", "--yes"], moved);
    expect(`${relinked.exitCode} ${relinked.stderr}`).toBe("0 ");
    expect((await listRoots()).clitest).toBe(await realpath(moved));
    // The command names only the alias, so it keeps working.
    expect(await Bun.file(path.join(root, "bin", "clitest")).exists()).toBe(true);

    expect((await spinup(["clitest", "--relink", "--yes"], moved)).stdout).toContain("already points at");
  });

  test("relinking to a directory without a config generates one there", async () => {
    await register();
    const worktree = path.join(root, "worktree");
    await mkdir(worktree);
    await writeFile(path.join(worktree, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));

    const result = await spinup(["clitest", "--relink", "--path", worktree, "--yes"], root);
    expect(`${result.exitCode} ${result.stderr}`).toBe("0 ");
    expect(await Bun.file(path.join(worktree, ".spinup.yml")).text()).toContain("npm run dev");
  });

  test("running the alias from another checkout suggests --relink", async () => {
    await register();
    const clone = path.join(root, "clone");
    await mkdir(clone);
    await writeFile(path.join(clone, ".spinup.yml"), CONFIG);

    const result = await spinup(["clitest"], clone);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("spinup clitest --relink");
  });

  test("--yes lets a script regenerate without a terminal, keeping a backup", async () => {
    await register();
    await writeFile(path.join(project, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));

    const refused = await spinup(["clitest", "--regenerate"]);
    expect(refused.exitCode).toBe(1);

    const accepted = await spinup(["clitest", "--regenerate", "--yes"]);
    expect(`${accepted.exitCode} ${accepted.stderr}`).toBe("0 ");
    expect(await Bun.file(path.join(project, ".spinup.yml.bak")).text()).toBe(CONFIG);
  });
});
