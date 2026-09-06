import { open, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { getConfigDir, getLegacyConfigDir, getRegistryPath } from "../utils/paths.ts";

type ProjectRegistry = Record<string, string>;

// "runit" stays reserved so shims from before the rename cannot be re-registered.
const RESERVED_ALIASES = new Set(["spinup", "runit"]);

// Deliberately narrow: no path separators, no shell metacharacters, and no "." or
// ":" so an alias can never be mistaken for a tmux target (session:window.pane).
const ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const LOCK_ACQUIRE_TIMEOUT_MS = 5000;
const LOCK_RETRY_INTERVAL_MS = 25;
const LOCK_STALE_AFTER_MS = 30_000;

export function normalizeAlias(alias: string): string {
  return alias.trim().toLowerCase();
}

/**
 * Single source of truth for alias identity. Returns the canonical form so callers
 * store, look up, and derive filenames from the same value -- previously validation
 * lowercased only for its checks while the raw value was used everywhere else.
 */
export function validateAlias(alias: string): string {
  const normalizedAlias = normalizeAlias(alias);

  if (!normalizedAlias) {
    throw new Error("Project alias cannot be empty.");
  }

  if (RESERVED_ALIASES.has(normalizedAlias)) {
    throw new Error(`Project alias "${alias}" is reserved. Choose a different alias.`);
  }

  if (!ALIAS_PATTERN.test(normalizedAlias)) {
    throw new Error(
      `Invalid project alias "${alias}".\n` +
        "Use lowercase letters, digits, - and _, starting with a letter or digit (max 64 characters).",
    );
  }

  return normalizedAlias;
}

export function isCanonicalAlias(alias: string): boolean {
  return ALIAS_PATTERN.test(alias) && !RESERVED_ALIASES.has(alias);
}

/**
 * Best-effort canonical form for an alias registered before the format was
 * enforced, e.g. "My.App" -> "my-app". Returns undefined when nothing usable
 * survives, so the caller can report it rather than silently dropping the entry.
 */
export function sanitizeLegacyAlias(alias: string): string | undefined {
  const candidate = normalizeAlias(alias)
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 64);

  return isCanonicalAlias(candidate) ? candidate : undefined;
}

/**
 * Adopts the registry from the pre-rename location. Only runs when the new
 * directory does not exist yet, so it can never clobber current state.
 */
async function adoptLegacyConfigDir(): Promise<void> {
  const configDir = getConfigDir();
  const legacyDir = getLegacyConfigDir();

  if (configDir === legacyDir || existsSync(configDir) || !existsSync(legacyDir)) {
    return;
  }

  try {
    await rename(legacyDir, configDir);
  } catch {
    // A cross-device or permission failure just means starting fresh.
  }
}

async function ensureRegistryDir(): Promise<void> {
  await adoptLegacyConfigDir();
  await mkdir(getConfigDir(), { recursive: true });
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
  try {
    const stats = await stat(lockPath);

    if (Date.now() - stats.mtimeMs < LOCK_STALE_AFTER_MS) {
      return false;
    }

    await rm(lockPath, { force: true });
    return true;
  } catch {
    // Lock vanished on its own; the caller can retry immediately.
    return true;
  }
}

/**
 * Serializes the whole read-modify-write. Atomic replacement alone only prevents a
 * torn file -- concurrent registrations would still overwrite each other's entries.
 */
