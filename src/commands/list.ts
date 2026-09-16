import { homedir } from "node:os";

import { configExists, loadConfig } from "../core/config.ts";
import { listProjects } from "../core/registry.ts";
import { emit } from "../ui/output.ts";

type ProjectRow = {
  alias: string;
  root: string;
  /** "ok", "missing" (no file) or "invalid" (does not validate). */
  config: "ok" | "missing" | "invalid";
  defaultAction: string | null;
  mode: "simple" | "tmux" | null;
  actions: string[];
};

function compactHome(projectPath: string): string {
  const home = homedir();
  return projectPath.startsWith(home) ? projectPath.replace(home, "~") : projectPath;
}

async function describe(alias: string, root: string): Promise<ProjectRow> {
  const row: ProjectRow = { alias, root, config: "missing", defaultAction: null, mode: null, actions: [] };

  if (!(await configExists(root).catch(() => false))) {
    return row;
  }

  try {
    const config = await loadConfig(root);
    row.config = "ok";
    row.defaultAction = config.default;
    row.mode = config.actions[config.default]?.mode ?? null;
    row.actions = Object.keys(config.actions);
  } catch {
    row.config = "invalid";
  }

  return row;
}

function pad(value: string, width: number): string {
  return value.padEnd(width);
}

export async function listRegisteredProjects(): Promise<void> {
  const projects = await listProjects();
  const entries = Object.entries(projects).sort(([left], [right]) => left.localeCompare(right));
  const rows = await Promise.all(entries.map(([alias, root]) => describe(alias, root)));

  emit(rows, () => {
    if (rows.length === 0) {
      console.log("Registered projects:\n");
      console.log("(none)");
      return;
    }

    const columns = rows.map((row) => [
      row.alias,
      row.config === "ok" ? `${row.defaultAction} (${row.mode})` : row.config === "missing" ? "no config" : "invalid config",
      compactHome(row.root),
    ]);
    const widths = [0, 1].map((index) => Math.max(...columns.map((column) => column[index]!.length)));

    console.log("Registered projects:\n");

    for (const [alias, action, root] of columns) {
      console.log(`${pad(alias!, widths[0]!)}  ${pad(action!, widths[1]!)}  ${root}`);
    }
  });
}
