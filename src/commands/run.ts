import { readFile } from "node:fs/promises";
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
import { loadEnv } from "../core/env.ts";
import { executeAction } from "../core/executor.ts";
import { generateConfig } from "../core/generator.ts";
import { confirmAction } from "../core/interactive.ts";
import { getProject, registerProject, validateAlias } from "../core/registry.ts";
import { scanProject } from "../core/scanner.ts";
import { createShim, getShimPath, removeShim } from "../core/shim.ts";
import { colorEnabled } from "../ui/output.ts";
import { buildExecutionPlan, renderExecutionPlan } from "./doctor.ts";
import { selectAction, sessionNameFor } from "./shared.ts";
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
};

type EnsureProjectReadyResult = {
  projectRoot: string;
  bootstrapped: boolean;
};

type ScanAndGenerateOptions = {
  quiet?: boolean;
};

type BootstrapProjectOptions = {
  quiet?: boolean;
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

  const serviceNames = [
    ...detection.services.map((service) => service.name),
  ];
  logList("Services", serviceNames);
}

async function scanAndGenerate(alias: string, projectRoot: string, options: ScanAndGenerateOptions = {}): Promise<void> {
  const scanResult = await scanProject(projectRoot);
  const detection = detectProject(scanResult);
  const config = generateConfig(scanResult, alias);

  if (!options.quiet) {
    console.log("[scan] scanning project\n");
    logDetection(detection);
    console.log(`\n[config] generating optimized ${CONFIG_FILENAME}`);
  }

  await saveConfig(projectRoot, config);

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
async function regenerateWithPreview(alias: string, projectRoot: string): Promise<void> {
  const scanResult = await scanProject(projectRoot);
  const detection = detectProject(scanResult);
  const nextConfig = generateConfig(scanResult, alias);
  const configPath = getConfigPath(projectRoot);
  const currentYaml = await readFile(configPath, "utf8");
  const currentConfig = await loadConfig(projectRoot);
  const diffLines = formatProposedChanges(currentConfig, nextConfig);
  const identical = stringifyConfig(nextConfig) === currentYaml;

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

  if (!process.stdin.isTTY) {
    // Fail closed: no prompt means no consent.
    throw new Error("Regenerating replaces the project config and needs confirmation. Run this in a terminal.");
  }

  if (!(await confirmAction("Replace the config?", false))) {
    console.log("[config] regeneration cancelled");
    return;
  }

  const backupPath = await backupConfig(projectRoot);
  await saveConfig(projectRoot, nextConfig);
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
  configMode: "keep" | "generate" | "regenerate",
  options: BootstrapProjectOptions = {},
): Promise<void> {
  const outcome = await createShim(alias);

  try {
    if (configMode === "generate") {
      await scanAndGenerate(alias, projectRoot, { quiet: options.quiet });
    } else if (configMode === "regenerate") {
      // An unregistered project with a config gets the same preview and consent.
      await regenerateWithPreview(alias, projectRoot);
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
  const projectRoot = registeredProjectRoot ? path.resolve(registeredProjectRoot) : process.cwd();
  const hasConfig = await configExists(projectRoot);

  if (!registeredProjectRoot && options.start) {
    // A launch never registers: an orphaned wrapper must not adopt whatever
    // directory it happened to be run from.
    throw new Error(`Project alias "${alias}" is not registered. Register it from its directory with: spinup ${alias}`);
  }

  if (!registeredProjectRoot) {
    const configMode = !hasConfig ? "generate" : options.regenerate ? "regenerate" : "keep";
    await bootstrapProject(alias, projectRoot, configMode, { quiet: true });
    return {
      projectRoot,
      bootstrapped: true,
    };
  }

  if (options.regenerate && hasConfig) {
    await regenerateWithPreview(alias, projectRoot);
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

function wrapText(value: string, width: number): string[] {
  if (visibleLength(value) <= width) {
    return [value];
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

function printSetupCard(
  alias: string,
  projectRoot: string,
  config: SpinupConfig,
  detection: ReturnType<typeof detectProject>,
  status: "registered" | "already registered",
): void {
  const shimPath = compactHome(getShimPath(alias));
  const action = config.actions[config.default];
  const statusColor = status === "registered" ? ANSI.green : ANSI.yellow;
  const rows = [
    border("top"),
    line(colorize(`  ${GLYPH[0]}`, ANSI.bold, ANSI.cyan)),
    line(colorize(`  ${GLYPH[1]}`, ANSI.bold, ANSI.cyan)),
    line(),
    ...field("alias", colorize(alias, ANSI.bold, ANSI.white)),
    ...field("status", colorize(status, ANSI.bold, statusColor)),
    ...field("command", colorize(shimPath, ANSI.white)),
    ...field("root", colorize(compactHome(projectRoot), ANSI.white)),
    border("middle"),
    ...field("stack", colorize(detection.stack, ANSI.bold, ANSI.white)),
    ...field("package", colorize(detection.packageManager ?? "unknown", ANSI.white)),
    ...field("frameworks", colorize(formatList(detection.frameworks), ANSI.white)),
    ...field("services", colorize(formatList(detection.services.map((service) => service.name)), ANSI.white)),
    border("middle"),
    ...field("actions", colorize(Object.keys(config.actions).map((name) => (name === config.default ? `${name} (default)` : name)).join(", "), ANSI.white)),
    ...summarizeAction(config.default, action).flatMap(([label, value]) =>
      field(label, colorize(value, label === "mode" ? ANSI.bold : ANSI.white, label === "mode" && value === "tmux" ? ANSI.cyan : ANSI.white)),
    ),
    border("middle"),
    ...field("next", colorize(alias, ANSI.bold, ANSI.green)),
    border("bottom"),
  ];

  for (const row of rows) {
    console.log(row);
  }
}

async function startConfiguredProject(alias: string, projectRoot: string, options: RunProjectOptions): Promise<void> {
  const config = await loadConfig(projectRoot);
  const { actionName, action } = selectAction(config, options.action);
  // Environment files live next to the action's root, not necessarily the
  // directory the project was registered from.
  const env = await loadEnv(path.resolve(projectRoot, config.root), actionName);

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

  if (action.mode !== "tmux") {
    console.log("[run] starting dev environment...");
  }

  await executeAction(projectRoot, config, actionName, {
    environment: env.applied,
    sessionName: sessionNameFor(alias, config, actionName),
  });
}

export async function runProject(alias: string, options: RunProjectOptions = {}): Promise<void> {
  const { projectRoot, bootstrapped } = await ensureProjectReady(alias, options);

  if (options.start) {
    await startConfiguredProject(alias, projectRoot, options);
    return;
  }

  const config = await loadConfig(projectRoot);
  const detection = detectProject(await scanProject(projectRoot));

  if (bootstrapped) {
    printSetupCard(alias, projectRoot, config, detection, "registered");
    return;
  }

  printSetupCard(alias, projectRoot, config, detection, "already registered");
}
