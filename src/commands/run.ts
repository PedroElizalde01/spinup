import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  backupConfig,
  CONFIG_FILENAME,
  configExists,
  formatConfigError,
  getConfigPath,
  loadConfig as loadConfigRaw,
  saveConfig,
  stringifyConfig,
} from "../core/config.ts";
import { buildDependencyGraph } from "../core/dependencies.ts";
import { detectProject } from "../core/detector.ts";
import { executeAction } from "../core/executor.ts";
import type { ProjectDetection } from "../core/detectors/types.ts";
import { generateConfig, generatedComments } from "../core/generator.ts";
import { confirmAction, promptForCommand } from "../core/interactive.ts";
import { getProject, registerProject, validateAlias } from "../core/registry.ts";
import { directoriesMissingNodeModules, scanProject } from "../core/scanner.ts";
import { logDirectory } from "../core/logs.ts";
import { claimedPorts, describeBusyPort, findBusyPorts } from "../core/ports.ts";
import { createShim, getShimPath, removeShim } from "../core/shim.ts";
import { colorEnabled } from "../ui/output.ts";
import { buildExecutionPlan, renderExecutionPlan } from "./doctor.ts";
import { canonicalProject } from "../tmux/session.ts";
import { resolveLaunchEnvironment, selectAction, sessionNameFor } from "./shared.ts";
import type { Action, Pane, SpinupConfig, Task } from "../types/config.ts";
import { GLYPH } from "../ui/brand.ts";

/** A config problem is a user-facing message, not a serialized issue list. */
async function loadConfig(projectRoot: string): Promise<SpinupConfig> {
  try {
    return await loadConfigRaw(projectRoot);
  } catch (error) {
    throw new Error(formatConfigError(error));
  }
}

type RunProjectOptions = {
  regenerate?: boolean;
  start?: boolean;
  action?: string;
  dryRun?: boolean;
  logs?: boolean;
  /** Register or relink this directory instead of the current one. */
  path?: string;
  /** Answer yes to confirmations; required for them without a terminal. */
  yes?: boolean;
};

/**
 * Consent for a change that replaces something. --yes gives it up front; without a
 * terminal and without --yes, there is nobody to ask, so the answer is no.
 */
async function consent(question: string, yes: boolean | undefined, refusal: string): Promise<boolean> {
  if (yes) {
    return true;
  }

  if (!process.stdin.isTTY) {
    throw new Error(`${refusal} Run this in a terminal to confirm, or pass --yes.`);
  }

  return confirmAction(question, false);
}

/** An existing directory, resolved; the error names the path as given. */
export async function resolveDirectory(target: string): Promise<string> {
  const resolved = path.resolve(target);

  try {
    if ((await stat(resolved)).isDirectory()) {
      return resolved;
    }
  } catch {
    // Reported below.
  }

  throw new Error(`${target} is not a directory.`);
}

type EnsureProjectReadyResult = {
  projectRoot: string;
  bootstrapped: boolean;
};

type ScanAndGenerateOptions = {
  quiet?: boolean;
};

type BootstrapProjectOptions = {
  quiet?: boolean;
  yes?: boolean;
};

const BOX_WIDTH = 62;
const BOX_INNER_WIDTH = BOX_WIDTH - 2;
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  white: "\x1b[37m",
};

function logList(title: string, values: string[]): void {
  console.log(`[detect] ${title.toLowerCase()}:`);

  if (values.length === 0) {
    console.log("  - none");
    return;
  }

  for (const value of values) {
    console.log(`  - ${value}`);
  }
}

function logDetection(detection: ReturnType<typeof detectProject>): void {
  console.log(`[detect] stack: ${detection.stack}`);

  if (detection.packageManager) {
    console.log(`[detect] package manager: ${detection.packageManager}`);
  }

  logList("Frameworks", detection.frameworks);
  // Each command says where it came from, so a wrong guess is easy to trace.
  logList(
    "Services",
    detection.services.map((service) => `${service.name}: ${service.command}  (${service.origin})`),
  );

  for (const note of detection.notes) {
    console.log(`[detect] note: ${note}`);
  }
}

