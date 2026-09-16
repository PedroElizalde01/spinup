import { access, chmod, constants, lstat, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import YAML, { isMap, isSeq, type Document, type YAMLMap, type YAMLSeq } from "yaml";
import { z, ZodError } from "zod";

import { buildDependencyGraph } from "./dependencies.ts";
import type { Action, Pane, SpinupConfig, Task, Window } from "../types/config.ts";

/** The newest config format this build understands. */
export const CURRENT_CONFIG_VERSION = 1;

// Validated without rewriting: a command is run exactly as written, so trimming
// here would make validation and execution disagree.
const nonblank = z.string().refine((value) => value.trim().length > 0, { message: "must not be blank" });

// What a POSIX shell accepts as a variable name. Anything else cannot be exported
// and tmux would reject it at pane creation, after the session already exists.
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const envSchema = z.record(
  z.string().regex(ENV_KEY_PATTERN, "is not a valid environment variable name"),
  z.string(),
);

// Unknown keys are rejected: a misspelled `dependson` used to disappear silently and
// the service simply started out of order.
const runnableSchema = z
  .object({
    name: nonblank,
    cwd: nonblank,
    cmd: nonblank,
    dependsOn: z.array(nonblank).optional(),
    delay: z.number().int().nonnegative().optional(),
    env: envSchema.optional(),
  })
  .strict();

const taskSchema: z.ZodType<Task> = runnableSchema;
const paneSchema: z.ZodType<Pane> = runnableSchema;

const windowSchema: z.ZodType<Window> = z
  .object({
    name: nonblank,
    layout: nonblank.optional(),
    panes: z.array(paneSchema).min(1),
  })
  .strict();

const simpleActionSchema = z
  .object({
    mode: z.literal("simple"),
    // An action with nothing to run is a mistake, not an empty success.
    tasks: z.array(taskSchema).min(1, "must list at least one task"),
  })
  .strict();

const tmuxActionSchema = z
  .object({
    mode: z.literal("tmux"),
    windows: z.array(windowSchema).min(1),
  })
  .strict();

type Located = { item: { name: string; dependsOn?: string[] }; path: Array<string | number> };

/** Every runnable in an action with the path it really lives at. */
function locateEntries(actionName: string, action: Action): Located[] {
  if (action.mode === "simple") {
    return (action.tasks ?? []).map((item, index) => ({ item, path: ["actions", actionName, "tasks", index] }));
  }

  // Flattening panes across windows gave the issue a made-up index; a duplicate in
  // the second window was reported at windows.3 instead of windows.1.panes.0.
  return action.windows.flatMap((window, windowIndex) =>
    window.panes.map((item, paneIndex) => ({
      item,
      path: ["actions", actionName, "windows", windowIndex, "panes", paneIndex],
    })),
  );
}

function addGraphIssues(actionName: string, action: Action, ctx: z.RefinementCtx): void {
  const entries = locateEntries(actionName, action);
  const seen = new Set<string>();

  for (const { item, path } of entries) {
    if (seen.has(item.name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate service name "${item.name}"`, path: [...path, "name"] });
    }

    seen.add(item.name);
  }

  let unknown = false;

  for (const { item, path } of entries) {
    for (const dependency of item.dependsOn ?? []) {
      if (!seen.has(dependency)) {
        unknown = true;
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unknown dependency "${dependency}"`, path: [...path, "dependsOn"] });
      }
    }
  }

  if (unknown) {
    return;
  }

  // A cycle used to pass parsing and only surface at launch, after the tmux
  // session or the first tasks were already created.
  try {
    buildDependencyGraph(entries.map(({ item }) => ({ ...item, cwd: "", cmd: "" })));
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message.replace("\n", ": ") : String(error),
      path: ["actions", actionName],
    });
  }
}

const actionSchema = z.discriminatedUnion("mode", [simpleActionSchema, tmuxActionSchema]);

const configSchema = z
  .object({
    version: z
      .number()
      .int()
      .optional()
      .refine((value) => value === undefined || value <= CURRENT_CONFIG_VERSION, {
        message: `is newer than this spinup understands (up to ${CURRENT_CONFIG_VERSION}); upgrade spinup`,
      })
      .refine((value) => value === undefined || value >= 1, { message: "must be 1 or greater" }),
    name: nonblank,
    root: nonblank,
    default: nonblank,
    actions: z.record(nonblank, actionSchema),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (!config.actions[config.default]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Default action "${config.default}" is not defined in actions.`,
        path: ["default"],
      });
    }

    for (const [actionName, action] of Object.entries(config.actions)) {
      addGraphIssues(actionName, action, ctx);
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

export function stringifyConfig(config: SpinupConfig, comments: Record<string, string> = {}): string {
  const parsed = configSchema.parse(config) as SpinupConfig;

  if (Object.keys(comments).length === 0) {
    return YAML.stringify(parsed);
  }

  // Comments go above each service of the default action, keyed by service name.
  const doc = new YAML.Document(parsed);
  const action = parsed.actions[parsed.default]!;
  const paths: Array<Array<string | number>> =
    action.mode === "tmux"
      ? action.windows.flatMap((window, windowIndex) =>
          window.panes.map((_, paneIndex) => ["actions", parsed.default, "windows", windowIndex, "panes", paneIndex]),
        )
      : (action.tasks ?? []).map((_, index) => ["actions", parsed.default, "tasks", index]);

  for (const at of paths) {
    const node = doc.getIn(at, true);

    if (isMap(node)) {
      const comment = comments[String((node as YAMLMap).get("name"))];

      if (comment) {
        (node as YAMLMap).commentBefore = ` ${comment}`;
      }
    }
  }

  return doc.toString();
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
export async function saveConfig(projectRoot: string, config: SpinupConfig, comments: Record<string, string> = {}): Promise<void> {
  // Serialize first, so a validation failure cannot touch the existing file.
  await writeConfigText(projectRoot, stringifyConfig(config, comments));
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
