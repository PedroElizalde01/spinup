import { afterEach, describe, expect, mock, test } from "bun:test";

import { formatProposedChanges } from "../src/commands/run.ts";
import { parseConfig } from "../src/core/config.ts";
import { promptForConfigEdits } from "../src/core/interactive.ts";
import type { RunitConfig } from "../src/types/config.ts";
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

mock.module("@inquirer/prompts", () => ({
  select: async () => promptQueue.shift(),
  input: async ({ default: fallback }: { default?: string }) => fallback ?? "",
  confirm: async () => true,
}));

async function withPromptAnswers(answers: Array<string | number>, config: RunitConfig): Promise<RunitConfig | null> {
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

  function withTasks(commands: Record<string, string>): RunitConfig {
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
