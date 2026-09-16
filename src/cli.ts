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
  check?: boolean;
  doctor?: boolean;
  env?: boolean;
  edit?: boolean;
  graph?: boolean;
  interactive?: boolean;
  list?: boolean;
  plan?: boolean;
  regenerate?: boolean;
  remove?: boolean;
  start?: boolean;
};

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
  .addOption(new Option("--start", "start the registered project").hideHelp())
  .option("--check", "validate required tools for a registered project")
  .option("--doctor", "inspect a registered project")
  .option("--env", "show loaded environment variables")
  .option("--edit", "edit the project config")
  .option("--graph", "show service dependency graph")
  .option("--interactive", "use interactive prompts with --edit")
  .option("--plan", "preview the execution plan")
  .option("-r, --regenerate", "re-scan the project and overwrite the project config")
  .option("--remove", "remove a registered project and its shim")
  .option("--list", "list registered projects")
  .action(async (alias: string | undefined, options: CliOptions) => {
    await migrateRegistry();

    const activeFlags = [
      options.check,
      options.doctor,
      options.env,
      options.edit,
      options.graph,
      options.list,
      options.plan,
      options.remove,
      options.start,
    ].filter(Boolean).length;

    if (activeFlags > 1) {
      throw new Error("Use only one primary action flag at a time.");
    }

    if (options.list) {
      await listRegisteredProjects();
      return;
    }

    if (!alias) {
      if (activeFlags === 0 && !options.interactive && !options.regenerate) {
        // Bare `spinup` is a request for orientation, not an error.
        program.outputHelp();
        return;
      }

      throw new Error("An alias is required unless --list is used.");
    }

    if (options.interactive && !options.edit) {
      throw new Error("--interactive can only be used with --edit.");
    }

    if (options.regenerate && (options.check || options.doctor || options.env || options.edit || options.graph || options.list || options.plan || options.remove)) {
      throw new Error("--regenerate can only be used when running a project.");
    }

    if (options.check) {
      await checkProject(alias);
      return;
    }

    if (options.doctor) {
      await doctorProject(alias);
      return;
    }

    if (options.env) {
      await previewProjectEnv(alias);
      return;
    }

    if (options.edit) {
      await editProject(alias, { interactive: options.interactive });
      return;
    }

    if (options.graph) {
      await previewProjectGraph(alias);
      return;
    }

    if (options.plan) {
      await previewProjectPlan(alias);
      return;
    }

    if (options.remove) {
      await removeRegisteredProject(alias);
      return;
    }

    await runProject(alias, { regenerate: options.regenerate, start: options.start });
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
