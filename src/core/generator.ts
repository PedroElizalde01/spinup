import { CURRENT_CONFIG_VERSION } from "./config.ts";
import { detectProject } from "./detector.ts";
import type { DetectedService, ProjectDetection } from "./detectors/types.ts";
import type { ScanResult } from "./scanner.ts";
import type { Action, SpinupConfig, Task } from "../types/config.ts";

function toRunnable(service: DetectedService): Task {
  return {
    name: service.name,
    cwd: service.path,
    cmd: service.command,
    dependsOn: service.dependsOn,
    delay: service.delay,
    env: service.env,
  };
}

/**
 * Builds a config from what was detected. Throws when nothing runnable was found:
 * a guessed command used to be written and registered as if it had been detected.
 */
export function generateConfig(
  scanResult: ScanResult,
  projectName: string,
  detection: ProjectDetection = detectProject(scanResult),
): SpinupConfig {
  const services = detection.services;

  if (services.length === 0) {
    throw new NothingToRunError();
  }

  const actions: Record<string, Action> = {
    dev:
      services.length > 1
        ? {
            mode: "tmux",
            windows: [{ name: "services", layout: services.length >= 3 ? "tiled" : "even-horizontal", panes: services.map(toRunnable) }],
          }
        : { mode: "simple", tasks: services.map(toRunnable) },
  };

  // The container app on its own, when dev is more than just that.
  if (scanResult.compose && scanResult.compose.services.length > 0 && !(services.length === 1 && services[0]!.runtime === "docker")) {
    actions.docker = { mode: "simple", tasks: [{ name: "compose", cwd: ".", cmd: "docker compose up" }] };
  }

  if (detection.prismaCommands) {
    actions["prisma-generate"] = { mode: "simple", tasks: [{ name: "prisma", cwd: ".", cmd: detection.prismaCommands.generate }] };
    actions["prisma-migrate"] = { mode: "simple", tasks: [{ name: "prisma", cwd: ".", cmd: detection.prismaCommands.migrate }] };
  }

  return { version: CURRENT_CONFIG_VERSION, name: projectName, root: ".", default: "dev", actions };
}

export class NothingToRunError extends Error {
  constructor() {
    super("No development command was detected for this project.");
    this.name = "NothingToRunError";
  }
}

/** Comment text per generated service, so the file says where each command came from. */
export function generatedComments(detection: ProjectDetection): Record<string, string> {
  return Object.fromEntries(
    detection.services.map((service) => [
      service.name,
      service.containers ? `from ${service.origin}: ${service.containers.join(", ")}` : `from ${service.origin}`,
    ]),
  );
}
