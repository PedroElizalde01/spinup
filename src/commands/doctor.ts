import path from "node:path";

import { buildDependencyGraph, startWaves, visualizeDependencyGraph } from "../core/dependencies.ts";
import { detectProject } from "../core/detector.ts";
import { loadEnv } from "../core/env.ts";
import { describeReady } from "../core/readiness.ts";
import { getConfigPath } from "../core/config.ts";
import { checkTools, inferRequiredTools, validateConfigPaths } from "../core/health.ts";
import { scanProject } from "../core/scanner.ts";
import type { Action, SpinupConfig } from "../types/config.ts";
import { emit, EXIT } from "../ui/output.ts";
import { actionEntries, loadProject, resolveActionRoot, selectAction } from "./shared.ts";

type InspectOptions = {
  action?: string;
};

export type PlanStep = {
  name: string;
  cwd: string;
  cmd: string;
  dependsOn: string[];
  delay: number;
  /** When dependents may start, e.g. "port localhost:5432"; null means once started. */
  ready: string | null;
};

export type ExecutionPlan = {
  action: string;
  mode: Action["mode"];
  root: string;
  /** In the order services will be started. */
  order: PlanStep[];
  windows?: Array<{ name: string; layout?: string; panes: string[] }>;
};

function formatCheck(installed: boolean): string {
  return installed ? "✓" : "✗";
}

function printBanner(title: string): void {
  const line = "-".repeat(title.length + 4);
  console.log(`+${line}+`);
  console.log(`|  ${title}  |`);
  console.log(`+${line}+\n`);
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

/**
 * What a launch will do, resolved the same way the launch resolves it: the
 * selected action, its dependency order and every path made absolute.
 */
export function buildExecutionPlan(projectRoot: string, config: SpinupConfig, actionName: string): ExecutionPlan {
  const { action } = selectAction(config, actionName);
  const root = resolveActionRoot(projectRoot, config);
  const order = buildDependencyGraph(actionEntries(action)).map((item) => ({
    name: item.name,
    cwd: path.resolve(root, item.cwd),
    cmd: item.cmd,
    dependsOn: item.dependsOn ?? [],
    delay: item.delay ?? 0,
    ready: item.ready ? describeReady(item.ready) : null,
  }));

  const plan: ExecutionPlan = { action: actionName, mode: action.mode, root, order };

  if (action.mode === "tmux") {
    plan.windows = action.windows.map((window) => ({
      name: window.name,
      layout: window.layout,
      panes: window.panes.map((pane) => pane.name),
    }));
  }

  return plan;
}

export function renderExecutionPlan(plan: ExecutionPlan): void {
  console.log(`Action: ${plan.action} (${plan.mode})`);
  console.log(`Root:   ${plan.root}\n`);
  console.log("Start order:");

  for (const [index, step] of plan.order.entries()) {
    const after = step.dependsOn.length > 0 ? `  after ${step.dependsOn.join(", ")}` : "";
    const ready = step.ready ? `  ready when ${step.ready}` : "";
    const delay = step.delay > 0 ? `  then wait ${step.delay}ms` : "";
    console.log(`  ${index + 1}. ${step.name}${after}${ready}${delay}`);
    console.log(`     cwd ${step.cwd}`);
    console.log(`     ${step.cmd}`);
  }

  if (plan.windows) {
    console.log("\nWindows:");

    for (const window of plan.windows) {
      console.log(`  ${window.name}${window.layout ? ` (${window.layout})` : ""}: ${window.panes.join(", ")}`);
    }
  }
}

export async function previewProjectPlan(alias: string | undefined, options: InspectOptions = {}): Promise<void> {
  const { projectRoot, config } = await loadProject(alias);
  const { actionName } = selectAction(config, options.action);
  const plan = buildExecutionPlan(projectRoot, config, actionName);

  emit(plan, () => {
    printBanner("Execution Plan");
    renderExecutionPlan(plan);
  });
}

export async function previewProjectGraph(alias: string | undefined, options: InspectOptions = {}): Promise<void> {
  const { config } = await loadProject(alias);
  const { actionName, action } = selectAction(config, options.action);
  const entries = actionEntries(action);
  const waves = startWaves(entries);
  const report = {
    action: actionName,
    services: buildDependencyGraph(entries).map((item) => ({
      name: item.name,
      wave: waves.get(item.name)!,
      dependsOn: item.dependsOn ?? [],
      ready: item.ready ? describeReady(item.ready) : null,
    })),
  };

  emit(report, () => {
    printBanner("Service Graph");
    console.log(`Action: ${actionName}\n`);
    console.log(visualizeDependencyGraph(entries));
  });
}

export async function previewProjectEnv(alias: string | undefined, options: InspectOptions = {}): Promise<void> {
  const { projectRoot, config } = await loadProject(alias);
  const { actionName } = selectAction(config, options.action);
  const env = await loadEnv(resolveActionRoot(projectRoot, config), actionName);
  const keys = Object.keys(env.values)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => ({ key, origin: env.origins[key]!, shadowedByShell: env.shadowed.includes(key) }));
  // Values are never part of the report, in either format.
  const report = { action: actionName, files: env.files, ignored: env.ignored, keys };

  emit(report, () => {
    printBanner("Environment");
    console.log(`Action: ${actionName}`);
    console.log(`Files:  ${env.files.length > 0 ? env.files.join(", ") : "(none)"}\n`);

    for (const ignoredFile of env.ignored) {
      console.log(`${ignoredFile} is present but not read by action "${actionName}".`);
    }

    if (env.ignored.length > 0) {
      console.log("");
    }

    if (keys.length === 0) {
      console.log("(no variables)");
      return;
    }

    console.log("Loaded environment variables:\n");

    for (const entry of keys) {
      const note = entry.shadowedByShell ? " (overridden by the shell)" : "";
      console.log(`${entry.key}=*** [${entry.origin}]${note}`);
    }
  });
}

