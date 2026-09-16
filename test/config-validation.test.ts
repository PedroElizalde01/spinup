import { describe, expect, test } from "bun:test";

import { formatConfigError, parseConfig } from "../src/core/config.ts";

describe("config validation", () => {
  test("rejects duplicate service names in simple actions", () => {
    const raw = [
      "name: jims",
      "root: .",
      "default: dev",
      "actions:",
      "  dev:",
      "    mode: simple",
      "    tasks:",
      "      - name: api",
      "        cwd: .",
      "        cmd: pnpm dev",
      "      - name: api",
      "        cwd: .",
      "        cmd: pnpm dev",
    ].join("\n");

    expect(() => parseConfig(raw)).toThrow();
  });

  test("formats missing command errors clearly", () => {
    const raw = [
      "name: jims",
      "root: .",
      "default: dev",
      "actions:",
      "  dev:",
      "    mode: simple",
      "    tasks:",
      "      - name: api",
      "        cwd: .",
    ].join("\n");

    try {
      parseConfig(raw);
      throw new Error("Expected parse to fail");
    } catch (error) {
      expect(formatConfigError(error)).toContain("actions.dev.tasks.0.cmd");
    }
  });
});

function config(actionBody: string[]): string {
  return ["name: v", "root: .", "default: dev", "actions:", "  dev:", ...actionBody].join("\n");
}

function failure(raw: string): string {
  try {
    parseConfig(raw);
  } catch (error) {
    return formatConfigError(error);
  }

  throw new Error("Expected parse to fail");
}

describe("strict validation", () => {
  // A misspelled key vanished silently and the service started out of order.
  test("rejects unknown keys", () => {
    const raw = config(["    mode: simple", "    tasks:", "      - name: api", "        cwd: .", "        cmd: run", "        dependson: [db]"]);
    expect(failure(raw)).toContain("dependson");
  });

  test("rejects a cycle at load time", () => {
    const raw = config([
      "    mode: simple",
      "    tasks:",
      "      - name: api",
      "        cwd: .",
      "        cmd: run",
      "        dependsOn: [web]",
      "      - name: web",
      "        cwd: .",
      "        cmd: run",
      "        dependsOn: [api]",
    ]);
    expect(failure(raw)).toContain("circular dependency");
  });

  test("rejects a blank command without rewriting it", () => {
    const raw = config(["    mode: simple", "    tasks:", "      - name: api", "        cwd: .", '        cmd: "   "']);
    expect(failure(raw)).toContain("actions.dev.tasks.0.cmd must not be blank");
  });

  test("rejects an environment variable name the shell cannot export", () => {
    const raw = config(["    mode: simple", "    tasks:", "      - name: api", "        cwd: .", "        cmd: run", "        env:", "          BAD-KEY: x"]);
    expect(failure(raw)).toContain("BAD-KEY");
  });

  test("rejects a simple action with no tasks", () => {
    expect(failure(config(["    mode: simple", "    tasks: []"]))).toContain("at least one task");
  });

  // Flattening panes gave a duplicate in the second window a made-up index.
  test("reports a duplicate pane at its real window and pane path", () => {
    const raw = config([
      "    mode: tmux",
      "    windows:",
      "      - name: one",
      "        panes:",
      "          - name: api",
      "            cwd: .",
      "            cmd: run",
      "      - name: two",
      "        panes:",
      "          - name: api",
      "            cwd: .",
      "            cmd: run",
    ]);
    expect(failure(raw)).toContain("actions.dev.windows.1.panes.0.name");
  });

  test("rejects a config version newer than this build", () => {
    const raw = ["version: 2", config(["    mode: simple", "    tasks:", "      - name: a", "        cwd: .", "        cmd: run"])].join("\n");
    expect(failure(raw)).toContain("upgrade spinup");
  });

  test("accepts version 1 and a missing version alike", () => {
    const body = config(["    mode: simple", "    tasks:", "      - name: a", "        cwd: .", "        cmd: run"]);
    expect(parseConfig(body).version).toBeUndefined();
    expect(parseConfig(`version: 1\n${body}`).version).toBe(1);
  });
});
