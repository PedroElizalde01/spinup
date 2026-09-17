import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { execa } from "execa";

import { respawnPane } from "../src/tmux/layout.ts";
import { launchTmuxWorkspace } from "../src/tmux/runner.ts";
import type { SpinupConfig, TmuxAction } from "../src/types/config.ts";

// Every test drives a private tmux server via TMUX_TMPDIR, so a developer's real
// sessions are never touched. The directory lives directly under the system temp
// dir because a unix socket path is capped at ~108 characters.
let tmuxTmpDir: string;

// Resolved at module load: describe.if is evaluated before any beforeAll runs, so
// an async probe there would not actually gate anything.
const tmuxAvailable = Bun.spawnSync(["tmux", "-V"]).success;

const originalTmuxTmpDir = process.env.TMUX_TMPDIR;
const originalTmux = process.env.TMUX;
const projectDirs: string[] = [];

async function tmux(args: string[]): Promise<string> {
  const { stdout } = await execa("tmux", args, {
    env: { ...process.env, TMUX_TMPDIR: tmuxTmpDir, TMUX: undefined },
  });
  return stdout.trim();
}

afterEach(async () => {
  if (tmuxTmpDir) {
    await execa("tmux", ["kill-server"], {
      env: { ...process.env, TMUX_TMPDIR: tmuxTmpDir },
      reject: false,
    });
    await rm(tmuxTmpDir, { recursive: true, force: true });
  }

  process.env.TMUX_TMPDIR = originalTmuxTmpDir;
  process.env.TMUX = originalTmux;

  if (originalTmuxTmpDir === undefined) {
    delete process.env.TMUX_TMPDIR;
  }

  if (originalTmux === undefined) {
    delete process.env.TMUX;
  }

  await Promise.all(projectDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function isolateTmux(): Promise<string> {
  tmuxTmpDir = await mkdtemp(path.join(tmpdir(), "rt-"));
  process.env.TMUX_TMPDIR = tmuxTmpDir;
  // Not launching from inside tmux, so attach takes the non-TTY branch.
  delete process.env.TMUX;

  const projectRoot = await mkdtemp(path.join(tmpdir(), "rt-proj-"));
  projectDirs.push(projectRoot);

  return projectRoot;
}

function config(action: TmuxAction): SpinupConfig {
  return { name: "tmuxtest", root: ".", default: "dev", actions: { dev: action } };
}

function sleepPanes(count: number): TmuxAction {
  return {
    mode: "tmux",
    windows: [
      {
        name: "services",
        layout: "tiled",
        panes: Array.from({ length: count }, (_, index) => ({
          name: `svc${index + 1}`,
          cwd: ".",
          cmd: "sleep 30",
        })),
      },
    ],
  };
}

describe.if(tmuxAvailable)("tmux workspace", () => {
  test("creates every pane in a crowded window", async () => {
    const projectRoot = await isolateTmux();

    // Splitting eight times before applying a layout used to fail with
    // "no space for new pane" after the fourth.
    await launchTmuxWorkspace(projectRoot, config(sleepPanes(8)), sleepPanes(8), "cap", {});

    expect((await tmux(["list-panes", "-t", "=cap"])).split("\n")).toHaveLength(8);
  }, 30_000);

  test("passes environment to the process without exposing it in scrollback", async () => {
    const projectRoot = await isolateTmux();
    const action: TmuxAction = {
      mode: "tmux",
      windows: [
        {
          name: "services",
          panes: [
            {
              name: "probe",
              cwd: ".",
              cmd: `sh -c 'echo "GOT:[$SPINUP_TEST_SECRET]"; sleep 30'`,
            },
          ],
        },
      ],
    };

    await launchTmuxWorkspace(projectRoot, config(action), action, "envtest", {
      SPINUP_TEST_SECRET: "top-secret-value",
    });

    await Bun.sleep(1200);
    // capture-pane takes a target-pane; the "=" exact-match form is session syntax,
    // so resolve the pane id rather than guessing an index.
    const paneId = await tmux(["list-panes", "-t", "=envtest", "-F", "#{pane_id}"]);
    const pane = await tmux(["capture-pane", "-p", "-S", "-", "-t", paneId]);

    // The process received it...
    expect(pane).toContain("GOT:[top-secret-value]");
    // ...but the assignment itself was never typed into a shell.
    expect(pane).not.toContain("SPINUP_TEST_SECRET=");
    expect(pane).not.toContain("export ");
  }, 30_000);

  test("starts each pane in its configured working directory", async () => {
    const projectRoot = await isolateTmux();
    const action: TmuxAction = {
      mode: "tmux",
      windows: [
        {
          name: "services",
          panes: [{ name: "pwd", cwd: ".", cmd: "sh -c 'pwd > pwd.txt; sleep 30'" }],
        },
      ],
    };

    await launchTmuxWorkspace(projectRoot, config(action), action, "cwdtest", {});
    await Bun.sleep(1200);

    // The file exists at all only because the pane started in the right directory.
    const recorded = (await Bun.file(path.join(projectRoot, "pwd.txt")).text()).trim();
    expect(path.basename(recorded)).toBe(path.basename(projectRoot));
  }, 30_000);

  test("builds multiple windows and names them", async () => {
    const projectRoot = await isolateTmux();
    const action: TmuxAction = {
      mode: "tmux",
      windows: [
        { name: "alpha", panes: [{ name: "a", cwd: ".", cmd: "sleep 30" }] },
        { name: "beta", panes: [{ name: "b", cwd: ".", cmd: "sleep 30" }] },
      ],
    };

    await launchTmuxWorkspace(projectRoot, config(action), action, "windows", {});

    const names = (await tmux(["list-windows", "-t", "=windows", "-F", "#{window_name}"])).split("\n");
    expect(names).toEqual(["alpha", "beta"]);
  }, 30_000);

  test("removes the session it created when a pane cannot start", async () => {
    const projectRoot = await isolateTmux();
    const action: TmuxAction = {
      mode: "tmux",
      windows: [
        {
          name: "services",
          // tmux tolerates a missing -c directory, but rejects an unknown layout,
          // which fails partway through building the workspace.
          layout: "not-a-real-layout",
          panes: [
            { name: "first", cwd: ".", cmd: "sleep 30" },
            { name: "second", cwd: ".", cmd: "sleep 30" },
          ],
        },
      ],
    };

    await expect(launchTmuxWorkspace(projectRoot, config(action), action, "cleanup", {})).rejects.toThrow();

    const sessions = await execa("tmux", ["has-session", "-t", "=cleanup"], {
      env: { ...process.env, TMUX_TMPDIR: tmuxTmpDir },
      reject: false,
    });
    expect(sessions.exitCode).not.toBe(0);
  }, 30_000);

  test("reattaches to its own running session instead of resetting it", async () => {
    const projectRoot = await isolateTmux();
    const action = sleepPanes(2);

    await launchTmuxWorkspace(projectRoot, config(action), action, "own", {});
    const before = await tmux(["list-panes", "-t", "=own", "-F", "#{pane_id} #{pane_pid}"]);

    // Relaunching used to kill-session and rebuild, restarting every process.
    await launchTmuxWorkspace(projectRoot, config(action), action, "own", {});
    const after = await tmux(["list-panes", "-t", "=own", "-F", "#{pane_id} #{pane_pid}"]);

    expect(after).toBe(before);
  }, 30_000);

  test("refuses an exact-name session it did not create", async () => {
    const projectRoot = await isolateTmux();
    await tmux(["new-session", "-d", "-s", "api", "sleep 30"]);
    const before = await tmux(["list-panes", "-t", "=api", "-F", "#{pane_pid}"]);

    const action = sleepPanes(1);
    await expect(launchTmuxWorkspace(projectRoot, config(action), action, "api", {})).rejects.toThrow(
      /not created by spinup/,
    );

    expect(await tmux(["list-panes", "-t", "=api", "-F", "#{pane_pid}"])).toBe(before);
  }, 30_000);

  test("refuses a session owned by another project or action", async () => {
    const projectA = await isolateTmux();
    const projectB = await mkdtemp(path.join(tmpdir(), "rt-proj-"));
    projectDirs.push(projectB);
    const action = sleepPanes(1);

    await launchTmuxWorkspace(projectA, config(action), action, "shared", {});
    const before = await tmux(["list-panes", "-t", "=shared", "-F", "#{pane_pid}"]);

    await expect(launchTmuxWorkspace(projectB, config(action), action, "shared", {})).rejects.toThrow(/belongs to/);
    await expect(launchTmuxWorkspace(projectA, config(action), action, "shared", {}, "other")).rejects.toThrow(
      /action "dev"/,
    );

    expect(await tmux(["list-panes", "-t", "=shared", "-F", "#{pane_pid}"])).toBe(before);
  }, 30_000);

  test("keeps environment values out of tmux failure messages", async () => {
    const projectRoot = await isolateTmux();
    await tmux(["new-session", "-d", "-s", "errs", "sleep 30"]);

    // A pane that does not exist fails respawn-pane after the -e arguments were built.
    const failure = await respawnPane("%424242", {
      cwd: projectRoot,
      env: { SPINUP_TEST_SECRET: "top-secret-value" },
      cmd: "sleep 30",
    }).then(
      () => new Error("respawn-pane unexpectedly succeeded"),
      (error: unknown) => error as Error,
    );

    expect(failure.message).not.toContain("unexpectedly");
    const serialized = `${failure.message}\n${failure.stack ?? ""}\n${JSON.stringify(failure)}`;
    expect(serialized).not.toContain("top-secret-value");
    expect(serialized).not.toContain("SPINUP_TEST_SECRET");
    expect(failure.message).toContain("respawn-pane");
    expect(failure.message).toContain("%424242");
  }, 30_000);

  test("builds every pane when the user sets base-index and pane-base-index to 1", async () => {
    const projectRoot = await isolateTmux();
    // Start the private server with the user's indexing before anything else.
    await tmux(["new-session", "-d", "-s", "settings", "sleep 300"]);
    await tmux(["set-option", "-g", "base-index", "1"]);
    await tmux(["set-option", "-g", "pane-base-index", "1"]);

    const action: TmuxAction = {
      mode: "tmux",
      windows: [
        { name: "alpha", panes: [{ name: "a1", cwd: ".", cmd: "sleep 30" }, { name: "a2", cwd: ".", cmd: "sleep 30" }] },
        { name: "beta", panes: [{ name: "b1", cwd: ".", cmd: "sleep 30" }] },
      ],
    };

    await launchTmuxWorkspace(projectRoot, config(action), action, "indexed", {});

    expect((await tmux(["list-panes", "-s", "-t", "=indexed", "-F", "#{window_name}"])).split("\n")).toEqual(["alpha", "alpha", "beta"]);
  }, 30_000);

  test("a pane gets exactly the launch environment, not stale server variables", async () => {
    const projectRoot = await isolateTmux();
    // A server that was started with a variable nobody wants any more.
    await tmux(["new-session", "-d", "-s", "old", "sleep 300"]);
    await tmux(["set-environment", "-g", "SPINUP_STALE_SERVER_VAR", "leftover"]);

    const action: TmuxAction = {
      mode: "tmux",
      windows: [
        {
          name: "services",
          panes: [{ name: "probe", cwd: ".", cmd: "sh -c 'env > env.txt; sleep 30'" }],
        },
      ],
    };

    await launchTmuxWorkspace(projectRoot, config(action), action, "cleanenv", {
      PATH: process.env.PATH,
      SPINUP_WANTED: "yes",
    });
    await Bun.sleep(1200);

    const recorded = await Bun.file(path.join(projectRoot, "env.txt")).text();
    expect(recorded).toContain("SPINUP_WANTED=yes");
    expect(recorded).not.toContain("SPINUP_STALE_SERVER_VAR");
    // tmux's own per-pane variable is still tmux's, not the launcher's.
    expect(recorded).toMatch(/^TMUX_PANE=%\d+$/m);
  }, 30_000);

  test("a pane waits for its dependency's readiness, and a failed condition keeps the session for inspection", async () => {
    const projectRoot = await isolateTmux();
    const action: TmuxAction = {
      mode: "tmux",
      windows: [
        {
          name: "services",
          panes: [
            { name: "migrate", cwd: ".", cmd: "sh -c 'sleep 0.5; touch migrated'", ready: { exit: 0 } },
            { name: "app", cwd: ".", cmd: "sh -c 'test -f migrated && touch app-saw-migration; sleep 30'", dependsOn: ["migrate"] },
          ],
        },
      ],
    };

    await launchTmuxWorkspace(projectRoot, config(action), action, "ready", {});
    await Bun.sleep(800);
    expect(await Bun.file(path.join(projectRoot, "app-saw-migration")).exists()).toBe(true);

    const failing: TmuxAction = {
      mode: "tmux",
      windows: [
        {
          name: "services",
          panes: [
            { name: "migrate", cwd: ".", cmd: "sh -c 'exit 5'", ready: { exit: 0 } },
            { name: "app", cwd: ".", cmd: "sh -c 'touch should-not-exist; sleep 30'", dependsOn: ["migrate"] },
          ],
        },
      ],
    };

    await expect(launchTmuxWorkspace(projectRoot, config(failing), failing, "notready", {})).rejects.toThrow(
      /exit 0 failed: exited with status 5[\s\S]*still running/,
    );
    expect(await Bun.file(path.join(projectRoot, "should-not-exist")).exists()).toBe(false);
    expect(await tmux(["has-session", "-t", "=notready"]).then(() => true, () => false)).toBe(true);
  }, 30_000);

  test("--logs copies each pane's output to its private log", async () => {
    const projectRoot = await isolateTmux();
    const stateHome = path.join(projectRoot, "state");
    const saved = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateHome;

    try {
      const action: TmuxAction = {
        mode: "tmux",
        windows: [{ name: "services", panes: [{ name: "api", cwd: ".", cmd: "sh -c 'sleep 1; echo PANE_LOGGED; sleep 30'" }] }],
      };

      await launchTmuxWorkspace(projectRoot, config(action), action, "logged", {}, "dev", "logged");

      // Output printed after the pane is up must always reach the log.
      const log = path.join(stateHome, "spinup", "logs", "logged", "api.log");
      let contents = "";

      for (let attempt = 0; attempt < 50 && !contents.includes("PANE_LOGGED"); attempt += 1) {
        await Bun.sleep(100);
        contents = await Bun.file(log).text();
      }

      if (!contents.includes("PANE_LOGGED")) {
        // Enough to tell a closed pipe from a filter that never wrote.
        const paneId = await tmux(["list-panes", "-t", "=logged", "-F", "#{pane_id}"]);
        const pipe = await tmux(["display-message", "-p", "-t", paneId, "pipe=#{pane_pipe} pid=#{pane_pid}"]);
        const screen = await tmux(["capture-pane", "-p", "-t", paneId]);
        const processes = (await execa("ps", ["-A", "-o", "pid,ppid,command"])).stdout
          .split("\n")
          .filter((line) => /awk|dd |spinup/.test(line))
          .join("\n");
        throw new Error(`log empty; ${pipe}\nscreen:\n${screen}\nprocesses:\n${processes}\nlog exists: ${await Bun.file(log).exists()}`);
      }

      expect(contents).toContain("PANE_LOGGED");
    } finally {
      process.env.XDG_STATE_HOME = saved;
      if (saved === undefined) delete process.env.XDG_STATE_HOME;
    }
  }, 30_000);

  test("never destroys a session whose name merely shares a prefix", async () => {
    const projectRoot = await isolateTmux();

    // tmux resolves -t by prefix, so launching "api" used to kill "api-staging".
    await tmux(["new-session", "-d", "-s", "api-staging", "sleep 30"]);

    const action = sleepPanes(1);
    await launchTmuxWorkspace(projectRoot, config(action), action, "api", {});

    const sessions = (await tmux(["list-sessions", "-F", "#{session_name}"])).split("\n");
    expect(sessions).toContain("api-staging");
    expect(sessions).toContain("api");
  }, 30_000);
});
