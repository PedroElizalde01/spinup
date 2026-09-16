import { afterEach, describe, expect, test } from "bun:test";

import { buildDependencyGraph, visualizeDependencyGraph } from "../src/core/dependencies.ts";
import { loadEnv } from "../src/core/env.ts";
import { cleanupTempDir, makeTempDir, writeProjectFile } from "./helpers.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => cleanupTempDir(dir)));
});

describe("environment and dependency resolution", () => {
  test("applies env files in order, later files winning", async () => {
    const projectRoot = await makeTempDir("spinup-env-");
    tempDirs.push(projectRoot);

    await writeProjectFile(projectRoot, ".env", "DATABASE_URL=base\n");
    await writeProjectFile(projectRoot, ".env.local", "DATABASE_URL=local\n");
    await writeProjectFile(projectRoot, ".env.dev", "DATABASE_URL=dev\nREDIS_HOST=127.0.0.1\n");
    await writeProjectFile(projectRoot, ".env.dev.local", "REDIS_HOST=10.0.0.1\n");

    const env = await loadEnv(projectRoot, "dev", { shellEnv: {} });

    expect(env.files).toEqual([".env", ".env.local", ".env.dev", ".env.dev.local"]);
    expect(env.values.DATABASE_URL).toBe("dev");
    expect(env.values.REDIS_HOST).toBe("10.0.0.1");
    expect(env.origins.REDIS_HOST).toBe(".env.dev.local");
  });

  test("reads .env.<action> for the action's own name, not a fixed mode", async () => {
    const projectRoot = await makeTempDir("spinup-env-mode-");
    tempDirs.push(projectRoot);

    await writeProjectFile(projectRoot, ".env", "BASE=yes\n");
    await writeProjectFile(projectRoot, ".env.development", "MODE=development\n");

    // .env.development used to be read for every action, including "build".
    const build = await loadEnv(projectRoot, "build", { shellEnv: {} });
    expect(build.values.MODE).toBeUndefined();
    expect(build.ignored).toContain(".env.development");

    const development = await loadEnv(projectRoot, "development", { shellEnv: {} });
    expect(development.values.MODE).toBe("development");
    expect(development.ignored).not.toContain(".env.development");
  });

  test("an inherited shell value wins over a file value", async () => {
    const projectRoot = await makeTempDir("spinup-env-shell-");
    tempDirs.push(projectRoot);

    await writeProjectFile(projectRoot, ".env", "TOKEN=from-file\nONLY_FILE=yes\n");

    const env = await loadEnv(projectRoot, "dev", { shellEnv: { TOKEN: "from-shell" } });

    expect(env.values.TOKEN).toBe("from-file");
    expect(env.applied.TOKEN).toBeUndefined();
    expect(env.applied.ONLY_FILE).toBe("yes");
    expect(env.shadowed).toEqual(["TOKEN"]);
  });

  test("does not mutate the surrounding process environment", async () => {
    const projectRoot = await makeTempDir("spinup-env-pure-");
    tempDirs.push(projectRoot);

    await writeProjectFile(projectRoot, ".env", "SPINUP_PURITY_PROBE=should-not-leak\n");
    delete process.env.SPINUP_PURITY_PROBE;

    await loadEnv(projectRoot, "dev", { shellEnv: {} });

    // Inspecting the environment must not change how a later command runs.
    expect(process.env.SPINUP_PURITY_PROBE).toBeUndefined();
  });

  test("builds dependency order and graph output", () => {
    const ordered = buildDependencyGraph([
      { name: "web", cwd: ".", cmd: "echo web", dependsOn: ["api"] },
      { name: "api", cwd: ".", cmd: "echo api", dependsOn: ["database"] },
      { name: "database", cwd: ".", cmd: "echo db", delay: 1000 },
    ]);

    expect(ordered.map((item) => item.name)).toEqual(["database", "api", "web"]);
    expect(visualizeDependencyGraph(ordered)).toBe("database\n  ↓\napi\n  ↓\nweb");
  });

  test("detects circular dependencies", () => {
    expect(() =>
      buildDependencyGraph([
        { name: "api", cwd: ".", cmd: "echo api", dependsOn: ["web"] },
        { name: "web", cwd: ".", cmd: "echo web", dependsOn: ["api"] },
      ]),
    ).toThrow("circular dependency detected");
  });
});
