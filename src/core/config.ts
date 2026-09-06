import { access, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";
import { z, ZodError } from "zod";

import type { Pane, RunitConfig, Task, Window } from "../types/config.ts";

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

export function parseConfig(raw: string): RunitConfig {
  const parsed = YAML.parse(raw) as unknown;
  return configSchema.parse(parsed) as RunitConfig;
}

export function stringifyConfig(config: RunitConfig): string {
  const parsed = configSchema.parse(config) as RunitConfig;
  return YAML.stringify(parsed);
}

export function getConfigPath(projectRoot: string): string {
  return path.join(projectRoot, ".runit.yml");
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

export async function loadConfig(projectRoot: string): Promise<RunitConfig> {
  const configPath = getConfigPath(projectRoot);
  const raw = await readFile(configPath, "utf8");
  return parseConfig(raw);
}

export async function saveConfig(projectRoot: string, config: RunitConfig): Promise<void> {
  const configPath = getConfigPath(projectRoot);
  // Serialize before touching disk so a validation failure cannot truncate the
  // existing file, then swap atomically so an interrupted write leaves either the
  // old config or the new one, never a partial file.
  const contents = stringifyConfig(config);
  const temporaryPath = `${configPath}.${process.pid}.${Date.now().toString(36)}.tmp`;

  try {
    await writeFile(temporaryPath, contents, "utf8");
    await rename(temporaryPath, configPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}
