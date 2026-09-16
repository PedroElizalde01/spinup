import { access, chmod, constants, lstat, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import YAML, { isMap, isSeq, type Document, type YAMLMap, type YAMLSeq } from "yaml";
import { z, ZodError } from "zod";

import type { Action, Pane, SpinupConfig, Task, Window } from "../types/config.ts";

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

type Runnable = Task | Pane;
const RUNNABLE_FIELDS = ["name", "cwd", "cmd", "dependsOn", "delay", "env"] as const;

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function patchRunnable(doc: Document, node: YAMLMap, current: Runnable, next: Runnable): void {
  for (const field of RUNNABLE_FIELDS) {
    const value = next[field];

    if (sameValue(current[field], value)) {
      continue;
    }

    if (value === undefined) {
      node.delete(field);
    } else {
      node.set(field, doc.createNode(value));
    }
  }
}

/**
 * Patches a task/pane list in place: fields change on their own nodes, removed
 * entries are deleted, added ones appended. Anything more (a reorder) replaces
 * the list, since there is no comment-preserving way to express it.
 */
function patchRunnables(doc: Document, at: Array<string | number>, current: Runnable[], next: Runnable[]): void {
  const seq = doc.getIn(at);

  if (!isSeq(seq)) {
    doc.setIn(at, doc.createNode(next));
    return;
  }

  const currentByName = new Map(current.map((item, index) => [item.name, { item, index }]));
  const nextNames = new Set(next.map((item) => item.name));

  for (const item of next) {
    const existing = currentByName.get(item.name);
    const node = existing ? (seq as YAMLSeq).items[existing.index] : undefined;

    if (existing && isMap(node)) {
      patchRunnable(doc, node as YAMLMap, existing.item, item);
    }
  }

  const removedIndexes = current
    .map((item, index) => (nextNames.has(item.name) ? -1 : index))
    .filter((index) => index >= 0)
    .sort((left, right) => right - left);

  for (const index of removedIndexes) {
    (seq as YAMLSeq).delete(index);
  }

  for (const item of next) {
    if (!currentByName.has(item.name)) {
      (seq as YAMLSeq).add(doc.createNode(item));
    }
  }

  const resultNames = ((seq as YAMLSeq).items as YAMLMap[]).map((node) => (isMap(node) ? String(node.get("name")) : ""));

  if (!sameValue(resultNames, next.map((item) => item.name))) {
    doc.setIn(at, doc.createNode(next));
  }
}

function patchAction(doc: Document, at: Array<string | number>, current: Action, next: Action): void {
  if (current.mode !== next.mode) {
    doc.setIn(at, doc.createNode(next));
    return;
  }

  if (current.mode === "simple" && next.mode === "simple") {
    patchRunnables(doc, [...at, "tasks"], current.tasks ?? [], next.tasks ?? []);
    return;
  }

  if (current.mode !== "tmux" || next.mode !== "tmux") {
    return;
  }

  const sameWindows =
    current.windows.length === next.windows.length &&
    current.windows.every((window, index) => window.name === next.windows[index]?.name);

  if (!sameWindows) {
    doc.setIn([...at, "windows"], doc.createNode(next.windows));
    return;
  }

  for (const [index, window] of next.windows.entries()) {
    const before = current.windows[index]!;
    const windowPath = [...at, "windows", index];

    if (!sameValue(before.layout, window.layout)) {
      if (window.layout === undefined) {
        doc.deleteIn([...windowPath, "layout"]);
      } else {
        doc.setIn([...windowPath, "layout"], window.layout);
      }
    }

    patchRunnables(doc, [...windowPath, "panes"], before.panes, window.panes);
  }
}

/**
 * Applies a structured edit to the file's own YAML document, so comments and
 * formatting on everything that did not change survive. Reserializing from the
 * parsed object dropped every comment in the file on any interactive save.
 */
export function patchConfigYaml(raw: string, next: SpinupConfig): string {
  const doc = YAML.parseDocument(raw);
  const current = configSchema.parse(doc.toJS()) as SpinupConfig;

  for (const key of ["name", "root", "default"] as const) {
    if (current[key] !== next[key]) {
      doc.set(key, next[key]);
    }
  }

  for (const actionName of new Set([...Object.keys(current.actions), ...Object.keys(next.actions)])) {
    const before = current.actions[actionName];
    const after = next.actions[actionName];

    if (!after) {
      doc.deleteIn(["actions", actionName]);
    } else if (!before) {
      doc.setIn(["actions", actionName], doc.createNode(after));
    } else {
      patchAction(doc, ["actions", actionName], before, after);
    }
  }

  return doc.toString();
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
  // Serialize first, so a validation failure cannot touch the existing file.
  await writeConfigText(projectRoot, stringifyConfig(config));
}

/** Saves a structured edit onto the existing file, keeping its comments. */
export async function saveConfigPatched(projectRoot: string, next: SpinupConfig): Promise<void> {
  const raw = await readFile(getConfigPath(projectRoot), "utf8");
  const text = patchConfigYaml(raw, next);
  // The patched document must still be the config we meant to write.
  const reparsed = parseConfig(text);

  if (JSON.stringify(reparsed) !== JSON.stringify(configSchema.parse(next))) {
    // Fall back to a clean serialization rather than write something else.
    await writeConfigText(projectRoot, stringifyConfig(next));
    return;
  }

  await writeConfigText(projectRoot, text);
}

/**
 * Keeps the exact previous bytes next to the config, privately, before a
 * replacement. The name is fixed so a repeated regeneration does not pile up
 * copies; the previous backup is dropped first, so a link there is never followed.
 */
export async function backupConfig(projectRoot: string): Promise<string> {
  const configPath = getConfigPath(projectRoot);
  const backupPath = `${configPath}.bak`;
  const bytes = await readFile(configPath);

  await rm(backupPath, { force: true });
  const handle = await open(backupPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);

  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }

  return backupPath;
}

async function writeConfigText(projectRoot: string, contents: string): Promise<void> {
  const configPath = getConfigPath(projectRoot);

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
