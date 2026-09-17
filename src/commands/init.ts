import path from "node:path";

import { confirm, input, select } from "@inquirer/prompts";

import { CONFIG_FILENAME, configExists, formatConfigError, getConfigPath, loadConfig } from "../core/config.ts";
import { detectProject } from "../core/detector.ts";
import type { DetectedService } from "../core/detectors/types.ts";
import { generateConfig, generatedComments } from "../core/generator.ts";
import { getProject, sanitizeLegacyAlias, validateAlias } from "../core/registry.ts";
import { scanProject } from "../core/scanner.ts";
import { getShimPath } from "../core/shim.ts";
import type { SpinupConfig } from "../types/config.ts";
import { bootstrapProject, printRegistered, resolveDirectory } from "./run.ts";

type InitOptions = {
  path?: string;
};

function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === "ExitPromptError";
}

function aliasValidator(value: string): true | string {
  try {
    validateAlias(value);
    return true;
  } catch (error) {
    return error instanceof Error ? error.message.split("\n").join(" ") : String(error);
  }
}

function describe(service: DetectedService): string {
  return `${service.name}: ${service.command}  (${service.origin}${service.path !== "." ? `, in ${service.path}` : ""})`;
}

/** Keep, edit, remove or add services until the user continues. */
async function reviewServices(services: DetectedService[]): Promise<DetectedService[]> {
  let current = [...services];

  for (;;) {
    console.log(current.length > 0 ? `\nServices:\n${current.map((service) => `  ${describe(service)}`).join("\n")}\n` : "\nNo services yet.\n");

    const choice = await select({
      message: "Services",
      choices: [
        ...(current.length > 0 ? [{ name: "Continue with these", value: "continue" }] : []),
        ...(current.length > 0 ? [{ name: "Change a command", value: "edit" }] : []),
        ...(current.length > 0 ? [{ name: "Remove a service", value: "remove" }] : []),
        { name: "Add a service", value: "add" },
      ],
    });

    if (choice === "continue") {
      return current;
    }

    if (choice === "add") {
      const name = await input({
        message: "Service name",
        default: current.length === 0 ? "app" : `service-${current.length + 1}`,
        validate: (value) => (/^[A-Za-z0-9_-]+$/.test(value) && !current.some((service) => service.name === value)) || "Use a new name of letters, digits, - and _.",
      });
      const cwd = await input({ message: "Directory, relative to the project", default: "." });
      const command = await input({ message: "Command", validate: (value) => value.trim().length > 0 || "Enter a command." });
      current = [...current, { name, path: cwd, command, runtime: "launcher", origin: "entered during --init" }];
      continue;
    }

    const index = await select({
      message: choice === "edit" ? "Which service?" : "Remove which service?",
      choices: current.map((service, position) => ({ name: describe(service), value: position })),
    });

    if (choice === "remove") {
      const removed = current[index]!.name;
      // Dependencies on a removed service would make the config invalid.
      current = current
        .filter((_, position) => position !== index)
        .map((service) => ({ ...service, dependsOn: service.dependsOn?.filter((dependency) => dependency !== removed) }));
      continue;
    }

    const service = current[index]!;
    const command = await input({ message: `Command for ${service.name}`, default: service.command });
    const cwd = await input({ message: `Directory for ${service.name}`, default: service.path });
    current = current.map((entry, position) =>
      position === index && (command !== service.command || cwd !== service.path)
        ? { ...entry, command, path: cwd, origin: "edited during --init" }
        : entry,
    );
  }
}

/**
 * Guided registration: choose the alias, review what detection found, preview
 * every file that will be written, and confirm. Cancelling at any prompt writes
 * nothing.
 */
export async function initProject(aliasArgument: string | undefined, options: InitOptions = {}): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error("--init asks questions and needs a terminal. To register without prompts, run: spinup <alias>");
  }

  const projectRoot = options.path ? await resolveDirectory(options.path) : process.cwd();

  try {
    const alias = validateAlias(
      aliasArgument ??
        (await input({
          message: "Alias (the command you will type)",
          default: sanitizeLegacyAlias(path.basename(projectRoot)) ?? "app",
          validate: aliasValidator,
        })),
    );

    const registered = await getProject(alias);

    if (registered) {
      throw new Error(`"${alias}" is already registered for ${registered}. To use this directory: spinup ${alias} --relink`);
    }

    let config: SpinupConfig;
    let comments: Record<string, string> = {};
    const existing = await configExists(projectRoot);

    if (existing) {
      try {
        config = await loadConfig(projectRoot);
      } catch (error) {
        throw new Error(formatConfigError(error));
      }

      console.log(`\nUsing the existing ${path.basename(getConfigPath(projectRoot))}; it will not be changed.`);
    } else {
      const scan = await scanProject(projectRoot);
      const detection = detectProject(scan);

      for (const note of detection.notes) {
        console.log(`note: ${note}`);
      }

      detection.services = await reviewServices(detection.services);
      config = generateConfig(scan, alias, detection);

      if (detection.services.length > 1) {
        const mode = await select({
          message: "Run the services",
          choices: [
            { name: "in a tmux workspace, one pane each", value: "tmux" },
            { name: "in this terminal, with prefixed output", value: "simple" },
          ],
        });

        if (mode === "simple" && config.actions.dev?.mode === "tmux") {
          config.actions.dev = { mode: "simple", tasks: config.actions.dev.windows.flatMap((window) => window.panes) };
        }
      }

      comments = generatedComments(detection);
    }

    const action = config.actions[config.default]!;
    const entries = action.mode === "tmux" ? action.windows.flatMap((window) => window.panes) : action.tasks ?? [];

    console.log("\nAbout to:");
    console.log(existing ? `  keep     ${getConfigPath(projectRoot)}` : `  write    ${path.join(projectRoot, CONFIG_FILENAME)}`);
    console.log(`  install  ${getShimPath(alias)}`);
    console.log(`  register "${alias}" -> ${projectRoot}`);
    console.log(`\n${config.default} (${action.mode}):`);

    for (const entry of entries) {
      console.log(`  ${entry.name}: ${entry.cmd}${entry.cwd !== "." ? `  (in ${entry.cwd})` : ""}`);
    }

    console.log("");

    if (!(await confirm({ message: "Go ahead?", default: true }))) {
      console.log("Cancelled; nothing was written.");
      return;
    }

    await bootstrapProject(alias, projectRoot, existing ? "keep" : { config, comments });
    await printRegistered(alias, projectRoot);
  } catch (error) {
    if (isCancellation(error)) {
      console.log("\nCancelled; nothing was written.");
      return;
    }

    throw error;
  }
}
