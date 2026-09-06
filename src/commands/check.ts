import { CONFIG_FILENAME, configExists, formatConfigError, loadConfig } from "../core/config.ts";
import { detectProject } from "../core/detector.ts";
import { checkTools, collectToolWarnings, inferRequiredTools, validateConfigPaths } from "../core/health.ts";
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
  const tools = await checkTools(inferRequiredTools(config, detection));
  const warnings = [
    ...collectToolWarnings(detection, tools),
    ...(await validateConfigPaths(projectRoot, config)),
  ];

  console.log("+--------------------+");
  console.log("| Environment Check  |");
  console.log("+--------------------+\n");

  for (const tool of tools) {
    console.log(`${tool.name} ${tool.installed ? "✓" : "✗"}`);
  }

  if (warnings.length > 0) {
    console.log("\nWarnings:");

    for (const warning of warnings) {
      console.log(warning);
    }
  }
}
