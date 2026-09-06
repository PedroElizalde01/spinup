import { confirm, input, select } from "@inquirer/prompts";

import type { Action, Pane, RunitConfig, Task, Window } from "../types/config.ts";

/**
 * Carries the original task/pane so fields the prompts never touch -- env, delay,
 * dependsOn -- survive a save. Rebuilding from name/cwd/cmd alone silently dropped
 * them.
 */
type EditableService = {
  name: string;
  cwd: string;
  cmd: string;
  source?: Task | Pane;
};

function getEditableWindow(action: Action): Window | undefined {
  if (action.mode !== "tmux") {
    return undefined;
  }

  return action.windows.find((window) => window.name === "services") ?? action.windows[0];
}

function extractServices(action: Action): EditableService[] {
  if (action.mode === "tmux") {
    return (getEditableWindow(action)?.panes ?? []).map((pane) => ({
      name: pane.name,
      cwd: pane.cwd,
      cmd: pane.cmd,
      source: pane,
    }));
  }

  return (action.tasks ?? []).map((task) => ({
    name: task.name,
    cwd: task.cwd,
    cmd: task.cmd,
    source: task,
  }));
}

/**
 * Drops a dependency that points at a service the user just removed, so the result
 * still validates.
 */
function pruneDependencies<T extends { name: string; dependsOn?: string[] }>(items: T[]): T[] {
  const present = new Set(items.map((item) => item.name));

  return items.map((item) => {
    if (!item.dependsOn) {
      return item;
    }

    const kept = item.dependsOn.filter((dependency) => present.has(dependency));
    const { dependsOn: _dropped, ...rest } = item;

    return (kept.length > 0 ? { ...rest, dependsOn: kept } : rest) as T;
  });
}

function resolveTmuxLayout(serviceCount: number): string {
  if (serviceCount === 2) {
    return "even-horizontal";
  }

  if (serviceCount >= 3) {
    return "tiled";
  }

  return "even-horizontal";
}

function toRunnable(service: EditableService): Task & Pane {
  // Spread the original first so untouched fields are carried through unchanged.
  return {
    ...(service.source ?? {}),
    name: service.name,
    cwd: service.cwd,
    cmd: service.cmd,
  } as Task & Pane;
}

function applyServicesToAction(
  action: Action,
  services: EditableService[],
  mode: "simple" | "tmux",
): Action {
  const runnables = pruneDependencies(services.map(toRunnable));

  if (mode === "simple") {
    return {
      mode: "simple",
      tasks: runnables,
    };
  }

  const editedWindow = action.mode === "tmux" ? getEditableWindow(action) : undefined;
  const serviceWindow: Window = {
    // Keep the window's own identity; only its panes were edited.
    name: editedWindow?.name ?? "services",
    layout: editedWindow?.layout ?? resolveTmuxLayout(services.length),
    panes: runnables,
  };

  const extraWindows = action.mode === "tmux" ? action.windows.filter((window) => window !== editedWindow) : [];

  return {
    mode: "tmux",
    windows: [serviceWindow, ...extraWindows],
  };
}

async function promptServiceSelection(services: EditableService[], message: string): Promise<number> {
  return select({
    message,
    choices: services.map((service, index) => ({
      name: `${service.name} -> ${service.cmd} (${service.cwd})`,
      value: index,
    })),
  });
}

export async function confirmAction(message: string, defaultValue = false): Promise<boolean> {
  return confirm({
    message,
    default: defaultValue,
  });
}

export async function promptForConfigEdits(config: RunitConfig): Promise<RunitConfig | null> {
  const defaultActionName = config.default;
  const defaultAction = config.actions[defaultActionName];

  if (!defaultAction) {
    return config;
  }

  let nextMode: "simple" | "tmux" = defaultAction.mode;
  let services = extractServices(defaultAction);
  const hasExtraTmuxWindows = defaultAction.mode === "tmux" && defaultAction.windows.length > 1;

  while (true) {
    const action = await select({
      message: `Edit action "${defaultActionName}"`,
      choices: [
        { name: "Add service", value: "add" },
        { name: "Remove service", value: "remove" },
        { name: "Change command", value: "command" },
        { name: "Change cwd", value: "cwd" },
        { name: `Toggle mode (current: ${nextMode})`, value: "mode" },
        { name: "Save changes", value: "save" },
        { name: "Cancel", value: "cancel" },
      ],
    });

    if (action === "cancel") {
      return null;
    }

    if (action === "save") {
      if (services.length === 0) {
        throw new Error('At least one service is required for the default action.');
      }

      return {
        ...config,
        actions: {
          ...config.actions,
          [defaultActionName]: applyServicesToAction(defaultAction, services, nextMode),
        },
      };
    }

    if (action === "add") {
      const name = await input({ message: "Service name", default: `service-${services.length + 1}` });
      const cwd = await input({ message: "Working directory", default: "." });
      const cmd = await input({ message: "Command", default: "npm start" });

      services = [...services, { name, cwd, cmd }];
      continue;
    }

    if (action === "mode") {
      nextMode = nextMode === "simple" ? "tmux" : "simple";

      if (hasExtraTmuxWindows && nextMode === "simple") {
        console.log('Warning: switching to "simple" keeps only the primary services window.');
      }

      continue;
    }

    if (services.length === 0) {
      console.log("No services available to edit.");
      continue;
    }

    const selectedIndex = await promptServiceSelection(services, "Select a service");

    if (action === "remove") {
      services = services.filter((_, index) => index !== selectedIndex);
      continue;
    }

    if (action === "command") {
      const cmd = await input({
        message: `Command for ${services[selectedIndex].name}`,
        default: services[selectedIndex].cmd,
      });
      services = services.map((service, index) =>
        index === selectedIndex ? { ...service, cmd } : service,
      );
      continue;
    }

    if (action === "cwd") {
      const cwd = await input({
        message: `Working directory for ${services[selectedIndex].name}`,
        default: services[selectedIndex].cwd,
      });
      services = services.map((service, index) =>
        index === selectedIndex ? { ...service, cwd } : service,
      );
    }
  }
}
