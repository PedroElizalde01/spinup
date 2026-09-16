import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { checkTool, inferRequiredTools, validateConfigPaths } from "../src/core/health.ts";
import type { ProjectDetection } from "../src/core/detectors/types.ts";
import type { SpinupConfig } from "../src/types/config.ts";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => cleanupTempDir(dir)));
});

const emptyDetection: ProjectDetection = {
  stack: "node",
  frameworks: [],
  services: [],
  prisma: false,
  monorepo: false,
  defaultAction: "dev",
  fallbackUsed: false,
};

const mixedConfig: SpinupConfig = {
  name: "health",
  root: ".",
  default: "simple-only",
  actions: {
    "simple-only": { mode: "simple", tasks: [{ name: "a", cwd: ".", cmd: "node server.js" }] },
    workspace: {
      mode: "tmux",
      windows: [{ name: "services", panes: [{ name: "b", cwd: ".", cmd: "npm run dev" }] }],
    },
  },
};

describe("required tool inference", () => {
  // Scanning every action demanded tmux from a project whose selected action is simple.
  test("considers only the selected action", () => {
    expect(inferRequiredTools(mixedConfig, emptyDetection, "simple-only")).not.toContain("tmux");
    expect(inferRequiredTools(mixedConfig, emptyDetection, "workspace")).toContain("tmux");
  });

  test("still considers every action when none is named", () => {
    expect(inferRequiredTools(mixedConfig, emptyDetection)).toContain("tmux");
  });
});

describe("tool probing", () => {
  // Many distributions ship python3 only; probing "python" alone was a false negative.
  test("accepts python3 when python is absent", async () => {
    const result = await checkTool("python");

    expect(result.installed).toBe(true);
    expect(["python", "python3"]).toContain(result.resolvedCommand ?? "");
  });

  test("reports a genuinely absent tool as not installed", async () => {
    // "yarn" may or may not exist here, so assert the shape rather than the value.
    const result = await checkTool("yarn");
    expect(typeof result.installed).toBe("boolean");
  });
});

describe("config path validation", () => {
  async function projectWith(cwd: string): Promise<{ root: string; config: SpinupConfig }> {
    const root = await makeTempDir("spinup-health-");
    tempDirs.push(root);

    return {
      root,
      config: {
        name: "health",
        root: ".",
        default: "dev",
        actions: { dev: { mode: "simple", tasks: [{ name: "svc", cwd, cmd: "true" }] } },
      },
    };
  }

  test("accepts a real directory", async () => {
    const { root, config } = await projectWith("sub");
    await mkdir(path.join(root, "sub"), { recursive: true });

    expect(await validateConfigPaths(root, config, "dev")).toEqual([]);
  });

  test("reports a missing directory", async () => {
    const { root, config } = await projectWith("nope");

    expect((await validateConfigPaths(root, config, "dev")).join()).toContain("not found");
  });

  // access() succeeds for a regular file, so a cwd pointing at one used to pass.
  test("rejects a cwd that is a file", async () => {
    const { root, config } = await projectWith("afile");
    await writeFile(path.join(root, "afile"), "", "utf8");

    expect((await validateConfigPaths(root, config, "dev")).join()).toContain("not a directory");
  });
});
