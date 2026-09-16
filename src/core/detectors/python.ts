import path from "node:path";

import type { DirectoryScan, PythonProject } from "../scanner.ts";
import type { DetectedService } from "./types.ts";

/** Runs a Python tool the way the project does: through uv, poetry, a local venv, or the system. */
function tool(python: PythonProject, name: string): string {
  switch (python.runner) {
    case "uv":
      return `uv run ${name}`;
    case "poetry":
      return `poetry run ${name}`;
    case "venv":
      return `${python.venvDir}/bin/${name}`;
    default:
      // Many systems ship no bare "python"; python3 is what actually exists.
      return name === "python" ? "python3" : name;
  }
}

function relative(directory: string, file: string): string {
  return directory === "." ? file : path.posix.join(directory, file);
}

export function detectPythonFrameworks(python: PythonProject | undefined): string[] {
  if (!python) {
    return [];
  }

  const frameworks = new Set<string>();

  if (python.hasManagePy || python.manifest.includes("django")) frameworks.add("Django");
  if (python.manifest.includes("fastapi") || python.entries.some((entry) => entry.framework === "FastAPI")) frameworks.add("FastAPI");
  if (python.manifest.includes("flask") || python.entries.some((entry) => entry.framework === "Flask")) frameworks.add("Flask");

  return [...frameworks];
}

export function detectPythonService(
  name: string,
  directory: DirectoryScan,
  notes: string[],
): DetectedService | undefined {
  const python = directory.python;

  if (!python) {
    return undefined;
  }

  const base = { name, path: directory.path, runtime: "python" as const };

  if (python.hasManagePy) {
    return {
      ...base,
      command: `${tool(python, "python")} manage.py runserver`,
      origin: `${relative(directory.path, "manage.py")} exists`,
      framework: "Django",
    };
  }

  const entry = python.entries[0];

  if (entry?.framework === "FastAPI") {
    const appDir = entry.appDir ? ` --app-dir ${entry.appDir}` : "";
    return {
      ...base,
      command: `${tool(python, "uvicorn")} ${entry.module}:${entry.variable} --reload${appDir}`,
      origin: `${entry.variable} = FastAPI() in ${relative(directory.path, entry.file)}`,
      framework: "FastAPI",
    };
  }

  if (entry?.framework === "Flask") {
    const target = entry.appDir ? `${entry.appDir}/${entry.module.split(".").join("/")}.py` : `${entry.module}:${entry.variable}`;
    return {
      ...base,
      command: `${tool(python, "flask")} --app ${target} run --debug`,
      origin: `${entry.variable} = Flask() in ${relative(directory.path, entry.file)}`,
      framework: "Flask",
    };
  }

  // A framework in the dependencies is not an entrypoint. Say so instead of guessing.
  for (const framework of detectPythonFrameworks(python)) {
    notes.push(
      `${directory.path === "." ? "The project" : directory.path} depends on ${framework} but no app entrypoint was found; add its command to the config.`,
    );
  }

  return undefined;
}