export async function doctorProject(alias: string | undefined, options: InspectOptions = {}): Promise<void> {
  const project = await loadProject(alias);
  const { projectRoot, config } = project;
  const { actionName, action } = selectAction(config, options.action);
  const scanResult = await scanProject(projectRoot);
  const detection = detectProject(scanResult);
  const requiredTools = inferRequiredTools(config, actionName);
  const tools = await checkTools([...new Set(["tmux", "docker", ...requiredTools])]);
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const missingRequired = requiredTools.filter((name) => toolMap.get(name)?.installed !== true);
  const problems = [
    ...(await validateConfigPaths(projectRoot, config, actionName)),
    ...missingRequired.map((name) => `${name} is required by action "${actionName}" but is not installed.`),
  ];
  const services = actionEntries(action).map((item) => item.name);

  const report = {
    alias: project.alias,
    registered: project.registered,
    path: projectRoot,
    configPath: getConfigPath(projectRoot),
    version: config.version ?? 1,
    actions: Object.keys(config.actions),
    defaultAction: config.default,
    action: actionName,
    mode: action.mode,
    services,
    stack: detection.stack,
    packageManager: detection.packageManager ?? null,
    frameworks: detection.frameworks,
    requiredTools,
    // A fresh scan, for comparison with what the config says: origin of each command and anything notable.
    detected: detection.services.map((service) => ({
      name: service.name,
      command: service.command,
      origin: service.origin,
      containers: service.containers ?? [],
    })),
    notes: detection.notes,
    tools: tools.map((tool) => ({
      name: tool.name,
      required: requiredTools.includes(tool.name),
      installed: tool.installed,
      resolvedCommand: tool.resolvedCommand ?? null,
    })),
    problems,
    ready: problems.length === 0,
  };

  if (!report.ready) {
    process.exitCode = EXIT.notReady;
  }

  emit(report, () => {
    printBanner("Project Doctor");
    console.log(`Project: ${project.alias}${project.registered ? "" : " (not registered; from the current directory)"}`);
    console.log(`Path: ${projectRoot}\n`);

    console.log("Config file:");
    console.log(`  ${report.configPath} ${formatCheck(true)}\n`);

    console.log("Actions:");
    printList(report.actions.map((name) => (name === config.default ? `${name} (default)` : name)));
    console.log(`\nInspecting: ${actionName} (${action.mode})\n`);

    console.log("Stack detection:");
    console.log(`  ${detection.stack} ${formatCheck(detection.stack !== "unknown")}`);
    console.log(`  frameworks ${detection.frameworks.length > 0 ? detection.frameworks.join(", ") : "(none)"}\n`);

    console.log("A fresh scan would generate:");
    printList(report.detected.map((service) => `${service.name}: ${service.command}  (${service.origin})`));

    if (report.notes.length > 0) {
      console.log("\nNotes:");
      printList(report.notes);
    }

    console.log("");

    console.log("Services in this action:");
    printList(services);
    console.log("");

    if (detection.packageManager) {
      console.log("Package manager:");
      console.log(`  ${detection.packageManager}\n`);
    }

    console.log(`Tmux: ${requiredTools.includes("tmux") ? "required" : "not required"}`);
    console.log(`  installed ${formatCheck(toolMap.get("tmux")?.installed === true)}\n`);

    console.log(`Docker: ${requiredTools.includes("docker") ? "required" : "not required"}`);
    console.log(`  installed ${formatCheck(toolMap.get("docker")?.installed === true)}\n`);

    console.log("Status:");
    console.log(`  ${report.ready ? "ready" : "not ready"}`);

    if (problems.length > 0) {
      console.log("\nProblems:");
      printList(problems);
    }
  });
}
