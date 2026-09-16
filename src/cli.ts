#!/usr/bin/env bun

import { Command, Option } from "commander";

// Bundled into the compiled binary, so source and release report the same version.
import packageJson from "../package.json" with { type: "json" };
import { checkProject } from "./commands/check.ts";
import { doctorProject, previewProjectEnv, previewProjectGraph, previewProjectPlan } from "./commands/doctor.ts";
import { editProject } from "./commands/edit.ts";
import { listRegisteredProjects } from "./commands/list.ts";
import { removeRegisteredProject } from "./commands/remove.ts";
import { runProject } from "./commands/run.ts";
import { exitCodeFor, Interrupted } from "./core/executor.ts";
import { EXIT, setJsonMode } from "./ui/output.ts";
import { isCanonicalAlias, listProjects, migrateLegacyAliases } from "./core/registry.ts";
import { createShim, needsShimRefresh, reclaimLegacyShim } from "./core/shim.ts";
import { banner } from "./ui/brand.ts";

/**
 * Aliases registered before the format was enforced would otherwise report as
 * invalid rather than resolving. Rename them once, move their shims, and say so.
 */
async function refreshStaleShims(): Promise<void> {
  // Shims written before the rename still exec "runit", which no longer exists.
  for (const alias of Object.keys(await listProjects())) {
    if (!isCanonicalAlias(alias)) {
      continue;
    }

    if (await needsShimRefresh(alias)) {
      await createShim(alias);
      process.stderr.write(`[migrate] updated the "${alias}" command for the spinup rename\n`);
    }
  }
}

async function migrateRegistry(): Promise<void> {
  const migrations = await migrateLegacyAliases();

  if (migrations.length === 0) {
    await refreshStaleShims();
    return;
  }

  for (const migration of migrations) {
    if (!migration.to) {
      process.stderr.write(
        `[migrate] could not rename alias "${migration.from}" (${migration.reason}); it is still registered but cannot be used.\n`,
      );
      continue;
    }

    try {
      await createShim(migration.to);
    } catch (error) {
      process.stderr.write(
        `[migrate] renamed "${migration.from}" to "${migration.to}" in the registry, but could not create its command: ${
          error instanceof Error ? error.message.split("\n")[0] : String(error)
        }\n`,
      );
      continue;
    }

    // Pass the new name so a case-insensitive filesystem does not delete the
    // wrapper that was just written for it.
    await reclaimLegacyShim(migration.from, migration.to);
    process.stderr.write(`[migrate] renamed alias "${migration.from}" to "${migration.to}"\n`);
  }

  await refreshStaleShims();
}

type CliOptions = {
  action?: string;
  check?: boolean;
  color?: boolean;
  doctor?: boolean;
  dryRun?: boolean;
  env?: boolean;
  edit?: boolean;
  graph?: boolean;
  interactive?: boolean;
  json?: boolean;
  list?: boolean;
  plan?: boolean;
  regenerate?: boolean;
  remove?: boolean;
  start?: boolean;
};

// `spinup | head` closes the pipe early; that is not an error worth a stack trace.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") {
    process.exit(0);
  }

  throw error;
});

// Read before anything renders: the setup card and the banner check NO_COLOR.
if (process.argv.includes("--no-color")) {
  process.env.NO_COLOR = "1";
}

const program = new Command();

program
  .name("spinup")
  .description("Run registered project environments from anywhere.")
  .version(packageJson.version, "-v, --version")
  // Unrecognized arguments were silently discarded, so shim-forwarded flags looked
  // like they worked. Fail loudly until a passthrough contract exists.
  .allowExcessArguments(false)
  .addHelpText("beforeAll", banner)
  .argument("[alias]", "registered project alias")
  // The generated command passes --start. It means "launch unless a management
  // flag was given", so `my-app --doctor` inspects instead of launching.
  .addOption(new Option("--start", "start the registered project").hideHelp())
  .option("-a, --action <name>", "act on this action instead of the default")
  .option("--check", "validate required tools for a registered project")
  .option("--doctor", "inspect a registered project")
  .option("--env", "show loaded environment variables")
  .option("--edit", "edit the project config")
  .option("--graph", "show service dependency graph")
  .option("--interactive", "use interactive prompts with --edit")
  .option("--plan", "preview the execution plan")
  .option("--dry-run", "with --start: resolve everything and start nothing")
  .option("--json", "print inspection results as JSON")
  .option("--no-color", "disable colored output")
  .option("-r, --regenerate", "re-scan the project and overwrite the project config")
  .option("--remove", "remove a registered project and its shim")
  .option("--list", "list registered projects")
  .action(async (alias: string | undefined, options: CliOptions) => {
    await migrateRegistry();
    setJsonMode(Boolean(options.json));

    const management = {
      check: options.check,
      doctor: options.doctor,
      env: options.env,
      edit: options.edit,
      graph: options.graph,
      list: options.list,
      plan: options.plan,
      remove: options.remove,
    };
    const active = Object.entries(management)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name);

    if (active.length > 1) {
      throw new Error("Use only one primary action flag at a time.");
    }

    const primary = active[0] ?? (options.start ? "start" : alias ? "register" : "help");
    const inspecting = ["check", "doctor", "env", "graph", "plan", "list"].includes(primary);

    if (options.json && !inspecting) {
      throw new Error("--json applies to --list, --plan, --graph, --env, --check and --doctor.");
    }

    if (options.action && !["start", "check", "doctor", "env", "graph", "plan"].includes(primary)) {
      throw new Error("--action applies to launching, --plan, --graph, --env, --check and --doctor.");
    }

    if (options.dryRun && primary !== "start") {
      throw new Error("--dry-run applies to launching only (with --start).");
    }

    if (options.interactive && !options.edit) {
      throw new Error("--interactive can only be used with --edit.");
    }

    if (options.regenerate && primary !== "register" && primary !== "start") {
      throw new Error("--regenerate can only be used when registering or launching a project.");
    }

    if (primary === "help") {
      // Bare `spinup` is a request for orientation, not an error.
      program.outputHelp();
      return;
    }

    if (primary === "list") {
      await listRegisteredProjects();
      return;
    }

    if (!alias) {
      throw new Error("An alias is required unless --list is used.");
    }

    const selected = { action: options.action };

    switch (primary) {
      case "check":
        return checkProject(alias, selected);
      case "doctor":
        return doctorProject(alias, selected);
      case "env":
        return previewProjectEnv(alias, selected);
      case "graph":
        return previewProjectGraph(alias, selected);
      case "plan":
        return previewProjectPlan(alias, selected);
      case "edit":
        return editProject(alias, { interactive: options.interactive });
      case "remove":
        return removeRegisteredProject(alias);
      default:
        return runProject(alias, {
          regenerate: options.regenerate,
          start: options.start,
          action: options.action,
          dryRun: options.dryRun,
        });
    }
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(error instanceof Interrupted ? `[run] ${message}\n` : `${message}\n`);
  // A task's own status, 130/143 for a handled signal, 1 for everything else.
  process.exitCode = exitCodeFor(error) || EXIT.usage;
}
