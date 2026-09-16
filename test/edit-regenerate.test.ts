import { afterEach, describe, expect, mock, test } from "bun:test";

import { formatProposedChanges } from "../src/commands/run.ts";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { backupConfig, parseConfig, patchConfigYaml, saveConfigPatched } from "../src/core/config.ts";
import { promptForConfigEdits } from "../src/core/interactive.ts";
import type { SpinupConfig } from "../src/types/config.ts";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => cleanupTempDir(dir)));
});

const RICH_CONFIG = [
  "name: p5",
  "root: .",
  "default: dev",
  "actions:",
  "  dev:",
  "    mode: simple",
  "    tasks:",
  "      - name: db",
  "        cwd: .",
  "        cmd: docker compose up db",
  "        delay: 500",
  "      - name: api",
  "        cwd: apps/api",
  "        cmd: npm run dev",
  "        dependsOn:",
  "          - db",
  "        env:",
  "          API_KEY: keep-me",
].join("\n");

describe("interactive editing preserves untouched fields", () => {
  test("a save-only pass keeps env, delay and dependsOn", async () => {
    const config = parseConfig(RICH_CONFIG);
    // Stub the prompt loop: answer "save" immediately.
    const updated = await withPromptAnswers(["save"], config);

    const action = updated!.actions.dev!;
    if (action.mode !== "simple") throw new Error("expected simple action");

    const api = action.tasks!.find((task) => task.name === "api")!;
    const db = action.tasks!.find((task) => task.name === "db")!;

    expect(api.env).toEqual({ API_KEY: "keep-me" });
    expect(api.dependsOn).toEqual(["db"]);
    expect(db.delay).toBe(500);
  });

  test("removing a service drops dangling dependencies on it", async () => {
    const config = parseConfig(RICH_CONFIG);
    const updated = await withPromptAnswers(["remove", 0, "save"], config);

    const action = updated!.actions.dev!;
    if (action.mode !== "simple") throw new Error("expected simple action");

    expect(action.tasks!.map((task) => task.name)).toEqual(["api"]);
    // "db" is gone, so the reference to it must be gone too or the config is invalid.
    expect(action.tasks![0]!.dependsOn).toBeUndefined();
  });
});

/**
 * Drives promptForConfigEdits without a terminal. ESM exports are read-only, so the
 * prompt module is replaced wholesale and answers are returned in order.
 */
const promptQueue: Array<string | number> = [];

const confirmQueue: boolean[] = [];

mock.module("@inquirer/prompts", () => ({
  select: async () => promptQueue.shift(),
  input: async ({ default: fallback }: { default?: string }) => fallback ?? "",
  confirm: async () => confirmQueue.shift() ?? true,
}));

async function withPromptAnswers(answers: Array<string | number>, config: SpinupConfig): Promise<SpinupConfig | null> {
  promptQueue.splice(0, promptQueue.length, ...answers);
  return promptForConfigEdits(config);
}

describe("regeneration change preview", () => {
  const base = parseConfig(
    [
      "name: p",
      "root: .",
      "default: dev",
      "actions:",
      "  dev:",
      "    mode: simple",
      "    tasks:",
      "      - name: api",
      "        cwd: .",
      "        cmd: npm run api",
      "      - name: web",
      "        cwd: .",
      "        cmd: npm run web",
    ].join("\n"),
  );

  function withTasks(commands: Record<string, string>): SpinupConfig {
    const clone = structuredClone(base);
    const action = clone.actions.dev!;
    if (action.mode !== "simple") throw new Error("expected simple action");

    for (const task of action.tasks!) {
      task.cmd = commands[task.name] ?? task.cmd;
    }

    return clone;
  }

  test("reports nothing when the configuration is unchanged", () => {
    expect(formatProposedChanges(base, structuredClone(base))).toEqual([]);
  });

  // The set-of-lines comparison returned [] here, so the change was never applied.
  test("detects two services swapping commands", () => {
    const swapped = withTasks({ api: "npm run web", web: "npm run api" });
    const changes = formatProposedChanges(base, swapped);

    expect(changes).toHaveLength(2);
    expect(changes.join("\n")).toContain("dev.api.cmd");
    expect(changes.join("\n")).toContain("dev.web.cmd");
  });

  test("reports added and removed services", () => {
    const next = structuredClone(base);
    const action = next.actions.dev!;
    if (action.mode !== "simple") throw new Error("expected simple action");
    action.tasks = [action.tasks![0]!, { name: "worker", cwd: ".", cmd: "npm run worker" }];

    const changes = formatProposedChanges(base, next).join("\n");
    expect(changes).toContain("+ dev.worker");
    expect(changes).toContain("- dev.web");
  });

  test("warns that a removed action loses its customization", () => {
    const next = structuredClone(base);
    next.actions.custom = { mode: "simple", tasks: [{ name: "x", cwd: ".", cmd: "true" }] };

    expect(formatProposedChanges(next, base).join("\n")).toContain("- action custom");
  });

  test("notices metadata changes such as the default action", () => {
    const next = structuredClone(base);
    next.actions.other = { mode: "simple", tasks: [{ name: "x", cwd: ".", cmd: "true" }] };
    next.default = "other";

    expect(formatProposedChanges(base, next).join("\n")).toContain("~ default: dev -> other");
  });
});

