import { access, chmod, constants, lstat, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import YAML from "yaml";
import { z, ZodError } from "zod";

import type { Pane, SpinupConfig, Task, Window } from "../types/config.ts";

const taskSchema: z.ZodType<Task> = z.object({
  name: z.string().min(1),
  cwd: z.string().min(1),
  cmd: z.string().min(1),
  dependsOn: z.array(z.string().min(1)).optional(),
  delay: z.number().int().nonnegative().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const paneSchema: z.ZodType<Pane> = z.object({
  name: z.string().min(1),
  cwd: z.string().min(1),
  cmd: z.string().min(1),
  dependsOn: z.array(z.string().min(1)).optional(),
  delay: z.number().int().nonnegative().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const windowSchema: z.ZodType<Window> = z.object({
  name: z.string().min(1),
  layout: z.string().min(1).optional(),
  panes: z.array(paneSchema).min(1),
});

const simpleActionSchema = z.object({
  mode: z.literal("simple"),
  tasks: z.array(taskSchema).optional(),
});

const tmuxActionSchema = z.object({
  mode: z.literal("tmux"),
  windows: z.array(windowSchema).min(1),
});

function addUniqueNameIssues(
  items: Array<{ name: string; dependsOn?: string[] }>,
  ctx: z.RefinementCtx,
  basePath: Array<string | number>,
): void {
  const seen = new Set<string>();

  for (const [index, item] of items.entries()) {
    if (seen.has(item.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate service name "${item.name}"`,
        path: [...basePath, index, "name"],
      });
    }

    seen.add(item.name);
  }

  for (const [index, item] of items.entries()) {
    for (const dependency of item.dependsOn ?? []) {
      if (!seen.has(dependency)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown dependency "${dependency}"`,
          path: [...basePath, index, "dependsOn"],
        });
      }
    }
  }
}

const actionSchema = z.discriminatedUnion("mode", [simpleActionSchema, tmuxActionSchema]);

const configSchema = z
  .object({
    name: z.string().min(1),
    root: z.string().min(1),
    default: z.string().min(1),
    actions: z.record(z.string().min(1), actionSchema),
  })
  .superRefine((config, ctx) => {
    if (!config.actions[config.default]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Default action "${config.default}" is not defined in actions.`,
        path: ["default"],
      });
    }

    for (const [actionName, action] of Object.entries(config.actions)) {
      if (action.mode === "simple") {
        addUniqueNameIssues(action.tasks ?? [], ctx, ["actions", actionName, "tasks"]);
        continue;
      }

      addUniqueNameIssues(
        action.windows.flatMap((window) => window.panes),
        ctx,
        ["actions", actionName, "windows"],
      );
    }
  });

export function formatConfigError(error: unknown): string {
  if (error instanceof ZodError) {
    const details = error.issues
      .map((issue) => `${issue.path.join(".") || "config"} ${issue.message}`)
      .join("\n");

    return `Config validation failed\n${details}`;
  }

  if (
    error instanceof Error &&
    ("name" in error && String(error.name).toLowerCase().includes("yaml"))
  ) {
    return `Config validation failed\n${error.message}`;
  }

  if (error instanceof Error) {
    return `Config validation failed\n${error.message}`;
  }

  return `Config validation failed\n${String(error)}`;
}

export function parseConfig(raw: string): SpinupConfig {
  const parsed = YAML.parse(raw) as unknown;
  return configSchema.parse(parsed) as SpinupConfig;
}

export function stringifyConfig(config: SpinupConfig): string {
  const parsed = configSchema.parse(config) as SpinupConfig;
  return YAML.stringify(parsed);
}

export const CONFIG_FILENAME = ".spinup.yml";
export const LEGACY_CONFIG_FILENAME = ".runit.yml";

/**
 * Prefers .spinup.yml but keeps using an existing .runit.yml in place, so projects
 * written before the rename keep working and do not end up with two config files.
 */
export function getConfigPath(projectRoot: string): string {
  const current = path.join(projectRoot, CONFIG_FILENAME);

  if (existsSync(current)) {
    return current;
  }

  const legacy = path.join(projectRoot, LEGACY_CONFIG_FILENAME);
  return existsSync(legacy) ? legacy : current;
}

export async function configExists(projectRoot: string): Promise<boolean> {
  try {
    await access(getConfigPath(projectRoot));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

export async function loadConfig(projectRoot: string): Promise<SpinupConfig> {
  const configPath = getConfigPath(projectRoot);
  const raw = await readFile(configPath, "utf8");
  return parseConfig(raw);
}

function currentUmask(): number {
  const mask = process.umask();
  process.umask(mask);
  return mask;
}

/** Private by default; the file is chmod'd to its intended mode before publishing. */
async function writePrivate(target: string, contents: string): Promise<void> {
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);

  try {
    await handle.writeFile(contents, "utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Replaces the config atomically while keeping its permissions. Writing a new inode
 * gave it the umask default, so saving an existing 0600 config that carries task
 * secrets silently republished it as 0644.
 */
export async function saveConfig(projectRoot: string, config: SpinupConfig): Promise<void> {
  const configPath = getConfigPath(projectRoot);
  // Serialize first, so a validation failure cannot touch the existing file.
  const contents = stringifyConfig(config);

  // A symlinked config is followed deliberately: replace what it points at, rather
  // than silently turning the user's link into a regular file.
  let target = configPath;

  try {
    if ((await lstat(configPath)).isSymbolicLink()) {
      target = await realpath(configPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  let mode: number | undefined;

  try {
    mode = (await stat(target)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const temporaryPath = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;

  try {
    await writePrivate(temporaryPath, contents);
    // Restore the original mode, or leave a new file at the default for its dir.
    // Preserve the original mode; a brand-new file follows the process umask the
    // way an ordinary create would, rather than inheriting the private temp mode.
    await chmod(temporaryPath, mode ?? 0o666 & ~currentUmask());
    await rename(temporaryPath, target);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}
