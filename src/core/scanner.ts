import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";

import { inspectCompose, type ComposeProject } from "../docker/compose.ts";

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun" | "unknown";

export type PackageJsonData = {
  name?: string;
  packageManager?: string;
  bin?: string | Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: unknown;
};

/** A Python app object found in source, e.g. `app = FastAPI()` in app/main.py. */
export type PythonEntry = {
  framework: "FastAPI" | "Flask";
  /** Relative source file the object was found in. */
  file: string;
  /** Import path for uvicorn/flask, relative to appDir. */
  module: string;
  variable: string;
  /** Directory to import from when the source lives under src/. */
  appDir?: string;
};

export type PythonProject = {
  /** Lowercased concatenation of the manifests, for dependency lookups. */
  manifest: string;
  hasManagePy: boolean;
  /** How the project runs its Python: an explicit tool, a local venv, or the system. */
  runner?: "uv" | "poetry" | "venv";
  venvDir?: string;
  entries: PythonEntry[];
};

/** Files other ecosystems use to declare a runnable application. Absent means not found. */
export type EcosystemFacts = {
  goMod?: string;
  goMainAtRoot: boolean;
  /** cmd/<name> directories that contain a main package. */
  goCommands: string[];
  airConfig: boolean;
  cargoToml?: string;
  rustMain: boolean;
  gemfile?: string;
  railsBin: boolean;
  configRu: boolean;
  artisan: boolean;
  composerJson?: string;
  publicIndexPhp: boolean;
  gradleBuild?: string;
  gradleFile?: "build.gradle" | "build.gradle.kts";
  gradlew: boolean;
  pomXml?: string;
  mvnw: boolean;
  denoTasks?: Record<string, string>;
};

export type DirectoryScan = {
  /** Relative to the project root; "." for the root itself. */
  path: string;
  packageJson?: PackageJsonData;
  python?: PythonProject;
  hasServerJs: boolean;
  hasIndexJs: boolean;
  ecosystem: EcosystemFacts;
};

/** True when a directory holds a project of any supported ecosystem. */
export function hasAnyProject(directory: DirectoryScan): boolean {
  const facts = directory.ecosystem;
  return Boolean(
    directory.packageJson ||
      directory.python ||
      facts.goMod ||
      facts.cargoToml ||
      facts.gemfile ||
      facts.railsBin ||
      facts.artisan ||
      facts.composerJson ||
      facts.gradleBuild ||
      facts.pomXml ||
      facts.denoTasks,
  );
}

/** A command the project itself defines for development, with where it came from. */
export type LauncherGroup = {
  origin: string;
  services: Array<{ name: string; command: string; origin: string }>;
};

export type ScanResult = {
  root: DirectoryScan;
  packageManager: PackageManager;
  packageManagerSource: string;
  packageManagerConflict?: string;
  monorepo: boolean;
  workspaceDeclared: boolean;
  /** Workspace members, or apps/ services/ packages/ crates/ children when nothing is declared. */
  candidates: DirectoryScan[];
  launchers: LauncherGroup[];
  compose?: ComposeProject;
  prisma: boolean;
};

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
      return false;
    }

    throw error;
  }
}

async function readTextIfExists(targetPath: string): Promise<string | undefined> {
  try {
    return await readFile(targetPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") {
      return undefined;
    }

    throw error;
  }
}

async function readPackageJson(targetPath: string): Promise<PackageJsonData | undefined> {
  const raw = await readTextIfExists(targetPath);

  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as PackageJsonData;
  } catch {
    // A broken manifest is not a runnable project; do not abort the whole scan.
    return undefined;
  }
}

async function childDirectories(projectRoot: string, relativeDir: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(projectRoot, relativeDir), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => path.posix.join(relativeDir, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
      return [];
    }

    throw error;
  }
}

