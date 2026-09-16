import path from "node:path";

import { CONFIG_FILENAME, configExists, formatConfigError, getConfigPath, loadConfig } from "../core/config.ts";
import { visualizeDependencyGraph } from "../core/dependencies.ts";
import { detectProject } from "../core/detector.ts";
import { loadEnv } from "../core/env.ts";
import { checkTools, inferRequiredTools, validateConfigPaths } from "../core/health.ts";
import { getProject } from "../core/registry.ts";
import { scanProject } from "../core/scanner.ts";
import type { Action, SpinupConfig } from "../types/config.ts";

function requireRegisteredProjectMessage(alias: string): string {
  return `Project alias "${alias}" not registered`;
}

function requireConfigMessage(alias: string): string {
  return `${CONFIG_FILENAME} not found\nRegenerate using:\n\nspinup ${alias} -r`;
}

function getActionServiceCount(action: Action): number {
  if (action.mode === "tmux") {
    return action.windows.reduce((total, window) => total + window.panes.length, 0);
  }

  return action.tasks?.length ?? 0;
}

function printList(values: string[]): void {
  if (values.length === 0) {
    console.log("  (none)");
    return;
  }

  for (const value of values) {
    console.log(`  ${value}`);
  }
}

function formatCheck(installed: boolean): string {
  return installed ? "✓" : "✗";
}

function printBanner(title: string): void {
  const line = "-".repeat(title.length + 4);
  console.log(`+${line}+`);
  console.log(`|  ${title}  |`);
  console.log(`+${line}+\n`);
}

export function printExecutionPlanFromConfig(config: SpinupConfig): void {
  printBanner("Execution Plan");
  const action = config.actions[config.default];
  console.log(`Mode: ${action.mode}\n`);

  if (action.mode === "tmux") {
    for (const window of action.windows) {
      console.log(`Window: ${window.name}`);

      for (const pane of window.panes) {
        console.log(`  pane ${pane.name} -> ${pane.cmd} (${pane.cwd})`);
      }

      console.log("");
    }

    return;
  }

  for (const task of action.tasks ?? []) {
    console.log(`Task: ${task.name} -> ${task.cmd} (${task.cwd})`);
  }
}

function getDefaultActionItems(config: SpinupConfig) {
  const action = config.actions[config.default];
  return action.mode === "tmux" ? action.windows.flatMap((window) => window.panes) : action.tasks ?? [];
}

export async function previewProjectPlan(alias: string): Promise<void> {
  const projectRoot = await getProject(alias);

  if (!projectRoot) {
    throw new Error(requireRegisteredProjectMessage(alias));
  }

  if (!(await configExists(projectRoot))) {
    throw new Error(requireConfigMessage(alias));
  }

  try {
    const config = await loadConfig(projectRoot);
    printExecutionPlanFromConfig(config);
  } catch (error) {
    throw new Error(formatConfigError(error));
  }
}

export async function previewProjectGraph(alias: string): Promise<void> {
  const projectRoot = await getProject(alias);

  if (!projectRoot) {
    throw new Error(requireRegisteredProjectMessage(alias));
  }

  if (!(await configExists(projectRoot))) {
    throw new Error(requireConfigMessage(alias));
  }

  try {
    const config = await loadConfig(projectRoot);
    printBanner("Service Graph");
    console.log(visualizeDependencyGraph(getDefaultActionItems(config)));
  } catch (error) {
    throw new Error(formatConfigError(error));
  }
}

export async function previewProjectEnv(alias: string): Promise<void> {
  const projectRoot = await getProject(alias);

  if (!projectRoot) {
    throw new Error(requireRegisteredProjectMessage(alias));
  }

  if (!(await configExists(projectRoot))) {
    throw new Error(requireConfigMessage(alias));
  }

  try {
    const config = await loadConfig(projectRoot);
    const env = await loadEnv(path.resolve(projectRoot, config.root), config.default);

    printBanner("Environment");
    console.log(`Action: ${config.default}`);
    console.log(`Files:  ${env.files.length > 0 ? env.files.join(", ") : "(none)"}\n`);

    for (const ignoredFile of env.ignored) {
      console.log(`${ignoredFile} is present but not read by action "${config.default}".`);
    }

    if (env.ignored.length > 0) {
      console.log("");
    }

    const entries = Object.keys(env.values).sort((left, right) => left.localeCompare(right));

    if (entries.length === 0) {
      console.log("(no variables)");
      return;
    }

    console.log("Loaded environment variables:\n");

    // Values stay masked; only the key and where it came from are shown.
    for (const key of entries) {
      const origin = env.origins[key];
      const note = env.shadowed.includes(key) ? " (overridden by the shell)" : "";
      console.log(`${key}=*** [${origin}]${note}`);
    }
  } catch (error) {
    throw new Error(formatConfigError(error));
  }
}

export async function doctorProject(alias: string): Promise<void> {
  const projectRoot = await getProject(alias);

  if (!projectRoot) {
    throw new Error(requireRegisteredProjectMessage(alias));
  }

  const configPresent = await configExists(projectRoot);

  if (!configPresent) {
    throw new Error(requireConfigMessage(alias));
  }

  let config;

  try {
    config = await loadConfig(projectRoot);
  } catch (error) {
    throw new Error(formatConfigError(error));
  }

  const scanResult = await scanProject(projectRoot);
  const detection = detectProject(scanResult);
  const actionName = config.default;
  const requiredTools = inferRequiredTools(config, detection, actionName);
  const tools = await checkTools([...new Set(["tmux", "docker", ...requiredTools])]);
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const missingRequired = requiredTools.filter((name) => toolMap.get(name)?.installed !== true);
  const warnings = [
    ...(await validateConfigPaths(projectRoot, config, actionName)),
    ...missingRequired.map((name) => `${name} is required by action "${actionName}" but is not installed.`),
  ];
  const configuredServices = getDefaultActionItems(config).map((item) => item.name);

  printBanner("Project Doctor");
  console.log(`Project: ${alias}`);
  console.log(`Path: ${projectRoot}\n`);

  console.log("Config file:");
  console.log(`  ${getConfigPath(projectRoot)} ${formatCheck(true)}\n`);

  console.log("Stack detection:");
  console.log(`  ${detection.stack} ${formatCheck(detection.stack !== "unknown")}`);
  console.log(`  prisma ${formatCheck(detection.prisma)}`);
  console.log(`  docker ${formatCheck(detection.services.some((service) => service.runtime === "docker"))}\n`);

  console.log("Services detected:");
  printList(configuredServices);
  console.log("");

  if (detection.packageManager) {
    console.log("Package manager:");
    console.log(`  ${detection.packageManager}\n`);
  }

  console.log(`Tmux: ${requiredTools.includes("tmux") ? "required" : "not required"}`);
  console.log(`  installed ${formatCheck(toolMap.get("tmux")?.installed === true)}\n`);

  console.log("Docker:");
  console.log(`  installed ${formatCheck(toolMap.get("docker")?.installed === true)}\n`);

  if (detection.services.some((service) => service.runtime === "docker") && toolMap.get("docker")?.installed !== true) {
    console.log("Docker compose detected but Docker not installed\n");
  }

  console.log("Status:");
  // "ready" previously ignored missing required tools entirely.
  console.log(`  ${warnings.length === 0 ? "ready" : "not ready"}`);

  if (warnings.length > 0) {
    console.log("\nProblems:");
    printList(warnings);
    process.exitCode = 1;
  }

  console.log(`\nDefault action services: ${getActionServiceCount(config.actions[config.default])}`);
}
