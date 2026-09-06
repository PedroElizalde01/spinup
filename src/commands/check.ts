import { CONFIG_FILENAME, configExists, formatConfigError, loadConfig } from "../core/config.ts";
import { detectProject } from "../core/detector.ts";
import { checkDocker, checkTools, collectToolWarnings, inferRequiredTools, validateConfigPaths } from "../core/health.ts";
import { getProject } from "../core/registry.ts";
import { scanProject } from "../core/scanner.ts";

function requireRegisteredProjectMessage(alias: string): string {
  return `Project alias "${alias}" not registered`;
}

function requireConfigMessage(alias: string): string {
  return `${CONFIG_FILENAME} not found\nRegenerate using:\n\nspinup ${alias} -r`;
}

export async function checkProject(alias: string): Promise<void> {
  const projectRoot = await getProject(alias);

  if (!projectRoot) {
    throw new Error(requireRegisteredProjectMessage(alias));
  }

  if (!(await configExists(projectRoot))) {
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
  const tools = await checkTools(inferRequiredTools(config, detection, actionName));
  const pathProblems = await validateConfigPaths(projectRoot, config, actionName);
  const toolProblems = collectToolWarnings(detection, tools);
  const docker = tools.some((tool) => tool.name === "docker") ? await checkDocker() : undefined;

  console.log("+--------------------+");
  console.log("| Environment Check  |");
  console.log("+--------------------+\n");

  console.log(`Action: ${actionName}\n`);

  for (const tool of tools) {
    const resolved = tool.resolvedCommand && tool.resolvedCommand !== tool.name ? ` (${tool.resolvedCommand})` : "";
    console.log(`${tool.name}${resolved} ${tool.installed ? "✓" : "✗"}`);
  }

  if (docker?.cli) {
    console.log(`docker compose ${docker.compose ? "✓" : "✗"}`);
    console.log(`docker daemon ${docker.daemon ? "✓" : "✗"}`);
  }

  if (docker?.cli && !docker.compose) {
    toolProblems.push("The Docker CLI is installed but the Compose plugin is not.");
  }

  if (docker?.cli && !docker.daemon) {
    toolProblems.push("The Docker daemon is not reachable.");
  }

  const problems = [...toolProblems, ...pathProblems];

  if (problems.length > 0) {
    console.log("\nProblems:");

    for (const problem of problems) {
      console.log(`  ${problem}`);
    }

    // A diagnostic that reports a broken environment must not exit 0; scripts and
    // CI rely on the status, not the text.
    console.log(`\n${problems.length} problem(s) found.`);
    process.exitCode = 1;
    return;
  }

  console.log("\nReady.");
}
