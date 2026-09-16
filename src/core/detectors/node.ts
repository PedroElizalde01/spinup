import path from "node:path";

import type { DirectoryScan, PackageJsonData, PackageManager, ScanResult } from "../scanner.ts";
import type { DetectedService } from "./types.ts";

const FRAMEWORK_DEPENDENCIES: Array<[string, string]> = [
  ["@nestjs/core", "NestJS"],
  ["next", "Next.js"],
  ["vite", "Vite"],
  ["react", "React"],
  ["express", "Express"],
  ["fastify", "Fastify"],
];

// Long-running development entrypoints only. "check" and "test" were on this list,
// so a package whose only script ran its tests was registered as a dev server.
const DEV_SCRIPTS = ["dev", "start:dev", "develop", "serve", "start"] as const;

function hasDependency(packageJson: PackageJsonData | undefined, dependencyName: string): boolean {
  return Boolean(packageJson?.dependencies?.[dependencyName] || packageJson?.devDependencies?.[dependencyName]);
}

export function buildScriptCommand(packageManager: PackageManager | undefined, scriptName: string): string {
  switch (packageManager) {
    case "pnpm":
      return `pnpm ${scriptName}`;
    case "yarn":
      return `yarn ${scriptName}`;
    case "bun":
      return `bun run ${scriptName}`;
    case "npm":
    case "unknown":
    case undefined:
      return scriptName === "start" ? "npm start" : `npm run ${scriptName}`;
  }
}

export function buildExecCommand(packageManager: PackageManager | undefined, command: string): string {
  switch (packageManager) {
    case "pnpm":
      return `pnpm exec ${command}`;
    case "yarn":
      return `yarn exec ${command}`;
    case "bun":
      return `bunx ${command}`;
    case "npm":
    case "unknown":
    case undefined:
      return `npm exec ${command}`;
  }
}

export function detectNodeFrameworks(packageJson: PackageJsonData | undefined): string[] {
  return FRAMEWORK_DEPENDENCIES.filter(([dependency]) => hasDependency(packageJson, dependency)).map(([, label]) => label);
}

function frameworkLabel(frameworks: string[]): string | undefined {
  return ["NestJS", "Next.js", "Vite", "Express", "Fastify", "React"].find((framework) => frameworks.includes(framework));
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function binEntryPaths(packageJson: PackageJsonData | undefined): string[] {
  if (!packageJson?.bin) {
    return [];
  }

  return typeof packageJson.bin === "string" ? [packageJson.bin] : Object.values(packageJson.bin);
}

/** A CLI package whose "start" just runs its own bin is not a dev server. */
function isSelfReferentialCliScript(packageJson: PackageJsonData | undefined, scriptCommand: string): boolean {
  const normalized = normalizeCommand(scriptCommand);

  return binEntryPaths(packageJson).some((binPath) =>
    [binPath, `./${binPath}`].some((variant) =>
      [`bun run ${variant}`, `bun ${variant}`, `node ${variant}`, `tsx ${variant}`, `ts-node ${variant}`].includes(normalized),
    ),
  );
}

function manifestPath(directory: string): string {
  return directory === "." ? "package.json" : path.posix.join(directory, "package.json");
}

function resolveCommand(
  directory: DirectoryScan,
  packageManager: PackageManager,
  scripts: readonly string[] = DEV_SCRIPTS,
): { command: string; origin: string } | undefined {
  const declared = directory.packageJson?.scripts ?? {};

  for (const script of scripts) {
    const body = declared[script];

    if (!body || isSelfReferentialCliScript(directory.packageJson, body)) {
      continue;
    }

    return { command: buildScriptCommand(packageManager, script), origin: `${manifestPath(directory.path)} scripts.${script}` };
  }

  // An entry file that exists is evidence; a guessed "npm start" was not. index.js
  // alone is usually a library's export surface, so it counts only for a package
  // that depends on an HTTP server framework.
  const isServer = hasDependency(directory.packageJson, "express") || hasDependency(directory.packageJson, "fastify");
  const entry = directory.hasServerJs ? "server.js" : directory.hasIndexJs && isServer ? "index.js" : undefined;

  if (entry) {
    return { command: `node ${entry}`, origin: `${directory.path === "." ? entry : path.posix.join(directory.path, entry)} exists` };
  }

  return undefined;
}

function toService(name: string, directory: DirectoryScan, resolved: { command: string; origin: string }): DetectedService {
  return {
    name,
    path: directory.path,
    command: resolved.command,
    runtime: "node",
    origin: resolved.origin,
    framework: frameworkLabel(detectNodeFrameworks(directory.packageJson)),
  };
}

/**
 * A root `dev` script in a monorepo is the project's own orchestrator (turbo, nx,
 * concurrently). It used to be dropped in favor of launching every workspace
 * separately; now it wins, and members are only expanded when there is none.
 */
export function detectNodeServices(scan: ScanResult): DetectedService[] {
  if (!scan.monorepo) {
    if (!scan.root.packageJson) {
      return [];
    }

    const resolved = resolveCommand(scan.root, scan.packageManager);
    return resolved ? [toService("app", scan.root, resolved)] : [];
  }

  const orchestrator = scan.root.packageJson ? resolveCommand(scan.root, scan.packageManager, ["dev"]) : undefined;

  if (orchestrator) {
    return [toService("app", scan.root, { ...orchestrator, origin: `${orchestrator.origin} (runs the workspaces)` })];
  }

  return scan.candidates
    .filter((candidate) => candidate.packageJson)
    .flatMap((candidate) => {
      const resolved = resolveCommand(candidate, scan.packageManager);
      return resolved ? [toService(path.posix.basename(candidate.path), candidate, resolved)] : [];
    });
}