const MULTI_WINDOW = [
  "name: mw",
  "root: .",
  "default: dev",
  "actions:",
  "  dev:",
  "    mode: tmux",
  "    windows:",
  "      - name: infra",
  "        panes:",
  "          - name: db",
  "            cwd: .",
  "            cmd: docker compose up db",
  "          - name: cache",
  "            cwd: .",
  "            cmd: docker compose up cache",
  "      - name: services",
  "        panes:",
  "          - name: api",
  "            cwd: apps/api",
  "            cmd: npm run dev",
  "            dependsOn:",
  "              - db",
  "              - cache",
  "          - name: web",
  "            cwd: apps/web",
  "            cmd: npm run dev",
  "            dependsOn:",
  "              - api",
  "      - name: logs",
  "        layout: even-vertical",
  "        panes:",
  "          - name: tail",
  "            cwd: .",
  "            cmd: tail -f log",
  "            dependsOn:",
  "              - db",
].join("\n");

describe("interactive editing keeps untouched windows intact", () => {
  test("a save-only pass returns the original config object", async () => {
    const config = parseConfig(MULTI_WINDOW);
    expect(await withPromptAnswers(["save"], config)).toBe(config);
  });

  test("removing a service in one window fixes references from every window and nothing else", async () => {
    const config = parseConfig(MULTI_WINDOW);
    // The editable window is "services"; remove "api" (index 0 there).
    const updated = await withPromptAnswers(["remove", 0, "save"], config);
    const action = updated!.actions.dev!;
    if (action.mode !== "tmux") throw new Error("expected tmux action");

    // Window order and identity are unchanged; no layout was invented.
    expect(action.windows.map((window) => window.name)).toEqual(["infra", "services", "logs"]);
    expect(action.windows[0]!.layout).toBeUndefined();
    expect(action.windows[1]!.layout).toBeUndefined();
    expect(action.windows[2]!.layout).toBe("even-vertical");

    // "web" lost its reference to the removed "api" only.
    expect(action.windows[1]!.panes.map((pane) => pane.name)).toEqual(["web"]);
    expect(action.windows[1]!.panes[0]!.dependsOn).toBeUndefined();
    // Cross-window dependencies on services that still exist survive.
    expect(action.windows[2]!.panes[0]!.dependsOn).toEqual(["db"]);
  });

  test("switching a multi-window action to simple needs consent and can be declined", async () => {
    const config = parseConfig(MULTI_WINDOW);

    confirmQueue.push(false);
    // Declined: mode stays tmux, and with nothing else changed the save is a no-op.
    expect(await withPromptAnswers(["mode", "save"], config)).toBe(config);

    confirmQueue.push(true);
    const updated = await withPromptAnswers(["mode", "save"], config);
    expect(updated!.actions.dev!.mode).toBe("simple");
  });
});

