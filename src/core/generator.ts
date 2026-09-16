import { detectProject } from "./detector.ts";
import type { ScanResult } from "./scanner.ts";
import type { Action, SpinupConfig, Task, Window } from "../types/config.ts";

function resolveServicesLayout(serviceCount: number): string {
  if (serviceCount === 2) {
    return "even-horizontal";
  }

  if (serviceCount >= 3) {
    return "tiled";
  }

  return "even-horizontal";
}

function buildSimpleAction(tasks: Task[]): Action {
  return {
    mode: "simple",
    tasks,
  };
}

function buildTmuxAction(windows: Window[]): Action {
  return {
    mode: "tmux",
    windows,
  };
}

export function generateConfig(scanResult: ScanResult, projectName: string): SpinupConfig {
  const detection = detectProject(scanResult);
  const actions: Record<string, Action> = {};

  if (detection.services.length > 0) {
    if (detection.services.length > 1) {
      actions.dev = buildTmuxAction([
        {
          name: "services",
          layout: resolveServicesLayout(detection.services.length),
          panes: detection.services.map((service) => ({
            name: service.name,
            cwd: service.path,
            cmd: service.command,
            dependsOn: service.dependsOn,
            delay: service.delay,
            env: service.env,
          })),
        },
      ]);
    } else {
      actions.dev = buildSimpleAction(
        detection.services.map((service) => ({
          name: service.name,
          cwd: service.path,
          cmd: service.command,
          dependsOn: service.dependsOn,
          delay: service.delay,
          env: service.env,
        })),
      );
    }
  }

  if (scanResult.dockerComposeFile) {
    actions.docker = buildSimpleAction([
      {
        name: "docker",
        cwd: ".",
        cmd: "docker compose up",
      },
    ]);
  }

  if (detection.prisma && detection.prismaCommands) {
    actions["prisma-generate"] = buildSimpleAction([
      {
        name: "prisma",
        cwd: ".",
        cmd: detection.prismaCommands.generate,
      },
    ]);

    actions["prisma-migrate"] = buildSimpleAction([
      {
        name: "prisma",
        cwd: ".",
        cmd: detection.prismaCommands.migrate,
      },
    ]);
  }

  return {
    name: projectName,
    root: ".",
    default: detection.defaultAction,
    actions,
  };
}