async function withRegistryLock<T>(operation: () => Promise<T>): Promise<T> {
  await ensureRegistryDir();
  const lockPath = `${getRegistryPath()}.lock`;
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;

  for (;;) {
    try {
      const handle = await open(lockPath, "wx");

      try {
        await handle.close();
        return await operation();
      } finally {
        await rm(lockPath, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      if (Date.now() > deadline && !(await removeStaleLock(lockPath))) {
        throw new Error(
          `Timed out waiting for the spinup registry lock at ${lockPath}.\n` +
            "Another spinup process may be running. Remove that file if it is stale.",
        );
      }

      await delay(LOCK_RETRY_INTERVAL_MS);
    }
  }
}

async function writeFileAtomic(target: string, contents: string): Promise<void> {
  // Same directory, so the rename cannot cross filesystems.
  const temporaryPath = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;

  try {
    await writeFile(temporaryPath, contents, "utf8");
    await rename(temporaryPath, target);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function readRegistryUnlocked(): Promise<ProjectRegistry> {
  await ensureRegistryDir();

  let raw: string;

  try {
    raw = await readFile(getRegistryPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return Object.create(null) as ProjectRegistry;
    }

    throw error;
  }

  const parsed = JSON.parse(raw) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Registry file is not a valid object.");
  }

  // Null-prototype, so a stored alias can never resolve to an inherited member such
  // as "toString" or "constructor".
  const registry = Object.create(null) as ProjectRegistry;

  for (const [alias, projectPath] of Object.entries(parsed)) {
    if (typeof projectPath !== "string") {
      throw new Error(`Registry entry for "${alias}" must be a string path.`);
    }

    registry[alias] = projectPath;
  }

  return registry;
}

async function writeRegistryUnlocked(registry: ProjectRegistry): Promise<void> {
  await ensureRegistryDir();
  await writeFileAtomic(getRegistryPath(), `${JSON.stringify(registry, null, 2)}\n`);
}

export async function registerProject(alias: string, projectPath: string): Promise<void> {
  const normalizedAlias = validateAlias(alias);
  const resolvedPath = path.resolve(projectPath);

  await withRegistryLock(async () => {
    const registry = await readRegistryUnlocked();
    registry[normalizedAlias] = resolvedPath;
    await writeRegistryUnlocked(registry);
  });
}

export async function removeProject(alias: string): Promise<void> {
  const normalizedAlias = validateAlias(alias);

  await withRegistryLock(async () => {
    const registry = await readRegistryUnlocked();
    delete registry[normalizedAlias];
    await writeRegistryUnlocked(registry);
  });
}

export async function getProject(alias: string): Promise<string | undefined> {
  const normalizedAlias = validateAlias(alias);
  const registry = await readRegistryUnlocked();

  return Object.hasOwn(registry, normalizedAlias) ? registry[normalizedAlias] : undefined;
}

export async function listProjects(): Promise<ProjectRegistry> {
  return readRegistryUnlocked();
}

export type AliasMigration = {
  from: string;
  to?: string;
  reason?: string;
};

/**
 * Rewrites entries registered before the alias format was enforced. Runs only when
 * a non-canonical key is actually present, so the normal path never pays for the
 * lock. Entries that cannot be rescued are reported and left in place rather than
 * discarded.
 */
export async function migrateLegacyAliases(): Promise<AliasMigration[]> {
  const existing = await readRegistryUnlocked();

  if (Object.keys(existing).every((alias) => isCanonicalAlias(alias))) {
    return [];
  }

  return withRegistryLock(async () => {
    const registry = await readRegistryUnlocked();
    const migrations: AliasMigration[] = [];
    let changed = false;

    for (const legacyAlias of Object.keys(registry)) {
      if (isCanonicalAlias(legacyAlias)) {
        continue;
      }

      const projectPath = registry[legacyAlias]!;
      const base = sanitizeLegacyAlias(legacyAlias);

      if (!base) {
        migrations.push({ from: legacyAlias, reason: "no valid alias could be derived" });
        continue;
      }

      let candidate = base;

      for (let suffix = 2; Object.hasOwn(registry, candidate) && suffix < 100; suffix += 1) {
        candidate = `${base}-${suffix}`;
      }

      if (Object.hasOwn(registry, candidate)) {
        migrations.push({ from: legacyAlias, reason: "every candidate name was taken" });
        continue;
      }

      delete registry[legacyAlias];
      registry[candidate] = projectPath;
      migrations.push({ from: legacyAlias, to: candidate });
      changed = true;
    }

    if (changed) {
      await writeRegistryUnlocked(registry);
    }

    return migrations;
  });
}