type Generated = {
  detection: ProjectDetection;
  config: SpinupConfig;
  comments: Record<string, string>;
};

/**
 * Scans and builds a config. When nothing runnable is found, a terminal user is
 * asked for the command; otherwise it fails. A guessed "npm start" used to be
 * written and registered as though it had been detected.
 */
async function detectAndGenerate(alias: string, projectRoot: string, allowPrompt: boolean): Promise<Generated> {
  const scanResult = await scanProject(projectRoot);
  const detection = detectProject(scanResult);

  if (detection.services.length === 0) {
    if (!allowPrompt || !process.stdin.isTTY) {
      throw new Error(
        `No development command was detected in ${projectRoot}.\n` +
          `Create ${CONFIG_FILENAME} there with the command to run, or run "spinup ${alias}" in a terminal to enter it.` +
          (detection.notes.length > 0 ? `\n\n${detection.notes.join("\n")}` : ""),
      );
    }

    for (const note of detection.notes) {
      console.log(`[detect] note: ${note}`);
    }

    const command = await promptForCommand("No development command was detected. Command to start this project:");
    detection.services.push({ name: "app", path: ".", command, runtime: "launcher", origin: "entered at registration" });
  }

  return {
    detection,
    config: generateConfig(scanResult, alias, detection),
    comments: generatedComments(detection),
  };
}

async function scanAndGenerate(alias: string, projectRoot: string, options: ScanAndGenerateOptions = {}): Promise<void> {
  if (!options.quiet) {
    console.log("[scan] scanning project\n");
  }

  const { detection, config, comments } = await detectAndGenerate(alias, projectRoot, true);

  if (!options.quiet) {
    logDetection(detection);
    console.log(`\n[config] generating ${CONFIG_FILENAME}`);
  }

  await saveConfig(projectRoot, config, comments);

  if (!options.quiet) {
    console.log(`[config] generated ${CONFIG_FILENAME}\n`);
  }
}

type ServiceShape = {
  cwd: string;
  cmd: string;
  dependsOn: string;
  delay: string;
  env: Record<string, string>;
};

function describeService(item: Task | Pane): ServiceShape {
  return {
    cwd: item.cwd,
    cmd: item.cmd,
    dependsOn: (item.dependsOn ?? []).join(", ") || "none",
    delay: item.delay === undefined ? "none" : String(item.delay),
    env: item.env ?? {},
  };
}

function actionItems(action: Action): Array<Task | Pane> {
  return action.mode === "tmux" ? action.windows.flatMap((window) => window.panes) : action.tasks ?? [];
}

function collectServices(action: Action): Map<string, ServiceShape> {
  return new Map(actionItems(action).map((item) => [item.name, describeService(item)]));
}

/** Window identity for the preview: name, layout and pane membership, in order. */
function describeWindows(action: Action): string {
  if (action.mode !== "tmux") {
    return "";
  }

  return action.windows
    .map((window) => `${window.name}${window.layout ? `(${window.layout})` : ""}: ${window.panes.map((pane) => pane.name).join(", ")}`)
    .join(" | ");
}

/** Reports which keys changed, never their values: the config can hold secrets. */
function describeEnvChanges(current: Record<string, string>, next: Record<string, string>): string[] {
  const changes: string[] = [];

  for (const key of Object.keys(next).sort()) {
    if (!(key in current)) {
      changes.push(`+ env.${key}`);
    } else if (current[key] !== next[key]) {
      changes.push(`~ env.${key} (value changed)`);
    }
  }

  for (const key of Object.keys(current).sort()) {
    if (!(key in next)) {
      changes.push(`- env.${key}`);
    }
  }

  return changes;
}

