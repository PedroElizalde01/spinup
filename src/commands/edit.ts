import { execa } from "execa";

import { CONFIG_FILENAME, configExists, formatConfigError, getConfigPath, loadConfig, saveConfig } from "../core/config.ts";
import { validateConfigPaths } from "../core/health.ts";
import { promptForConfigEdits } from "../core/interactive.ts";
import { getProject } from "../core/registry.ts";
import type { SpinupConfig } from "../types/config.ts";

type EditProjectOptions = {
  interactive?: boolean;
};

function requireRegisteredProjectMessage(alias: string): string {
  return `Project alias "${alias}" not registered`;
}

function requireConfigMessage(alias: string): string {
  return `${CONFIG_FILENAME} not found\nRegenerate using:\n\nspinup ${alias} -r`;
}

function printWarnings(warnings: string[]): void {
  if (warnings.length === 0) {
    return;
  }

  console.log("\nWarnings:");

  for (const warning of warnings) {
    console.log(warning);
  }
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * $EDITOR conventionally carries arguments ("code --wait", "emacsclient -nw"), so
 * it is a shell word list rather than one executable name. git resolves it the same
 * way; treating it as a bare filename failed with ENOENT.
 */
async function openInEditor(configPath: string): Promise<void> {
  const editor = process.env.VISUAL || process.env.EDITOR || "nano";
  await execa(`${editor} ${quoteForShell(configPath)}`, { shell: true, stdio: "inherit" });
}

export async function editProject(alias: string, options: EditProjectOptions = {}): Promise<void> {
  const projectRoot = await getProject(alias);

  if (!projectRoot) {
    throw new Error(requireRegisteredProjectMessage(alias));
  }

  if (!(await configExists(projectRoot))) {
    throw new Error(requireConfigMessage(alias));
  }

  const configPath = getConfigPath(projectRoot);

  if (!options.interactive) {
    await openInEditor(configPath);

    // Validate what the user wrote, but never write it back. Reserializing a valid
    // file stripped comments and reflowed inline collections even on a no-op edit.
    let config: SpinupConfig;

    try {
      config = await loadConfig(projectRoot);
    } catch (error) {
      throw new Error(formatConfigError(error));
    }

    printWarnings(await validateConfigPaths(projectRoot, config));
    return;
  }

  let config;

  try {
    config = await loadConfig(projectRoot);
  } catch (error) {
    throw new Error(formatConfigError(error));
  }

  const updatedConfig = await promptForConfigEdits(config);

  if (!updatedConfig) {
    console.log("Edit cancelled.");
    return;
  }

  try {
    await saveConfig(projectRoot, updatedConfig);
  } catch (error) {
    throw new Error(formatConfigError(error));
  }

  printWarnings(await validateConfigPaths(projectRoot, updatedConfig));

  console.log(`Updated ${configPath}`);
}