const PYTHON_ENTRY_FILES = ["main.py", "app.py", "server.py", "wsgi.py", "asgi.py", "app/main.py", "src/main.py", "src/app.py"];
const PYTHON_APP_PATTERNS: Array<[PythonEntry["framework"], RegExp]> = [
  ["FastAPI", /^(\w+)\s*=\s*FastAPI\(/m],
  ["Flask", /^(\w+)\s*=\s*Flask\(/m],
];

async function scanPython(directory: string): Promise<PythonProject | undefined> {
  const [requirements, pyproject, poetryLock, uvLock, setupPy, hasManagePy] = await Promise.all([
    readTextIfExists(path.join(directory, "requirements.txt")),
    readTextIfExists(path.join(directory, "pyproject.toml")),
    pathExists(path.join(directory, "poetry.lock")),
    pathExists(path.join(directory, "uv.lock")),
    pathExists(path.join(directory, "setup.py")),
    pathExists(path.join(directory, "manage.py")),
  ]);

  if (requirements === undefined && pyproject === undefined && !poetryLock && !uvLock && !setupPy && !hasManagePy) {
    return undefined;
  }

  const entries: PythonEntry[] = [];

  // Entrypoints are confirmed by finding the app object in source, not guessed
  // from a dependency name: "fastapi" in requirements used to mean `uvicorn main:app`
  // whether or not main.py existed.
  for (const file of PYTHON_ENTRY_FILES) {
    const source = await readTextIfExists(path.join(directory, file));

    if (source === undefined) {
      continue;
    }

    for (const [framework, pattern] of PYTHON_APP_PATTERNS) {
      const match = pattern.exec(source);

      if (!match) {
        continue;
      }

      const underSrc = file.startsWith("src/");
      const importPath = (underSrc ? file.slice("src/".length) : file).replace(/\.py$/, "").split("/").join(".");
      entries.push({ framework, file, module: importPath, variable: match[1]!, appDir: underSrc ? "src" : undefined });
    }
  }

  let runner: PythonProject["runner"];
  let venvDir: string | undefined;

  if (uvLock) {
    runner = "uv";
  } else if (poetryLock) {
    runner = "poetry";
  } else {
    for (const candidate of [".venv", "venv"]) {
      if (await pathExists(path.join(directory, candidate, "bin"))) {
        runner = "venv";
        venvDir = candidate;
        break;
      }
    }
  }

  return {
    manifest: [requirements, pyproject].filter(Boolean).join("\n").toLowerCase(),
    hasManagePy,
    runner,
    venvDir,
    entries,
  };
}

const GO_MAIN = /^package\s+main\b/m;

async function isGoMain(file: string): Promise<boolean> {
  const source = await readTextIfExists(file);
  return source !== undefined && GO_MAIN.test(source);
}

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    const stats = await stat(file);
    return stats.isFile();
  } catch {
    return false;
  }
}

/** Parses deno.json, or deno.jsonc with its comments removed; only tasks matter. */
function denoTasks(raw: string | undefined): Record<string, string> | undefined {
  if (raw === undefined) {
    return undefined;
  }

  try {
    const withoutComments = raw.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const parsed = JSON.parse(withoutComments) as { tasks?: Record<string, string> };
    return parsed.tasks ?? {};
  } catch {
    return {};
  }
}

async function scanEcosystems(directory: string): Promise<EcosystemFacts> {
  const goMod = await readTextIfExists(path.join(directory, "go.mod"));
  const goCommands: string[] = [];

  if (goMod !== undefined) {
    for (const command of await childDirectories(directory, "cmd")) {
      if (await isGoMain(path.join(directory, command, "main.go"))) {
        goCommands.push(path.posix.basename(command));
      }
    }
  }

  const [
    goMainAtRoot,
    airConfig,
    cargoToml,
    rustMain,
    gemfile,
    railsBin,
    configRu,
    artisan,
    composerJson,
    publicIndexPhp,
    gradleGroovy,
    gradleKotlin,
    gradlew,
    pomXml,
    mvnw,
    denoJson,
    denoJsonc,
  ] = await Promise.all([
    goMod !== undefined ? isGoMain(path.join(directory, "main.go")) : Promise.resolve(false),
    pathExists(path.join(directory, ".air.toml")),
    readTextIfExists(path.join(directory, "Cargo.toml")),
    pathExists(path.join(directory, "src", "main.rs")),
    readTextIfExists(path.join(directory, "Gemfile")),
    isExecutableFile(path.join(directory, "bin", "rails")),
    pathExists(path.join(directory, "config.ru")),
    isExecutableFile(path.join(directory, "artisan")),
    readTextIfExists(path.join(directory, "composer.json")),
    pathExists(path.join(directory, "public", "index.php")),
    readTextIfExists(path.join(directory, "build.gradle")),
    readTextIfExists(path.join(directory, "build.gradle.kts")),
    pathExists(path.join(directory, "gradlew")),
    readTextIfExists(path.join(directory, "pom.xml")),
    pathExists(path.join(directory, "mvnw")),
    readTextIfExists(path.join(directory, "deno.json")),
    readTextIfExists(path.join(directory, "deno.jsonc")),
  ]);

  return {
    goMod,
    goMainAtRoot,
    goCommands: goCommands.sort(),
    airConfig: goMod !== undefined && airConfig,
    cargoToml,
    rustMain,
    gemfile,
    railsBin,
    configRu,
    artisan,
    composerJson,
    publicIndexPhp,
    gradleBuild: gradleKotlin ?? gradleGroovy,
    gradleFile: gradleKotlin !== undefined ? "build.gradle.kts" : gradleGroovy !== undefined ? "build.gradle" : undefined,
    gradlew,
    pomXml,
    mvnw,
    denoTasks: denoTasks(denoJson ?? denoJsonc),
  };
}