/**
 * Compares configurations by structure. The previous implementation diffed sets of
 * trimmed lines, which ignored ordering and collapsed duplicates: swapping the
 * commands of two services produced an empty result, so a real change was reported
 * as "no changes" and never applied.
 */
export function formatProposedChanges(current: SpinupConfig, next: SpinupConfig): string[] {
  const changes: string[] = [];
  const actionNames = [...new Set([...Object.keys(current.actions), ...Object.keys(next.actions)])].sort();

  for (const key of ["name", "root", "default"] as const) {
    if (current[key] !== next[key]) {
      changes.push(`~ ${key}: ${current[key]} -> ${next[key]}`);
    }
  }

  for (const actionName of actionNames) {
    const currentAction = current.actions[actionName];
    const nextAction = next.actions[actionName];

    if (!currentAction) {
      changes.push(`+ action ${actionName}`);
      continue;
    }

    if (!nextAction) {
      changes.push(`- action ${actionName} (removed; any customization is lost)`);
      continue;
    }

    if (currentAction.mode !== nextAction.mode) {
      changes.push(`~ action ${actionName}: mode ${currentAction.mode} -> ${nextAction.mode}`);
    }

    const currentServices = collectServices(currentAction);
    const nextServices = collectServices(nextAction);

    for (const [name, nextShape] of nextServices) {
      const currentShape = currentServices.get(name);

      if (!currentShape) {
        changes.push(`+ ${actionName}.${name} -> ${nextShape.cmd} (${nextShape.cwd})`);
        continue;
      }

      for (const field of ["cwd", "cmd", "dependsOn", "delay"] as const) {
        if (currentShape[field] !== nextShape[field]) {
          changes.push(`~ ${actionName}.${name}.${field}: ${currentShape[field]} -> ${nextShape[field]}`);
        }
      }

      for (const envChange of describeEnvChanges(currentShape.env, nextShape.env)) {
        changes.push(`${envChange.slice(0, 2)}${actionName}.${name}.${envChange.slice(2)}`);
      }
    }

    for (const name of currentServices.keys()) {
      if (!nextServices.has(name)) {
        changes.push(`- ${actionName}.${name}`);
      }
    }

    // Same members in a different order still changes start order and pane placement.
    const currentOrder = actionItems(currentAction).map((item) => item.name);
    const nextOrder = actionItems(nextAction).map((item) => item.name);

    if (
      currentOrder.length === nextOrder.length &&
      currentOrder.every((name) => nextServices.has(name)) &&
      currentOrder.join(",") !== nextOrder.join(",")
    ) {
      changes.push(`~ ${actionName}: order ${currentOrder.join(", ")} -> ${nextOrder.join(", ")}`);
    }

    const currentWindows = describeWindows(currentAction);
    const nextWindows = describeWindows(nextAction);

    if (currentWindows !== nextWindows && currentAction.mode === "tmux" && nextAction.mode === "tmux") {
      changes.push(`~ ${actionName}.windows: ${currentWindows} -> ${nextWindows}`);
    }
  }

  return changes;
}

/**
 * The single path for replacing an existing config, registered or not. It shows
 * what changes, says what the preview cannot express, requires an explicit yes,
 * and keeps the previous bytes in a private backup before writing.
 */
