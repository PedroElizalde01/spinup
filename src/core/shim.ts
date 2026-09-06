import { access, chmod, constants, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { validateAlias } from "./registry.ts";
import { getShimDir } from "../utils/paths.ts";

// Identifies a file as ours, so runit never overwrites or deletes something a user
// put in their bin directory under the same name.
const SHIM_MARKER = "# runit-shim v1";

export function getShimPath(alias: string): string {
  const normalizedAlias = validateAlias(alias);
  const shimDir = getShimDir();
  const shimPath = path.join(shimDir, normalizedAlias);

  // The alias pattern already excludes separators; this is the backstop that keeps
  // a future pattern change from reintroducing traversal.
  if (path.dirname(path.resolve(shimPath)) !== path.resolve(shimDir)) {
    throw new Error(`Refusing to derive a shim path outside ${shimDir}.`);
  }

  return shimPath;
}

function buildShimContents(alias: string): string {
  return `#!/usr/bin/env bash\n${SHIM_MARKER}\nexec runit --start "${alias}" "$@"\n`;
}

async function readIfExists(target: string): Promise<string | undefined> {
  try {
    return await readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

async function isRunitShim(target: string): Promise<boolean> {
  const contents = await readIfExists(target);
  return contents !== undefined && contents.includes(SHIM_MARKER);
}

/**
 * Finds an executable of this name already reachable on PATH. ~/.local/bin usually
 * precedes /usr/bin, so an unchecked alias silently shadows a system command.
 */
async function findOnPath(name: string): Promise<string | undefined> {
  const shimDir = path.resolve(getShimDir());

  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!entry || path.resolve(entry) === shimDir) {
      continue;
    }

    const candidate = path.join(entry, name);

    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep looking.
    }
  }

  return undefined;
}

export async function createShim(alias: string): Promise<void> {
  const normalizedAlias = validateAlias(alias);
  const shimPath = getShimPath(normalizedAlias);

  const existing = await readIfExists(shimPath);

  if (existing !== undefined && !existing.includes(SHIM_MARKER)) {
    throw new Error(
      `Refusing to overwrite ${shimPath}.\n` +
        "That file already exists and was not created by runit. Choose a different alias.",
    );
  }

  if (existing === undefined) {
    const shadowed = await findOnPath(normalizedAlias);

    if (shadowed) {
      throw new Error(
        `Alias "${normalizedAlias}" would shadow an existing command at ${shadowed}.\n` +
          "Choose a different alias.",
      );
    }
  }

  await mkdir(getShimDir(), { recursive: true });
  await writeFile(shimPath, buildShimContents(normalizedAlias), "utf8");
  await chmod(shimPath, 0o755);
}

/**
 * Reclaims a shim whose name predates alias validation, so it cannot be routed
 * through getShimPath. basename() plus the containment check neutralizes any
 * separators the stored name may contain.
 */
export async function reclaimLegacyShim(rawName: string): Promise<boolean> {
  const shimDir = path.resolve(getShimDir());
  const candidate = path.resolve(path.join(shimDir, path.basename(rawName)));

  if (path.dirname(candidate) !== shimDir || !(await isRunitShim(candidate))) {
    return false;
  }

  await rm(candidate, { force: true });
  return true;
}

export async function removeShim(alias: string): Promise<void> {
  const shimPath = getShimPath(alias);

  // Only reclaim files runit created. A same-named file the user owns stays put.
  if (!(await isRunitShim(shimPath))) {
    return;
  }

  await rm(shimPath, { force: true });
}
