import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { getConfigPath, loadConfig, saveConfig } from "../src/core/config.ts";
import { sanitizeLegacyAlias } from "../src/core/registry.ts";
import type { SpinupConfig } from "../src/types/config.ts";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => cleanupTempDir(dir)));
});

const config: SpinupConfig = {
  name: "perm",
  root: ".",
  default: "dev",
  actions: {
    dev: { mode: "simple", tasks: [{ name: "a", cwd: ".", cmd: "true", env: { SECRET: "hunter2" } }] },
  },
};

async function projectWithConfig(mode: number): Promise<string> {
  const root = await makeTempDir("spinup-perm-");
  tempDirs.push(root);

  const configPath = path.join(root, ".spinup.yml");
  await writeFile(configPath, "name: perm\nroot: .\ndefault: dev\nactions: {}\n", "utf8");
  await chmod(configPath, mode);

  return root;
}

describe("config replacement preserves permissions", () => {
  // A config can carry task env values, so replacing a 0600 file with a fresh inode
  // at the umask default silently republished those secrets as world-readable.
  test("keeps a restrictive mode under a permissive umask", async () => {
    const root = await projectWithConfig(0o600);

    await saveConfig(root, config);

    expect((await stat(path.join(root, ".spinup.yml"))).mode & 0o777).toBe(0o600);
  });

  test("keeps a group-readable mode as it was", async () => {
    const root = await projectWithConfig(0o640);

    await saveConfig(root, config);

    expect((await stat(path.join(root, ".spinup.yml"))).mode & 0o777).toBe(0o640);
  });

  test("leaves no temporary file behind", async () => {
    const root = await projectWithConfig(0o600);

    await saveConfig(root, config);

    const { readdir } = await import("node:fs/promises");
    expect((await readdir(root)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  test("replaces what a symlinked config points at, keeping the link", async () => {
    const root = await makeTempDir("spinup-perm-link-");
    tempDirs.push(root);
    const real = path.join(root, "real.yml");
    await writeFile(real, "name: perm\nroot: .\ndefault: dev\nactions: {}\n", "utf8");
    await chmod(real, 0o600);
    await symlink(real, path.join(root, ".spinup.yml"));

    await saveConfig(root, config);

    expect((await lstat(path.join(root, ".spinup.yml"))).isSymbolicLink()).toBe(true);
    expect(await readFile(real, "utf8")).toContain("hunter2");
    expect((await stat(real)).mode & 0o777).toBe(0o600);
  });

  test("a failed save leaves the original bytes and mode intact", async () => {
    const root = await projectWithConfig(0o600);
    const configPath = path.join(root, ".spinup.yml");
    const before = await readFile(configPath, "utf8");

    // default points at an action that does not exist, so serialization rejects it.
    await expect(
      saveConfig(root, { name: "x", root: ".", default: "missing", actions: {} } as SpinupConfig),
    ).rejects.toThrow();

    expect(await readFile(configPath, "utf8")).toBe(before);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });

  test("round-trips through the resolved config path", async () => {
    const root = await projectWithConfig(0o600);

    await saveConfig(root, config);

    expect(getConfigPath(root).endsWith(".spinup.yml")).toBe(true);
    expect((await loadConfig(root)).actions.dev).toBeDefined();
  });
});

describe("legacy alias sanitization stays within the length limit", () => {
  test("reserves room for a collision suffix", () => {
    const long = "a".repeat(70);

    expect(sanitizeLegacyAlias(long)!.length).toBe(64);
    // Appending "-2" to a full-length name produced an unusable 66-character key.
    expect(sanitizeLegacyAlias(long, 4)!.length).toBe(60);
  });

  test("does not leave a trailing separator after truncation", () => {
    expect(sanitizeLegacyAlias(`${"a".repeat(63)}.tail`)).not.toMatch(/[-_]$/);
  });
});