async function regenerateWithPreview(alias: string, projectRoot: string, yes?: boolean): Promise<void> {
  // Never prompt here: replacing a working config with a typed-in guess is not a regeneration.
  const { detection, config: nextConfig, comments } = await detectAndGenerate(alias, projectRoot, false);
  const configPath = getConfigPath(projectRoot);
  const currentYaml = await readFile(configPath, "utf8");
  const currentConfig = await loadConfig(projectRoot);
  const diffLines = formatProposedChanges(currentConfig, nextConfig);
  const identical = stringifyConfig(nextConfig, comments) === currentYaml;

  console.log("[scan] scanning project\n");
  logDetection(detection);
  console.log("\n[config] proposed changes:\n");

  if (identical) {
    console.log("(no changes)\n");
    return;
  }

  if (diffLines.length === 0) {
    // Structurally equal, but the file still differs in comments or formatting;
    // regeneration would discard those, so say so rather than claiming no changes.
    console.log("(no structural changes; regenerating would still rewrite comments and formatting)\n");
  }

  for (const line of diffLines) {
    console.log(line);
  }

  console.log("");
  console.log(`[config] regenerating replaces ${path.basename(configPath)} entirely.`);
  console.log("[config] custom actions, comments and formatting not listed above are lost.\n");

  if (!(await consent("Replace the config?", yes, "Regenerating replaces the project config and needs confirmation."))) {
    console.log("[config] regeneration cancelled");
    return;
  }

  const backupPath = await backupConfig(projectRoot);
  await saveConfig(projectRoot, nextConfig, comments);
  console.log(`[config] updated ${CONFIG_FILENAME} (previous copy in ${path.basename(backupPath)})\n`);
}

/**
 * Registers an alias for a project directory. Exported for the out-of-process
 * contention test; the CLI reaches it through runProject.
 *
 * The shim comes first: it is the step that can legitimately refuse (a name on
 * PATH, a file spinup does not own), and refusing before the project config is
 * written means a rejected alias leaves the project untouched. If anything after
 * it fails, a wrapper this call created is removed again, so no runnable command
 * is left behind without a registry entry. A wrapper that already existed is kept.
 */
export async function bootstrapProject(
  alias: string,
  projectRoot: string,
  configMode: "keep" | "generate" | "regenerate" | { config: SpinupConfig; comments: Record<string, string> },
  options: BootstrapProjectOptions = {},
): Promise<void> {
  const outcome = await createShim(alias);

  try {
    if (typeof configMode === "object") {
      // Already reviewed by the user, as with --init.
      await saveConfig(projectRoot, configMode.config, configMode.comments);
    } else if (configMode === "generate") {
      await scanAndGenerate(alias, projectRoot, { quiet: options.quiet });
    } else if (configMode === "regenerate") {
      // An unregistered project with a config gets the same preview and consent.
      await regenerateWithPreview(alias, projectRoot, options.yes);
    }

    await registerProject(alias, projectRoot);
  } catch (error) {
    if (outcome === "created") {
      await removeShim(alias).catch(() => undefined);
    }

    throw error;
  }
}

async function ensureProjectReady(alias: string, options: RunProjectOptions): Promise<EnsureProjectReadyResult> {
  const registeredProjectRoot = await getProject(validateAlias(alias));
  const requested = options.path ? await resolveDirectory(options.path) : undefined;

  if (registeredProjectRoot && requested && (await canonicalProject(requested)) !== (await canonicalProject(registeredProjectRoot))) {
    throw new Error(
      `"${alias}" is already registered for ${registeredProjectRoot}.\n` +
        `To point it at ${requested}, run: spinup ${alias} --relink --path ${requested}`,
    );
  }

  const projectRoot = registeredProjectRoot ? path.resolve(registeredProjectRoot) : (requested ?? process.cwd());
  const hasConfig = await configExists(projectRoot);

  if (!registeredProjectRoot && options.start) {
    // A launch never registers: an orphaned wrapper must not adopt whatever
    // directory it happened to be run from.
    throw new Error(`Project alias "${alias}" is not registered. Register it from its directory with: spinup ${alias}`);
  }

  if (!registeredProjectRoot) {
    const configMode = !hasConfig ? "generate" : options.regenerate ? "regenerate" : "keep";
    await bootstrapProject(alias, projectRoot, configMode, { quiet: true, yes: options.yes });
    return {
      projectRoot,
      bootstrapped: true,
    };
  }

  if (options.regenerate && hasConfig) {
    await regenerateWithPreview(alias, projectRoot, options.yes);
  } else if (options.regenerate || !hasConfig) {
    await scanAndGenerate(alias, projectRoot);
  }

  // Refresh the shim so older aliases pick up the current launcher behavior.
  await createShim(alias);

  return {
    projectRoot,
    bootstrapped: false,
  };
}

