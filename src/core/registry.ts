import { open, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
export const MAX_ALIAS_LENGTH = 64;

/**
 * `reserve` leaves room for a collision suffix. Truncating to the full 64 first and
 * appending "-2" afterwards produced a 66-character key that could never be used.
 */
export function sanitizeLegacyAlias(alias: string, reserve = 0): string | undefined {
  const candidate = normalizeAlias(alias)
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, MAX_ALIAS_LENGTH - reserve)
    .replace(/[-_]+$/g, "");

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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else: still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The lock file names its holder. Age alone was the previous test, and a slow but
 * live holder past the threshold had its lock deleted from under it. Now a lock is
 * removed only when its recorded holder is gone; otherwise the holder is reported.
 */
async function recoverLock(lockPath: string): Promise<{ recovered: boolean; holder?: number }> {
  let holder: number | undefined;

  try {
    const raw = (await readFile(lockPath, "utf8")).trim();
    holder = /^\d+$/.test(raw) ? Number(raw) : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // Released while we waited; retry immediately.
      return { recovered: true };
    }

    throw error;
  }

  if (holder !== undefined && processAlive(holder)) {
    return { recovered: false, holder };
  }

  if (holder === undefined) {
    // Unreadable holder: not proof of anything, so leave it to the user.
    return { recovered: false };
  }

  await rm(lockPath, { force: true });
  return { recovered: true };
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
        await handle.writeFile(`${process.pid}\n`, "utf8");
        await handle.close();
        return await operation();
      } finally {
        await rm(lockPath, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      if (Date.now() > deadline) {
        const { recovered, holder } = await recoverLock(lockPath);

        if (!recovered) {
          const who = holder === undefined ? "Its holder could not be read." : `It is held by process ${holder}.`;
          throw new Error(
            `Timed out waiting for the spinup registry lock at ${lockPath}.\n` +
              `${who} Wait for that spinup process to finish, or remove the file if you are sure it is stale.`,
          );
        }
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

      if (Object.hasOwn(registry, candidate)) {
        // Re-derive with room for the suffix so the result stays within the limit.
        const stem = sanitizeLegacyAlias(legacyAlias, 4) ?? base;
        candidate = "";

        for (let suffix = 2; suffix < 100; suffix += 1) {
          const attempt = `${stem}-${suffix}`;

          if (!Object.hasOwn(registry, attempt) && isCanonicalAlias(attempt)) {
            candidate = attempt;
            break;
          }
        }
      }

      if (!candidate || Object.hasOwn(registry, candidate)) {
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
