import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { parseConfig } from "../src/core/config.ts";
import { getProject, registerProject } from "../src/core/registry.ts";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";

// Scripted answers for the prompts, in order. DEFAULT takes the prompt's default.
const DEFAULT = Symbol("default");
const answers: unknown[] = [];

function next(fallback?: unknown): unknown {
  const value = answers.shift();

  if (value instanceof Error) throw value;
  return value === DEFAULT ? fallback : value;
}

mock.module("@inquirer/prompts", () => ({
  input: async ({ default: fallback }: { default?: string }) => next(fallback),
  select: async () => next(),
  confirm: async ({ default: fallback }: { default?: boolean }) => next(fallback),
}));

const { initProject } = await import("../src/commands/init.ts");

let root: string;
let project: string;
const saved = { config: process.env.XDG_CONFIG_HOME, shims: process.env.SPINUP_SHIM_DIR, tty: process.stdin.isTTY, cwd: process.cwd() };

function setTty(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
}

beforeEach(async () => {
  root = await makeTempDir("spinup-init-");
  await mkdir(path.join(root, "shop-api"), { recursive: true });
  // process.cwd() reports the real path; on macOS /var is /private/var.
  project = await realpath(path.join(root, "shop-api"));
  await mkdir(path.join(root, "bin"), { recursive: true });
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  process.env.SPINUP_SHIM_DIR = path.join(root, "bin");
  answers.length = 0;
  setTty(true);
  process.chdir(project);
});

afterEach(async () => {
  process.chdir(saved.cwd);
  setTty(saved.tty);
  process.env.XDG_CONFIG_HOME = saved.config;
  process.env.SPINUP_SHIM_DIR = saved.shims;
  if (saved.config === undefined) delete process.env.XDG_CONFIG_HOME;
  if (saved.shims === undefined) delete process.env.SPINUP_SHIM_DIR;
  await cleanupTempDir(root);
});

async function silently<T>(run: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => undefined;

  try {
    return await run();
  } finally {
    console.log = log;
  }
}

describe("spinup --init", () => {
  test("reviews detected services, applies edits and additions, and writes only after confirming", async () => {
    await writeFile(path.join(project, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));

    answers.push(
      DEFAULT, // alias: suggested from the directory name
      "edit", 0, "npm run dev -- --port 4000", DEFAULT, // change the detected command
      "add", "worker", ".", "node worker.js", // add a service
      "continue",
      "simple", // run in this terminal
      DEFAULT, // Go ahead? yes
    );

    await silently(() => initProject(undefined));

    expect(await getProject("shop-api")).toBe(project);
    expect(await Bun.file(path.join(root, "bin", "shop-api")).exists()).toBe(true);

    const written = await readFile(path.join(project, ".spinup.yml"), "utf8");
    const config = parseConfig(written);
    expect(config.actions.dev).toEqual({
      mode: "simple",
      tasks: [
        { name: "app", cwd: ".", cmd: "npm run dev -- --port 4000" },
        { name: "worker", cwd: ".", cmd: "node worker.js" },
      ],
    });
    expect(written).toContain("# from edited during --init");
  });

  test.each([
    ["answering no at the preview", [DEFAULT, "add", "app", ".", "make run", "continue", false]],
    ["cancelling a prompt", [Object.assign(new Error("User force closed the prompt"), { name: "ExitPromptError" })]],
  ])("%s writes nothing", async (_label, scripted) => {
    answers.push(...scripted);

    await silently(() => initProject(undefined));

    expect(await readdir(project)).toEqual([]);
    expect(await readdir(path.join(root, "bin"))).toEqual([]);
    expect(await getProject("shop-api")).toBeUndefined();
  });

  test("needs a terminal", async () => {
    setTty(false);
    await expect(initProject(undefined)).rejects.toThrow("needs a terminal");
  });

  test("refuses an alias that is already registered and points at --relink", async () => {
    await registerProject("shop-api", root);
    answers.push(DEFAULT);

    await expect(silently(() => initProject(undefined))).rejects.toThrow("spinup shop-api --relink");
  });

  test("an existing config is used as it is", async () => {
    const config = "name: shop\nroot: .\ndefault: dev\nactions:\n  dev:\n    mode: simple\n    tasks:\n      - { name: app, cwd: ., cmd: make run }\n";
    await writeFile(path.join(project, ".spinup.yml"), config);
    answers.push("shop", DEFAULT);

    await silently(() => initProject(undefined));

    expect(await readFile(path.join(project, ".spinup.yml"), "utf8")).toBe(config);
    expect(await getProject("shop")).toBe(project);
  });
});
