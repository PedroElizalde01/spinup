import { chmod, constants, link, lstat, mkdir, open, readFile, realpath, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";

import { validateAlias } from "./registry.ts";
import { getShimDir } from "../utils/paths.ts";

const SHIM_MARKER = "# spinup-shim v1";

/**
 * A wrapper is ours only if its entire body matches a format spinup has actually
 * written, for this exact alias. Searching for a marker substring anywhere in a
 * file is weak evidence of ownership: any file mentioning the marker would qualify.
 *
 * The v0.2.2 wrapper carried no marker at all, which is why an upgrade from that
 * release could neither refresh nor reclaim it.
 */
function knownWrapperBodies(alias: string): string[] {
  return [
    // Current.
    `#!/usr/bin/env bash\n${SHIM_MARKER}\nexec spinup --start "${alias}" "$@"\n`,
    // v0.3.0, before the rename to spinup.
    `#!/usr/bin/env bash\n# runit-shim v1\nexec runit --start "${alias}" "$@"\n`,
    // v0.2.2 and earlier: no marker, no exec.
    `#!/usr/bin/env bash\nrunit --start "${alias}" "$@"\n`,
  ];
}

function buildShimContents(alias: string): string {
  return knownWrapperBodies(alias)[0]!;
}

export function isCurrentWrapper(contents: string, alias: string): boolean {
  return contents === buildShimContents(alias);
}

export function getShimPath(alias: string): string {
  const normalizedAlias = validateAlias(alias);
  const shimDir = getShimDir();
  const shimPath = path.join(shimDir, normalizedAlias);

  if (path.dirname(path.resolve(shimPath)) !== path.resolve(shimDir)) {
    throw new Error(`Refusing to derive a shim path outside ${shimDir}.`);
  }

  return shimPath;
}

type Destination =
  | { kind: "absent" }
  | { kind: "symlink" }
  | { kind: "directory" }
  | { kind: "other" }
  | { kind: "file"; contents: string };

/**
 * Classifies with lstat so a symlink is never followed. readFile() follows links,
 * so a dangling one looked like a missing file and writeFile() then created its
 * target outside the shim directory.
 */
async function classify(target: string): Promise<Destination> {
  let stats;

  try {
    stats = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent" };
    }

    throw error;
  }

  if (stats.isSymbolicLink()) {
    return { kind: "symlink" };
  }

  if (stats.isDirectory()) {
    return { kind: "directory" };
  }

  if (!stats.isFile()) {
    return { kind: "other" };
  }

  return { kind: "file", contents: await readFile(target, "utf8") };
}

function describeRefusal(shimPath: string, reason: string): Error {
  return new Error(`Refusing to write ${shimPath}.\n${reason}\nChoose a different alias.`);
}

async function findOnPath(name: string): Promise<string | undefined> {
  const shimDir = path.resolve(getShimDir());

  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!entry || path.resolve(entry) === shimDir) {
      continue;
    }

    const candidate = path.join(entry, name);

    try {
      await lstat(candidate);
      return candidate;
    } catch {
      // Not here; keep looking.
    }
  }

  return undefined;
}

/** Creates the file only if nothing exists at that path, with no check-then-write gap. */
async function createExclusive(target: string, contents: string): Promise<void> {
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o755);

  try {
    await handle.writeFile(contents, "utf8");
  } finally {
    await handle.close();
  }

  await chmod(target, 0o755);
}