function compactHome(projectPath: string): string {
  const home = homedir();
  return projectPath.startsWith(home) ? projectPath.replace(home, "~") : projectPath;
}

function colorize(value: string, ...codes: string[]): string {
  if (!colorEnabled() || value.length === 0) {
    return value;
  }

  return `${codes.join("")}${value}${ANSI.reset}`;
}

function visibleLength(value: string): number {
  return value.replace(ANSI_PATTERN, "").length;
}

function padVisible(value: string, width: number): string {
  const padding = Math.max(0, width - visibleLength(value));
  return `${value}${" ".repeat(padding)}`;
}

function frame(value: string): string {
  return colorize(value, ANSI.dim, ANSI.cyan);
}

function border(kind: "top" | "middle" | "bottom"): string {
  if (kind === "top") {
    return frame(`┌${"─".repeat(BOX_INNER_WIDTH)}┐`);
  }

  if (kind === "bottom") {
    return frame(`└${"─".repeat(BOX_INNER_WIDTH)}┘`);
  }

  return frame(`├${"─".repeat(BOX_INNER_WIDTH)}┤`);
}

function line(value = ""): string {
  return `${frame("│")}${padVisible(value, BOX_INNER_WIDTH)}${frame("│")}`;
}

export function wrapText(value: string, width: number): string[] {
  if (visibleLength(value) <= width) {
    return [value];
  }

  // A value with no separator, such as a long path, is broken hard; otherwise it
  // ran past the card's right border.
  if (!value.includes(", ")) {
    const plain = value.replace(ANSI_PATTERN, "");
    const chunks: string[] = [];

    for (let index = 0; index < plain.length; index += width) {
      chunks.push(plain.slice(index, index + width));
    }

    return chunks;
  }

  const words = value.split(", ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current.length === 0 ? word : `${current}, ${word}`;

    if (visibleLength(next) <= width) {
      current = next;
      continue;
    }

    if (current.length > 0) {
      lines.push(current);
    }

    current = word;
  }

  if (current.length > 0) {
    lines.push(current);
  }

  return lines;
}

