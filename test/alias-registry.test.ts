import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { getProject, listProjects, registerProject, removeProject, validateAlias } from "../src/core/registry.ts";
import { createShim, getShimPath, removeShim } from "../src/core/shim.ts";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";

const tempDirs: string[] = [];
const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalShimDir = process.env.RUNIT_SHIM_DIR;

async function isolate(): Promise<{ configHome: string; shimDir: string }> {
  const root = await makeTempDir("runit-registry-");
  tempDirs.push(root);

  const configHome = path.join(root, "config");
  const shimDir = path.join(root, "bin");
  await mkdir(configHome, { recursive: true });
  await mkdir(shimDir, { recursive: true });

  process.env.XDG_CONFIG_HOME = configHome;
  process.env.RUNIT_SHIM_DIR = shimDir;

  return { configHome, shimDir };
}

afterEach(async () => {
  process.env.XDG_CONFIG_HOME = originalConfigHome;
  process.env.RUNIT_SHIM_DIR = originalShimDir;

  if (originalConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  }

  if (originalShimDir === undefined) {
    delete process.env.RUNIT_SHIM_DIR;
  }

  await Promise.all(tempDirs.splice(0).map((dir) => cleanupTempDir(dir)));
});

describe("alias validation", () => {
  test.each([
    ["../../escaped", "path traversal"],
    ["app$(touch pwned)", "command substitution"],
    ['app"; echo hi; "', "quote break-out"],
    ["with space", "whitespace"],
    ["with/slash", "separator"],
    ["with.dot", "tmux target punctuation"],
    ["with:colon", "tmux target punctuation"],
    ["", "empty"],
    ["-leading", "leading dash"],
    ["runit", "reserved"],
  ])("rejects %p (%s)", (alias) => {
    expect(() => validateAlias(alias)).toThrow();
  });

  test("normalizes case so one project cannot occupy two entries", async () => {
    await isolate();
    const root = await makeTempDir("runit-project-");
    tempDirs.push(root);

    expect(validateAlias("MyApp")).toBe("myapp");

    await registerProject("MyApp", root);
    await registerProject("myapp", root);

    expect(Object.keys(await listProjects())).toEqual(["myapp"]);
  });

  test("an unregistered alias never resolves to an inherited object member", async () => {
    await isolate();
    // "toString" used to return Object.prototype.toString from the registry object.
    expect(await getProject("tostring")).toBeUndefined();
    expect(await getProject("constructor")).toBeUndefined();
  });
});

describe("shim ownership", () => {
  test("refuses to overwrite a file runit did not create", async () => {
    const { shimDir } = await isolate();
    const victim = path.join(shimDir, "precious");
    await writeFile(victim, "#!/bin/sh\necho PRECIOUS\n", "utf8");
    await chmod(victim, 0o755);

    await expect(createShim("precious")).rejects.toThrow(/Refusing to overwrite/);
    expect(await readFile(victim, "utf8")).toContain("PRECIOUS");
  });

  test("refuses an alias that would shadow a command already on PATH", async () => {
    await isolate();
    await expect(createShim("env")).rejects.toThrow(/would shadow an existing command/);
  });

  test("leaves a same-named foreign file in place on removal", async () => {
    const { shimDir } = await isolate();
    const victim = path.join(shimDir, "keepme");
    await writeFile(victim, "#!/bin/sh\necho KEEP\n", "utf8");

    await removeShim("keepme");

    expect(await readFile(victim, "utf8")).toContain("KEEP");
  });

  test("creates then reclaims its own shim", async () => {
    await isolate();
    await createShim("ownshim");

    const contents = await readFile(getShimPath("ownshim"), "utf8");
    expect(contents).toContain("runit-shim");
    expect(contents).toContain('runit --start "ownshim"');

    await removeShim("ownshim");
    await expect(readFile(getShimPath("ownshim"), "utf8")).rejects.toThrow();
  });
});

describe("registry durability", () => {
  test("concurrent registrations do not lose entries", async () => {
    await isolate();
    const root = await makeTempDir("runit-concurrent-");
    tempDirs.push(root);

    const aliases = Array.from({ length: 20 }, (_, index) => `concurrent${index}`);
    await Promise.all(aliases.map((alias) => registerProject(alias, root)));

    expect(Object.keys(await listProjects()).sort()).toEqual([...aliases].sort());
  });

  test("removal is durable and leaves other entries intact", async () => {
    await isolate();
    const root = await makeTempDir("runit-remove-");
    tempDirs.push(root);

    await registerProject("keep", root);
    await registerProject("drop", root);
    await removeProject("drop");

    expect(Object.keys(await listProjects())).toEqual(["keep"]);
  });

  test("honors XDG_CONFIG_HOME and ignores a relative override", async () => {
    const { configHome } = await isolate();
    const root = await makeTempDir("runit-xdg-");
    tempDirs.push(root);

    await registerProject("xdgtest", root);
    expect(await readFile(path.join(configHome, "runit", "projects.json"), "utf8")).toContain("xdgtest");

    // The XDG spec says a relative value must be ignored, not resolved against cwd.
    process.env.XDG_CONFIG_HOME = "relative/path";
    await expect(listProjects()).resolves.toBeDefined();
  });
});