function stagingPath(target: string): string {
  return `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
}

/**
 * Publishes a complete wrapper at a path where nothing exists yet. The body is
 * written to a private staging file first, then link() gives it the final name:
 * link never overwrites, never follows a symlink at the destination, and the
 * wrapper appears with its whole body and mode at once. Creating the final path
 * exclusively and then writing it left an empty executable visible in between.
 */
async function publishNew(target: string, contents: string): Promise<void> {
  const temporaryPath = stagingPath(target);

  try {
    await createExclusive(temporaryPath, contents);
    await link(temporaryPath, target);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

/** Replaces an already-approved wrapper without ever following a final symlink. */
async function replaceOwned(target: string, contents: string): Promise<void> {
  const temporaryPath = stagingPath(target);

  try {
    await createExclusive(temporaryPath, contents);
    await rename(temporaryPath, target);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export type ShimOutcome = "created" | "refreshed" | "unchanged";

/**
 * Writes or refreshes the wrapper and says which happened, so a caller that fails
 * later can roll back a file it created without touching one that already existed.
 */
export async function createShim(alias: string): Promise<ShimOutcome> {
  const normalizedAlias = validateAlias(alias);
  const shimPath = getShimPath(normalizedAlias);
  await mkdir(getShimDir(), { recursive: true });

  const destination = await classify(shimPath);

  switch (destination.kind) {
    case "absent": {
      const shadowed = await findOnPath(normalizedAlias);

      if (shadowed) {
        throw describeRefusal(shimPath, `"${normalizedAlias}" already exists on PATH at ${shadowed}.`);
      }

      try {
        await publishNew(shimPath, buildShimContents(normalizedAlias));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }

        // Another process won the race. Whatever it published is complete, so
        // judge it like any existing file rather than refusing outright.
        const winner = await classify(shimPath);

        if (winner.kind === "file" && isCurrentWrapper(winner.contents, normalizedAlias)) {
          return "unchanged";
        }

        throw describeRefusal(shimPath, "Another process created that file first.");
      }

      return "created";
    }

    case "symlink":
      throw describeRefusal(
        shimPath,
        "That path is a symbolic link. Writing it would modify the file it points at, outside the shim directory.",
      );

    case "directory":
      throw describeRefusal(shimPath, "That path is a directory.");

    case "other":
      throw describeRefusal(shimPath, "That path is not a regular file.");

    case "file": {
      if (!knownWrapperBodies(normalizedAlias).includes(destination.contents)) {
        throw describeRefusal(shimPath, "That file exists and was not created by spinup.");
      }

      if (isCurrentWrapper(destination.contents, normalizedAlias)) {
        return "unchanged";
      }

      await replaceOwned(shimPath, buildShimContents(normalizedAlias));
      return "refreshed";
    }
  }
}

/** True when the destination holds a wrapper spinup owns but no longer writes. */
export async function needsShimRefresh(alias: string): Promise<boolean> {
  const destination = await classify(getShimPath(alias));

  return (
    destination.kind === "file" &&
    knownWrapperBodies(alias).includes(destination.contents) &&
    !isCurrentWrapper(destination.contents, alias)
  );
}

export async function readShim(alias: string): Promise<string | undefined> {
  const destination = await classify(getShimPath(alias));
  return destination.kind === "file" ? destination.contents : undefined;
}

/**
 * Removes a wrapper only when it is a regular file whose whole body is one spinup
 * wrote for this alias. Returns false when there was nothing of ours to remove, so
 * a caller can report the difference instead of assuming success.
 */
export async function removeShim(alias: string): Promise<boolean> {
  const normalizedAlias = validateAlias(alias);
  const shimPath = getShimPath(normalizedAlias);
  const destination = await classify(shimPath);

  if (destination.kind !== "file" || !knownWrapperBodies(normalizedAlias).includes(destination.contents)) {
    return false;
  }

  await unlink(shimPath);
  return true;
}

/**
 * Reclaims a wrapper stored under a pre-validation alias. The old name cannot go
 * through getShimPath, so it is reduced to a basename and confined to the shim
 * directory, and it is removed only when its body is a wrapper written for that
 * same old alias. Returns false when it resolves to the same file as `keep`, which
 * happens on a case-insensitive filesystem after a case-only rename.
 */
export async function reclaimLegacyShim(rawName: string, keep?: string): Promise<boolean> {
  const shimDir = path.resolve(getShimDir());
  const candidate = path.resolve(path.join(shimDir, path.basename(rawName)));

  if (path.dirname(candidate) !== shimDir) {
    return false;
  }

  if (keep) {
    const keptPath = getShimPath(keep);

    if (candidate === path.resolve(keptPath)) {
      return false;
    }

    try {
      // Case-insensitive filesystems resolve both names to one file; deleting the
      // old name would delete the wrapper just written for the new one.
      if ((await realpath(candidate)) === (await realpath(keptPath))) {
        return false;
      }
    } catch {
      // One of them does not exist; fall through to the ownership check.
    }
  }

  const destination = await classify(candidate);

  if (destination.kind !== "file" || !knownWrapperBodies(path.basename(rawName)).includes(destination.contents)) {
    return false;
  }

  await unlink(candidate);
  return true;
}