function field(label: string, value: string): string[] {
  const labelWidth = 10;
  const valueWidth = BOX_INNER_WIDTH - 2 - labelWidth;
  const wrapped = wrapText(value, valueWidth);
  const coloredLabel = colorize(label, ANSI.dim, ANSI.blue);

  return wrapped.map((entry, index) =>
    line(` ${index === 0 ? padVisible(coloredLabel, labelWidth) : " ".repeat(labelWidth)} ${entry}`),
  );
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

function summarizeAction(actionName: string, action: Action): Array<[string, string]> {
  if (action.mode === "tmux") {
    const windows = action.windows.map((window) => window.name);
    const panes = action.windows.flatMap((window) => window.panes.map((pane) => pane.name));
    const layouts = [...new Set(action.windows.map((window) => window.layout).filter(Boolean))] as string[];

    return [
      ["action", actionName],
      ["mode", "tmux"],
      ["windows", `${action.windows.length} (${formatList(windows)})`],
      ["panes", `${panes.length} (${formatList(panes)})`],
      ["layout", formatList(layouts)],
    ];
  }

  const tasks = action.tasks ?? [];

  return [
    ["action", actionName],
    ["mode", "simple"],
    ["tasks", `${tasks.length} (${formatList(tasks.map((task) => task.name))})`],
  ];
}

/** The card `spinup <alias>` prints after registering, for flows that register another way. */
export async function printRegistered(alias: string, projectRoot: string): Promise<void> {
  printSetupCard(alias, projectRoot, await loadConfig(projectRoot), detectProject(await scanProject(projectRoot)), "registered");
}

export type SetupCard = Array<Array<[label: string, value: string]>>;

/**
 * The card's content, separate from how a terminal draws it. The website renders
 * the same data (scripts/site-hero-card.ts), so its hero cannot drift from the CLI.
 */
export function buildSetupCard(
  alias: string,
  projectRoot: string,
  config: SpinupConfig,
  detection: ReturnType<typeof detectProject>,
  status: "registered" | "already registered",
): SetupCard {
  return [
    [
      ["alias", alias],
      ["status", status],
      ["command", compactHome(getShimPath(alias))],
      ["root", compactHome(projectRoot)],
    ],
    [
      ["stack", detection.stack],
      ["package", detection.packageManager ?? "unknown"],
      ["frameworks", formatList(detection.frameworks)],
      ["services", formatList(detection.services.map((service) => service.name))],
    ],
    [
      ["actions", Object.keys(config.actions).map((name) => (name === config.default ? `${name} (default)` : name)).join(", ")],
      ...summarizeAction(config.default, config.actions[config.default]!),
    ],
    [["next", alias]],
  ];
}

function styleValue(label: string, value: string, status: string): string {
  switch (label) {
    case "alias":
    case "stack":
      return colorize(value, ANSI.bold, ANSI.white);
    case "status":
      return colorize(value, ANSI.bold, status === "registered" ? ANSI.green : ANSI.yellow);
    case "mode":
      return colorize(value, ANSI.bold, value === "tmux" ? ANSI.cyan : ANSI.white);
    case "next":
      return colorize(value, ANSI.bold, ANSI.green);
    default:
      return colorize(value, ANSI.white);
  }
}

function printSetupCard(
  alias: string,
  projectRoot: string,
  config: SpinupConfig,
  detection: ReturnType<typeof detectProject>,
  status: "registered" | "already registered",
): void {
  const sections = buildSetupCard(alias, projectRoot, config, detection, status);
  const rows = [
    border("top"),
    line(colorize(`  ${GLYPH[0]}`, ANSI.bold, ANSI.cyan)),
    line(colorize(`  ${GLYPH[1]}`, ANSI.bold, ANSI.cyan)),
    line(),
    ...sections.flatMap((section, index) => [
      ...(index > 0 ? [border("middle")] : []),
      ...section.flatMap(([label, value]) => field(label, styleValue(label, value, status))),
    ]),
    border("bottom"),
  ];

  for (const row of rows) {
    console.log(row);
  }
}

/** Launches a project's selected action. Used by the alias command, local runs and --restart. */
export async function launchProject(alias: string, projectRoot: string, options: RunProjectOptions): Promise<void> {
  const config = await loadConfig(projectRoot);
  const { actionName, action } = selectAction(config, options.action);
  const { environment, loaded: env } = await resolveLaunchEnvironment(projectRoot, config, actionName);

  if (options.dryRun) {
    // Everything a launch resolves, nothing a launch starts.
    renderExecutionPlan(buildExecutionPlan(projectRoot, config, actionName));
    console.log("\nEnvironment:");
    console.log(`  files: ${env.files.length > 0 ? env.files.join(", ") : "(none)"}`);

    for (const key of Object.keys(env.values).sort()) {
      const note = env.shadowed.includes(key) ? " (overridden by the shell)" : "";
      console.log(`  ${key} [${env.origins[key]}]${note}`);
    }

    if (action.mode === "tmux") {
      console.log(`\ntmux session: ${sessionNameFor(alias, config, actionName)}`);
    }

    const busy = await findBusyPorts(await claimedPorts(projectRoot, path.resolve(projectRoot, config.root), action));

    for (const port of busy) {
      console.log(`[ports] ${describeBusyPort(port)}`);
    }

    console.log("\n[dry-run] nothing was started");
    return;
  }

  console.log(
    env.files.length > 0
      ? `[env] loaded ${env.files.join(", ")}`
      : "[env] no environment files found",
  );

  for (const ignoredFile of env.ignored) {
    console.log(`[env] ignoring ${ignoredFile}; it is only read by an action of that name`);
  }

  if (env.shadowed.length > 0) {
    console.log(`[env] kept shell values for ${env.shadowed.join(", ")}`);
  }

  if (action.mode === "simple") {
    buildDependencyGraph(action.tasks ?? []);
  } else {
    buildDependencyGraph(action.windows.flatMap((window) => window.panes));
  }

  const actionRoot = path.resolve(projectRoot, config.root);
  const taskDirs = (action.mode === "simple" ? (action.tasks ?? []) : action.windows.flatMap((window) => window.panes)).map((task) =>
    path.resolve(actionRoot, task.cwd),
  );

  for (const directory of await directoriesMissingNodeModules(taskDirs)) {
    console.log(`[deps] ${path.relative(projectRoot, directory) || "."} has no node_modules; install its dependencies first`);
  }

  if (action.mode !== "tmux") {
    console.log("[run] starting dev environment...");
  }

  if (options.logs) {
    console.log(`[logs] writing service output to ${logDirectory(alias)}`);
  }

  await executeAction(projectRoot, config, actionName, {
    environment,
    sessionName: sessionNameFor(alias, config, actionName),
    logAlias: options.logs ? alias : undefined,
  });
}

export async function runProject(alias: string, options: RunProjectOptions = {}): Promise<void> {
  const { projectRoot, bootstrapped } = await ensureProjectReady(alias, options);

  if (options.start) {
    await launchProject(alias, projectRoot, options);
    return;
  }

  const config = await loadConfig(projectRoot);
  const detection = detectProject(await scanProject(projectRoot));

  if (bootstrapped) {
    printSetupCard(alias, projectRoot, config, detection, "registered");
    return;
  }

  printSetupCard(alias, projectRoot, config, detection, "already registered");

  // Running `spinup alias` from a moved checkout or another worktree otherwise
  // looks like success while the alias still launches the old directory.
  const here = await canonicalProject(process.cwd());

  if (!options.path && here !== (await canonicalProject(projectRoot)) && (await configExists(process.cwd()))) {
    console.error(`\n"${alias}" still points at ${projectRoot}. To use this directory instead: spinup ${alias} --relink`);
  }
}

/**
 * Points a registered alias at another directory: a moved checkout or a worktree.
 * The generated command is kept, since it names only the alias. A session already
 * running from the old directory belongs to that directory and is left alone.
 */
export async function relinkProject(alias: string, options: RunProjectOptions = {}): Promise<void> {
  const current = await getProject(validateAlias(alias));

  if (!current) {
    throw new Error(`"${alias}" is not registered. Register it with: spinup ${alias}${options.path ? ` --path ${options.path}` : ""}`);
  }

  const target = await resolveDirectory(options.path ?? process.cwd());

  if ((await canonicalProject(target)) === (await canonicalProject(current))) {
    console.log(`"${alias}" already points at ${target}.`);
    return;
  }

  console.log(`"${alias}": ${current}\n     -> ${target}`);

  if (!(await consent(`Point "${alias}" at ${target}?`, options.yes, `Relinking "${alias}" replaces where it points.`))) {
    console.log("Relink cancelled; nothing was changed.");
    return;
  }

  if (!(await configExists(target))) {
    await scanAndGenerate(alias, target);
  }

  // The new directory's config must load before the alias depends on it.
  await loadConfig(target);
  await createShim(alias);
  await registerProject(alias, target);

  console.log(`Relinked "${alias}" to ${target}.`);
  console.log(`A session already running from ${current} is not affected; end it with: tmux kill-session -t =${alias}`);
}
