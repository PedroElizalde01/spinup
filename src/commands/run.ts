import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { CONFIG_FILENAME, configExists, getConfigPath, loadConfig, saveConfig, stringifyConfig } from "../core/config.ts";
import { buildDependencyGraph } from "../core/dependencies.ts";
import { detectProject } from "../core/detector.ts";
import { loadEnv } from "../core/env.ts";
import { executeAction } from "../core/executor.ts";
import { generateConfig } from "../core/generator.ts";
import { confirmAction } from "../core/interactive.ts";
import { getProject, registerProject, validateAlias } from "../core/registry.ts";
import { scanProject } from "../core/scanner.ts";
import { createShim, getShimPath } from "../core/shim.ts";
import type { Action, Pane, SpinupConfig, Task } from "../types/config.ts";
import { GLYPH } from "../ui/brand.ts";

type RunProjectOptions = {
  regenerate?: boolean;
  start?: boolean;
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
const COLOR_ENABLED = process.stdout.isTTY && process.env.NO_COLOR === undefined;

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
  env: string;
};

function describeService(item: Task | Pane): ServiceShape {
  return {
    cwd: item.cwd,
    cmd: item.cmd,
    dependsOn: (item.dependsOn ?? []).join(", ") || "none",
    delay: item.delay === undefined ? "none" : String(item.delay),
    env: Object.keys(item.env ?? {}).sort().join(", ") || "none",
  };
}

function collectServices(action: Action): Map<string, ServiceShape> {
  const items = action.mode === "tmux" ? action.windows.flatMap((window) => window.panes) : action.tasks ?? [];
  return new Map(items.map((item) => [item.name, describeService(item)]));
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

      for (const field of Object.keys(nextShape) as Array<keyof ServiceShape>) {
        if (currentShape[field] !== nextShape[field]) {
          changes.push(`~ ${actionName}.${name}.${field}: ${currentShape[field]} -> ${nextShape[field]}`);
        }
      }
    }

    for (const name of currentServices.keys()) {
      if (!nextServices.has(name)) {
        changes.push(`- ${actionName}.${name}`);
      }
    }
  }

  return changes;
}

async function regenerateWithPreview(alias: string, projectRoot: string): Promise<void> {
  const scanResult = await scanProject(projectRoot);
  const detection = detectProject(scanResult);
  const nextConfig = generateConfig(scanResult, alias);
  const currentYaml = await readFile(getConfigPath(projectRoot), "utf8");
  const currentConfig = await loadConfig(projectRoot);
  const diffLines = formatProposedChanges(currentConfig, nextConfig);
  const identical = stringifyConfig(nextConfig) === currentYaml;

  console.log("[scan] scanning project\n");
  logDetection(detection);
  console.log("\n[config] proposed changes:\n");

  if (diffLines.length === 0) {
    // Structurally equal, but the file may still differ in comments or formatting;
    // regeneration would discard those, so say so rather than claiming no changes.
    console.log(identical ? "(no changes)\n" : "(no structural changes; regenerating would still rewrite comments and formatting)\n");

    if (identical) {
      return;
    }
  }

  for (const line of diffLines) {
    console.log(line);
  }

  console.log("");

  if (!(await confirmAction("Apply changes?", false))) {
    console.log("[config] regeneration cancelled");
    return;
  }

  await saveConfig(projectRoot, nextConfig);
  console.log(`[config] updated ${CONFIG_FILENAME}\n`);
}

async function bootstrapProject(
  alias: string,
  projectRoot: string,
  overwriteConfig: boolean,
  options: BootstrapProjectOptions = {},
): Promise<void> {
  if (overwriteConfig) {
    await scanAndGenerate(alias, projectRoot, { quiet: options.quiet });
  }

  // Create the shim first. It is the step that can legitimately refuse -- a name
  // collision or a file spinup does not own -- and registering beforehand would
  // leave a successful-looking entry with no runnable command behind it.
  await createShim(alias);
  await registerProject(alias, projectRoot);
}

async function ensureProjectReady(alias: string, options: RunProjectOptions): Promise<EnsureProjectReadyResult> {
  const registeredProjectRoot = await getProject(validateAlias(alias));
  const projectRoot = registeredProjectRoot ? path.resolve(registeredProjectRoot) : process.cwd();
  const hasConfig = await configExists(projectRoot);

  if (!registeredProjectRoot) {
    await bootstrapProject(alias, projectRoot, !hasConfig || Boolean(options.regenerate), { quiet: true });
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
  if (!COLOR_ENABLED || value.length === 0) {
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

async function startConfiguredProject(alias: string, projectRoot: string): Promise<void> {
  const config = await loadConfig(projectRoot);
  const action = config.actions[config.default];
  // Environment files live next to the action's root, not necessarily the
  // directory the project was registered from.
  const env = await loadEnv(path.resolve(projectRoot, config.root), config.default);

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

  await executeAction(projectRoot, config, config.default, {
    environment: env.applied,
    sessionName: alias,
  });
}

export async function runProject(alias: string, options: RunProjectOptions = {}): Promise<void> {
  const { projectRoot, bootstrapped } = await ensureProjectReady(alias, options);

  if (options.start) {
    await startConfiguredProject(alias, projectRoot);
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