describe("structured edits keep the file's comments", () => {
  const COMMENTED = [
    "# project launcher config",
    "name: p5",
    "root: .",
    "default: dev",
    "actions:",
    "  dev:",
    "    mode: simple",
    "    tasks:",
    "      # the database must be first",
    "      - name: db",
    "        cwd: .",
    "        cmd: docker compose up db",
    "        delay: 500 # give it time",
    "      - name: api",
    "        cwd: apps/api",
    "        cmd: npm run dev",
    "        dependsOn:",
    "          - db",
    "        env:",
    "          API_KEY: keep-me",
    "",
  ].join("\n");

  test("changing one command leaves every comment and unrelated line in place", () => {
    const next = parseConfig(COMMENTED);
    const action = next.actions.dev!;
    if (action.mode !== "simple") throw new Error("expected simple action");
    action.tasks![1]!.cmd = "npm run start";

    const patched = patchConfigYaml(COMMENTED, next);

    expect(patched).toContain("# project launcher config");
    expect(patched).toContain("# the database must be first");
    expect(patched).toContain("delay: 500 # give it time");
    expect(patched).toContain("cmd: npm run start");
    expect(patched).not.toContain("cmd: npm run dev");
    expect(parseConfig(patched)).toEqual(next);
  });

  test("removing a service deletes only its entry", () => {
    const next = parseConfig(COMMENTED);
    const action = next.actions.dev!;
    if (action.mode !== "simple") throw new Error("expected simple action");
    action.tasks = [action.tasks![1]!];
    delete action.tasks[0]!.dependsOn;

    const patched = patchConfigYaml(COMMENTED, next);

    expect(patched).toContain("# project launcher config");
    expect(patched).not.toContain("docker compose up db");
    expect(patched).not.toContain("dependsOn");
    expect(parseConfig(patched)).toEqual(next);
  });

  test("saveConfigPatched writes the patched text", async () => {
    const root = await makeTempDir("spinup-patch-");
    tempDirs.push(root);
    await writeFile(path.join(root, ".spinup.yml"), COMMENTED);

    const next = parseConfig(COMMENTED);
    next.default = "dev";
    const action = next.actions.dev!;
    if (action.mode !== "simple") throw new Error("expected simple action");
    action.tasks![0]!.cwd = "infra";

    await saveConfigPatched(root, next);
    const written = await readFile(path.join(root, ".spinup.yml"), "utf8");
    expect(written).toContain("# the database must be first");
    expect(written).toContain("cwd: infra");
  });
});

describe("regeneration preview covers every field", () => {
  const tmuxBase = parseConfig(MULTI_WINDOW);

  test("reports an env value change by key without printing the value", () => {
    const current = parseConfig(RICH_CONFIG);
    const next = parseConfig(RICH_CONFIG);
    const action = next.actions.dev!;
    if (action.mode !== "simple") throw new Error("expected simple action");
    action.tasks![1]!.env = { API_KEY: "rotated-secret" };

    const changes = formatProposedChanges(current, next).join("\n");
    expect(changes).toContain("~ dev.api.env.API_KEY (value changed)");
    expect(changes).not.toContain("rotated-secret");
    expect(changes).not.toContain("keep-me");
  });

  test("reports a reorder of the same services", () => {
    const current = parseConfig(RICH_CONFIG);
    const next = parseConfig(RICH_CONFIG);
    const action = next.actions.dev!;
    if (action.mode !== "simple") throw new Error("expected simple action");
    action.tasks!.reverse();

    expect(formatProposedChanges(current, next).join("\n")).toContain("~ dev: order db, api -> api, db");
  });

  test("reports window layout and membership changes", () => {
    const next = structuredClone(tmuxBase);
    const action = next.actions.dev!;
    if (action.mode !== "tmux") throw new Error("expected tmux action");
    action.windows[0]!.layout = "tiled";

    expect(formatProposedChanges(tmuxBase, next).join("\n")).toContain("~ dev.windows:");
  });
});

describe("regeneration backup", () => {
  test("keeps the exact previous bytes privately", async () => {
    const root = await makeTempDir("spinup-backup-");
    tempDirs.push(root);
    const configPath = path.join(root, ".spinup.yml");
    await writeFile(configPath, RICH_CONFIG);
    await chmod(configPath, 0o644);

    const backupPath = await backupConfig(root);

    expect(await readFile(backupPath, "utf8")).toBe(RICH_CONFIG);
    expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
  });
});