async function scanDirectory(projectRoot: string, relativePath: string): Promise<DirectoryScan> {
  const directory = path.join(projectRoot, relativePath);
  const [packageJson, python, hasServerJs, hasIndexJs, ecosystem] = await Promise.all([
    readPackageJson(path.join(directory, "package.json")),
    scanPython(directory),
    pathExists(path.join(directory, "server.js")),
    pathExists(path.join(directory, "index.js")),
    scanEcosystems(directory),
  ]);

  return { path: relativePath, packageJson, python, hasServerJs, hasIndexJs, ecosystem };
}

const LOCKFILES: Array<[string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

/**
 * The declared `packageManager` field is intent; a lockfile is evidence. The field
 * used to be ignored entirely, so a pnpm project without a committed lockfile was
 * launched with npm.
 */
async function resolvePackageManager(
  projectRoot: string,
  packageJson: PackageJsonData | undefined,
): Promise<Pick<ScanResult, "packageManager" | "packageManagerSource" | "packageManagerConflict">> {
  const found: PackageManager[] = [];

  for (const [file, manager] of LOCKFILES) {
    if ((await pathExists(path.join(projectRoot, file))) && !found.includes(manager)) {
      found.push(manager);
    }
  }

  const declared = /^(pnpm|npm|yarn|bun)@/.exec(packageJson?.packageManager ?? "")?.[1] as PackageManager | undefined;

  if (declared) {
    const conflict =
      found.length > 0 && !found.includes(declared)
        ? `package.json declares ${declared} but the lockfile belongs to ${found.join(", ")}`
        : undefined;
    return { packageManager: declared, packageManagerSource: "package.json packageManager", packageManagerConflict: conflict };
  }

  if (found.length > 0) {
    return {
      packageManager: found[0]!,
      packageManagerSource: "lockfile",
      packageManagerConflict: found.length > 1 ? `lockfiles for several package managers are present: ${found.join(", ")}` : undefined,
    };
  }

  return { packageManager: "npm", packageManagerSource: "default" };
}

async function workspacePatterns(projectRoot: string, packageJson: PackageJsonData | undefined): Promise<string[] | undefined> {
  const declared = packageJson?.workspaces;
  const fromPackageJson = Array.isArray(declared)
    ? declared
    : Array.isArray((declared as { packages?: unknown } | undefined)?.packages)
      ? (declared as { packages: unknown[] }).packages
      : undefined;

  const pnpmRaw = await readTextIfExists(path.join(projectRoot, "pnpm-workspace.yaml"));
  let fromPnpm: unknown[] | undefined;

  if (pnpmRaw !== undefined) {
    try {
      const parsed = YAML.parse(pnpmRaw) as { packages?: unknown } | undefined;
      fromPnpm = Array.isArray(parsed?.packages) ? parsed.packages : [];
    } catch {
      fromPnpm = [];
    }
  }

  if (!fromPackageJson && !fromPnpm) {
    return undefined;
  }

  return [...(fromPackageJson ?? []), ...(fromPnpm ?? [])].filter((pattern): pattern is string => typeof pattern === "string");
}

/**
 * Expands declared workspace globs to member directories, honoring "!" exclusions.
 * Only apps/, services/ and packages/ were considered before, so `components/*`
 * members were invisible and excluded members were still launched.
 */
async function resolveWorkspaces(projectRoot: string, patterns: string[]): Promise<string[]> {
  const includes = patterns.filter((pattern) => !pattern.startsWith("!"));
  const excludes = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => new Bun.Glob(pattern.slice(1).replace(/\/+$/, "")));
  const members = new Set<string>();

  for (const include of includes) {
    const base = include.replace(/^\.\//, "").replace(/\/+$/, "");

    if (base === "" || base === ".") {
      continue;
    }

    const glob = new Bun.Glob(`${base}/package.json`);

    for await (const match of glob.scan({ cwd: projectRoot, onlyFiles: true })) {
      const member = path.posix.dirname(match.split(path.sep).join("/"));

      if (member.split("/").includes("node_modules")) {
        continue;
      }

      if (!excludes.some((exclude) => exclude.match(member))) {
        members.add(member);
      }
    }
  }

  return [...members].sort((left, right) => left.localeCompare(right));
}

const PROCFILE_LINE = /^([A-Za-z0-9_-]+):\s*(.+)$/;

async function findLaunchers(projectRoot: string): Promise<LauncherGroup[]> {
  const groups: LauncherGroup[] = [];

  try {
    const binDev = await stat(path.join(projectRoot, "bin", "dev"));

    if (binDev.isFile() && (binDev.mode & 0o111) !== 0) {
      groups.push({ origin: "bin/dev", services: [{ name: "app", command: "bin/dev", origin: "bin/dev" }] });
    }
  } catch {
    // No bin/dev.
  }

  const procfile = await readTextIfExists(path.join(projectRoot, "Procfile.dev"));

  if (procfile !== undefined) {
    const services = procfile
      .split("\n")
      .map((line) => PROCFILE_LINE.exec(line.trim()))
      .filter((match): match is RegExpExecArray => Boolean(match))
      // `release` is a one-shot deploy step, not a process to supervise.
      .filter((match) => match[1] !== "release")
      .map((match) => ({ name: match[1]!, command: match[2]!.trim(), origin: `Procfile.dev ${match[1]}` }));

    if (services.length > 0) {
      groups.push({ origin: "Procfile.dev", services });
    }
  }

  const taskRunners: Array<{ files: string[]; test: (raw: string) => boolean; command: string; label: string }> = [
    { files: ["justfile", "Justfile", ".justfile"], test: (raw) => /^dev(?:\s[^:=\n]*)?:(?!=)/m.test(raw), command: "just dev", label: "recipe dev" },
    { files: ["Makefile", "makefile", "GNUmakefile"], test: (raw) => /^dev\s*:(?!=)/m.test(raw), command: "make dev", label: "target dev" },
    {
      files: ["Taskfile.yml", "Taskfile.yaml"],
      test: (raw) => {
        try {
          return Boolean((YAML.parse(raw) as { tasks?: Record<string, unknown> } | undefined)?.tasks?.dev);
        } catch {
          return false;
        }
      },
      command: "task dev",
      label: "task dev",
    },
    { files: ["mise.toml", ".mise.toml"], test: (raw) => /^\[tasks\.(?:dev|"dev")\]/m.test(raw), command: "mise run dev", label: "task dev" },
  ];

  for (const runner of taskRunners) {
    for (const file of runner.files) {
      const raw = await readTextIfExists(path.join(projectRoot, file));

      if (raw !== undefined && runner.test(raw)) {
        const origin = `${file} ${runner.label}`;
        groups.push({ origin, services: [{ name: "app", command: runner.command, origin }] });
        break;
      }
    }
  }

  return groups;
}

/** Reads the project. Nothing is executed except `docker compose config`, which starts nothing. */
/**
 * Task directories whose package.json declares dependencies but have no
 * node_modules. Launching there fails with "command not found" a few lines
 * later; naming the missing install first saves the guess.
 */
export async function directoriesMissingNodeModules(directories: string[]): Promise<string[]> {
  const missing: string[] = [];

  for (const directory of [...new Set(directories)]) {
    const manifest = await readPackageJson(path.join(directory, "package.json"));
    const declared = Object.keys({ ...manifest?.dependencies, ...manifest?.devDependencies }).length > 0;

    if (declared && !(await pathExists(path.join(directory, "node_modules")))) {
      missing.push(directory);
    }
  }

  return missing;
}

export async function scanProject(projectRoot: string): Promise<ScanResult> {
  const resolvedRoot = path.resolve(projectRoot);
  const root = await scanDirectory(resolvedRoot, ".");
  const patterns = await workspacePatterns(resolvedRoot, root.packageJson);
  const conventional = (
    await Promise.all(["apps", "services", "packages", "crates"].map((dir) => childDirectories(resolvedRoot, dir)))
  ).flat();
  const declaredMembers = patterns ? await resolveWorkspaces(resolvedRoot, patterns) : [];

  // Declared workspaces are authoritative for JavaScript members. Conventional
  // directories still contribute Python services a JS workspace cannot declare.
  const candidatePaths = patterns ? declaredMembers : conventional;
  const candidates = await Promise.all(candidatePaths.map((relative) => scanDirectory(resolvedRoot, relative)));

  if (patterns) {
    for (const relative of conventional) {
      if (declaredMembers.includes(relative)) {
        continue;
      }

      const scanned = await scanDirectory(resolvedRoot, relative);

      // A JS workspace declaration cannot list a Python, Go or Rust service.
      if (!scanned.packageJson && hasAnyProject(scanned)) {
        candidates.push(scanned);
      }
    }
  }

  const [packageManager, launchers, compose, prisma, hasTurbo, hasNx] = await Promise.all([
    resolvePackageManager(resolvedRoot, root.packageJson),
    findLaunchers(resolvedRoot),
    inspectCompose(resolvedRoot),
    pathExists(path.join(resolvedRoot, "prisma", "schema.prisma")),
    pathExists(path.join(resolvedRoot, "turbo.json")),
    pathExists(path.join(resolvedRoot, "nx.json")),
  ]);

  return {
    root,
    ...packageManager,
    monorepo: Boolean(patterns) || hasTurbo || hasNx || candidates.some((candidate) => hasAnyProject(candidate)),
    workspaceDeclared: Boolean(patterns),
    candidates: candidates.sort((left, right) => left.path.localeCompare(right.path)),
    launchers,
    compose,
    prisma,
  };
}
