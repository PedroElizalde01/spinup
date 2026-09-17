import path from "node:path";

import { detectComposeService } from "./detectors/docker.ts";
import { buildExecCommand, detectNodeFrameworks, detectNodeServices } from "./detectors/node.ts";
import { detectEcosystemServices } from "./detectors/ecosystems.ts";
import { detectPythonFrameworks, detectPythonService } from "./detectors/python.ts";
import type { DetectedService, ProjectDetection } from "./detectors/types.ts";
import type { ScanResult } from "./scanner.ts";

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function resolveStack(scan: ScanResult): ProjectDetection["stack"] {
  const directories = [scan.root, ...scan.candidates];
  const has = (test: (directory: (typeof directories)[number]) => unknown) => directories.some((directory) => Boolean(test(directory)));
  const kinds = [
    has((directory) => directory.packageJson) ? "node" : undefined,
    has((directory) => directory.python) ? "python" : undefined,
    has((directory) => directory.ecosystem.goMod !== undefined) ? "go" : undefined,
    has((directory) => directory.ecosystem.cargoToml !== undefined) ? "rust" : undefined,
    has((directory) => directory.ecosystem.gemfile !== undefined || directory.ecosystem.railsBin) ? "ruby" : undefined,
    has((directory) => directory.ecosystem.composerJson !== undefined || directory.ecosystem.artisan) ? "php" : undefined,
    has((directory) => directory.ecosystem.gradleBuild !== undefined || directory.ecosystem.pomXml !== undefined) ? "java" : undefined,
    has((directory) => directory.ecosystem.denoTasks !== undefined) ? "deno" : undefined,
    scan.compose && scan.compose.services.length > 0 ? "docker" : undefined,
  ].filter((kind): kind is Exclude<ProjectDetection["stack"], "mixed" | "unknown"> => Boolean(kind));

  if (kinds.length === 0) {
    return "unknown";
  }

  return kinds.length === 1 ? kinds[0]! : "mixed";
}

/**
 * Names become pane names and dependency targets, so they must be unique. Only
 * colliding names change: by runtime when that separates them (app-node,
 * app-python), otherwise by path (apps-api, services-api). A Node and Python app
 * at the root both became "app", and the generated config then failed its own
 * validation.
 */
function assignUniqueNames(services: DetectedService[]): Array<DetectedService & { baseName: string }> {
  const counts = new Map<string, number>();

  for (const service of services) {
    counts.set(service.name, (counts.get(service.name) ?? 0) + 1);
  }

  const taken = new Set<string>();

  return services.map((service) => {
    const siblings = services.filter((other) => other.name === service.name);
    let name = service.name;

    if ((counts.get(service.name) ?? 0) > 1) {
      const runtimesDiffer = new Set(siblings.map((sibling) => sibling.runtime)).size === siblings.length;
      name =
        runtimesDiffer || service.path === "."
          ? `${service.name}-${service.runtime}`
          : service.path.split("/").join("-").toLowerCase();
    }

    const stem = name;

    for (let suffix = 2; taken.has(name); suffix += 1) {
      name = `${stem}-${suffix}`;
    }

    taken.add(name);
    return { ...service, name, baseName: service.name };
  });
}

function inferDependencies(services: Array<DetectedService & { baseName: string }>): DetectedService[] {
  const compose = services.find((service) => service.runtime === "docker");
  const backend = services.find((service) => ["api", "server", "backend"].includes(service.baseName));
  const frontendNames = new Set(["web", "frontend", "client"]);

  return services.map(({ baseName, ...service }) => {
    const dependsOn = new Set(service.dependsOn ?? []);

    if (compose && service.runtime !== "launcher" && service.name !== compose.name) {
      dependsOn.add(compose.name);
    }

    // Resolved through the original identity, then pointed at the unique name.
    if (backend && frontendNames.has(baseName) && service.name !== backend.name) {
      dependsOn.add(backend.name);
    }

    return { ...service, dependsOn: dependsOn.size > 0 ? [...dependsOn] : undefined };
  });
}

export function detectProject(scan: ScanResult): ProjectDetection {
  const notes: string[] = [];
  const directories = [scan.root, ...scan.candidates];
  let services: DetectedService[];

  if (scan.packageManagerConflict) {
    notes.push(`Package manager: using ${scan.packageManager} (${scan.packageManagerSource}); ${scan.packageManagerConflict}.`);
  }

  const [launcher, ...otherLaunchers] = scan.launchers;

  if (launcher) {
    // The project's own dev entrypoint runs everything it needs. Launching its
    // children as well would start them twice.
    services = launcher.services.map((entry) => ({
      name: entry.name,
      path: ".",
      command: entry.command,
      runtime: "launcher" as const,
      origin: entry.origin,
    }));

    for (const other of otherLaunchers) {
      notes.push(`Also found ${other.origin}; using ${launcher.origin}. Edit the config to use the other one.`);
    }
  } else {
    const directories = [
      { name: "app", directory: scan.root },
      ...(scan.monorepo ? scan.candidates.map((candidate) => ({ name: path.posix.basename(candidate.path), directory: candidate })) : []),
    ];
    const python = directories
      .map(({ name, directory }) => detectPythonService(name, directory, notes))
      .filter((service): service is DetectedService => Boolean(service));
    const other = directories.flatMap(({ name, directory }) => detectEcosystemServices(name, directory));

    services = [
      ...[detectComposeService(scan, notes)].filter((service): service is DetectedService => Boolean(service)),
      ...detectNodeServices(scan),
      ...python,
      ...other,
    ];
  }

  const packageManager = directories.some((directory) => directory.packageJson) ? scan.packageManager : undefined;
  const frameworks = sortedUnique([
    ...directories.flatMap((directory) => detectNodeFrameworks(directory.packageJson)),
    ...directories.flatMap((directory) => detectPythonFrameworks(directory.python)),
    ...directories.flatMap((directory) => detectEcosystemServices("", directory).flatMap((service) => (service.framework ? [service.framework] : []))),
    ...(scan.compose && scan.compose.services.length > 0 ? ["Docker Compose"] : []),
    ...(scan.prisma ? ["Prisma"] : []),
  ]);

  return {
    stack: resolveStack(scan),
    packageManager,
    frameworks,
    services: inferDependencies(assignUniqueNames(services)),
    prisma: scan.prisma,
    monorepo: scan.monorepo,
    prismaCommands: scan.prisma
      ? {
          generate: buildExecCommand(scan.packageManager, "prisma generate"),
          migrate: buildExecCommand(scan.packageManager, "prisma migrate dev"),
        }
      : undefined,
    notes,
  };
}
