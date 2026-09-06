import { readFile } from "node:fs/promises";
import path from "node:path";

import dotenv from "dotenv";

export type LoadedEnv = {
  /** Files that existed and were read, in the order they were applied. */
  files: string[];
  /** Everything parsed from those files, later files winning. */
  values: Record<string, string>;
  /** The subset that actually takes effect; an inherited shell value wins. */
  applied: Record<string, string>;
  /** Which file each key's winning value came from. */
  origins: Record<string, string>;
  /** Keys present in a file but overridden by the surrounding shell. */
  shadowed: string[];
  /** Files that look like environment files but were not selected. */
  ignored: string[];
};

/**
 * Files are applied in this order, later winning:
 *
 *   .env  ->  .env.local  ->  .env.<action>  ->  .env.<action>.local
 *
 * The action name is used verbatim. Previously `.env.development` was read for
 * every action, including `build`, which conflated an action with a deployment
 * mode. It is now only read by an action actually named `development`, and its
 * presence is reported when it is skipped rather than silently ignored.
 */
function candidateFiles(action: string): string[] {
  return [".env", ".env.local", `.env.${action}`, `.env.${action}.local`];
}

const LEGACY_MODE_FILES = [".env.development", ".env.production", ".env.test"];

async function readEnvFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

export type LoadEnvOptions = {
  /** Environment to treat as inherited. Defaults to this process's. */
  shellEnv?: NodeJS.ProcessEnv;
};

/**
 * Reads the project's environment files. This function is pure: it returns what it
 * found and never mutates `process.env`, so inspecting the environment for display
 * cannot change how a later command runs.
 */
export async function loadEnv(
  envRoot: string,
  action: string,
  options: LoadEnvOptions = {},
): Promise<LoadedEnv> {
  const shellEnv = options.shellEnv ?? process.env;
  const selected = candidateFiles(action);
  const values: Record<string, string> = {};
  const origins: Record<string, string> = {};
  const files: string[] = [];

  for (const candidate of selected) {
    const raw = await readEnvFile(path.join(envRoot, candidate));

    if (raw === undefined) {
      continue;
    }

    for (const [key, value] of Object.entries(dotenv.parse(raw))) {
      values[key] = value;
      origins[key] = candidate;
    }

    files.push(candidate);
  }

  // An explicit value in the invoking shell is a deliberate override for this run,
  // so it beats the file. A task's own `env:` block still beats both.
  const applied: Record<string, string> = {};
  const shadowed: string[] = [];

  for (const [key, value] of Object.entries(values)) {
    if (shellEnv[key] !== undefined && shellEnv[key] !== value) {
      shadowed.push(key);
      continue;
    }

    applied[key] = value;
  }

  const ignored: string[] = [];

  for (const legacy of LEGACY_MODE_FILES) {
    if (selected.includes(legacy)) {
      continue;
    }

    if ((await readEnvFile(path.join(envRoot, legacy))) !== undefined) {
      ignored.push(legacy);
    }
  }

  return { files, values, applied, origins, shadowed: shadowed.sort(), ignored };
}
