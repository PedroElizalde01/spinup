import { confirm, input, select } from "@inquirer/prompts";

import type { Action, Pane, SpinupConfig, Task, Window } from "../types/config.ts";

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

type Runnable = Task & Pane;

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
 * Removes references to services the user removed, and nothing else. Pruning
 * against the edited window's names dropped every dependency on a service that
 * lived in another window, even though that service still existed.
 */
function stripRemovedDependencies<T extends { dependsOn?: string[] }>(item: T, removed: Set<string>): T {
  if (!item.dependsOn || removed.size === 0) {
    return item;
  }

  const kept = item.dependsOn.filter((dependency) => !removed.has(dependency));

  if (kept.length === item.dependsOn.length) {
    return item;
  }

  const { dependsOn: _dropped, ...rest } = item;
  return (kept.length > 0 ? { ...rest, dependsOn: kept } : rest) as T;
}

function resolveTmuxLayout(serviceCount: number): string {
  return serviceCount >= 3 ? "tiled" : "even-horizontal";
}

function toRunnable(service: EditableService): Runnable {
  // Spread the original first so untouched fields are carried through unchanged.
  return {
    ...(service.source ?? {}),
    name: service.name,
    cwd: service.cwd,
    cmd: service.cmd,
  } as Runnable;
}

function applyServicesToAction(
  action: Action,
  services: EditableService[],
  mode: "simple" | "tmux",
  removed: Set<string>,
): Action {
  const runnables = services.map(toRunnable).map((item) => stripRemovedDependencies(item, removed));

  if (mode === "simple") {
    return { mode: "simple", tasks: runnables };
  }

  if (action.mode !== "tmux") {
    // Converting from simple: this is the only case where a window is invented.
    return {
      mode: "tmux",
      windows: [{ name: "services", layout: resolveTmuxLayout(runnables.length), panes: runnables }],
    };
  }

  const editedWindow = getEditableWindow(action);

  // Every window stays where it was, with whatever fields it had. Only the edited
  // window's panes change; the others only lose references to removed services.
  return {
    mode: "tmux",
    windows: action.windows.map((window) =>
      window === editedWindow
        ? { ...window, panes: runnables }
        : { ...window, panes: window.panes.map((pane) => stripRemovedDependencies(pane, removed)) },
    ),
  };
}

function describeDroppedWindows(action: Action): string {
  if (action.mode !== "tmux") {
    return "";
  }

  const edited = getEditableWindow(action);

  return action.windows
    .filter((window) => window !== edited)
    .map((window) => `"${window.name}" (${window.panes.map((pane) => pane.name).join(", ")})`)
    .join(", ");
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

/** Asks for a nonblank command; an empty answer cancels. */
export async function promptForCommand(message: string): Promise<string> {
  const answer = (await input({ message })).trim();

  if (!answer) {
    throw new Error("No command entered; nothing was registered.");
  }

  return answer;
}

export async function confirmAction(message: string, defaultValue = false): Promise<boolean> {
  return confirm({
    message,
    default: defaultValue,
  });
}

/**
 * Returns the very same object when the user saved without changing anything, so
 * the caller can skip the write and leave the file's bytes alone.
 */
export async function promptForConfigEdits(config: SpinupConfig): Promise<SpinupConfig | null> {
  const defaultActionName = config.default;
  const defaultAction = config.actions[defaultActionName];

  if (!defaultAction) {
    return config;
  }

  let nextMode: "simple" | "tmux" = defaultAction.mode;
  let services = extractServices(defaultAction);
  const removed = new Set<string>();
  let dirty = false;
  const droppedWindows = describeDroppedWindows(defaultAction);

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
      if (!dirty) {
        return config;
      }

      if (services.length === 0) {
        throw new Error("At least one service is required for the default action.");
      }

      return {
        ...config,
        actions: {
          ...config.actions,
          [defaultActionName]: applyServicesToAction(defaultAction, services, nextMode, removed),
        },
      };
    }

    if (action === "add") {
      const name = await input({ message: "Service name", default: `service-${services.length + 1}` });
      const cwd = await input({ message: "Working directory", default: "." });
      const cmd = await input({ message: "Command", default: "npm start" });

      services = [...services, { name, cwd, cmd }];
      removed.delete(name);
      dirty = true;
      continue;
    }

    if (action === "mode") {
      const target = nextMode === "simple" ? "tmux" : "simple";

      if (target === "simple" && droppedWindows) {
        const proceed = await confirmAction(
          `Switching to "simple" keeps only the edited window and drops ${droppedWindows}. Continue?`,
          false,
        );

        if (!proceed) {
          continue;
        }
      }

      nextMode = target;
      dirty = nextMode !== defaultAction.mode || dirty;
      continue;
    }

    if (services.length === 0) {
      console.log("No services available to edit.");
      continue;
    }

    const selectedIndex = await promptServiceSelection(services, "Select a service");
    const selected = services[selectedIndex]!;

    if (action === "remove") {
      services = services.filter((_, index) => index !== selectedIndex);
      removed.add(selected.name);
      dirty = true;
      continue;
    }

    if (action === "command") {
      const cmd = await input({ message: `Command for ${selected.name}`, default: selected.cmd });

      if (cmd !== selected.cmd) {
        services = services.map((service, index) => (index === selectedIndex ? { ...service, cmd } : service));
        dirty = true;
      }

      continue;
    }

    if (action === "cwd") {
      const cwd = await input({ message: `Working directory for ${selected.name}`, default: selected.cwd });

      if (cwd !== selected.cwd) {
        services = services.map((service, index) => (index === selectedIndex ? { ...service, cwd } : service));
        dirty = true;
      }
    }
  }
}
