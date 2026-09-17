import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { execa } from "execa";

import { cleanupTempDir, makeTempDir } from "./helpers.ts";

// The real completion scripts, driven by bash with a `spinup` on PATH that runs this
// checkout against an isolated registry.
const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

let root: string;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  root = await makeTempDir("spinup-completion-");
  const project = path.join(root, "project");
  await mkdir(path.join(root, "wrapper"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(
    path.join(project, ".spinup.yml"),
    [
      "name: comp",
      "root: .",
      "default: dev",
      "actions:",
      "  dev:",
      "    mode: tmux",
      "    windows:",
      "      - name: services",
      "        panes:",
      "          - { name: api, cwd: ., cmd: sleep 1 }",
      "          - { name: web, cwd: ., cmd: sleep 1 }",
      "  migrate:",
      "    mode: simple",
      "    tasks:",
      "      - { name: schema, cwd: ., cmd: sleep 1 }",
      "",
    ].join("\n"),
  );
  await writeFile(path.join(root, "wrapper", "spinup"), `#!/bin/sh\nexec bun run ${CLI} "$@"\n`);
  await chmod(path.join(root, "wrapper", "spinup"), 0o755);

  env = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, "config"),
    SPINUP_SHIM_DIR: path.join(root, "bin"),
    PATH: `${path.join(root, "wrapper")}:${process.env.PATH}`,
    NO_COLOR: "1",
  };

  await execa("spinup", ["myapp"], { cwd: project, env });
}, 30_000);

afterAll(async () => {
  await cleanupTempDir(root);
});

/** Loads the bash script, completes the given words, and returns COMPREPLY. */
async function complete(words: string[]): Promise<string[]> {
  const script = [
    'eval "$(spinup --completion bash)"',
    `COMP_WORDS=(${words.map((word) => `'${word}'`).join(" ")})`,
    `COMP_CWORD=${words.length - 1}`,
    "_spinup_complete",
    'printf "%s\\n" "${COMPREPLY[@]}"',
  ].join("\n");
  const { stdout } = await execa("bash", ["-c", script], { env });
  return stdout.split("\n").filter(Boolean);
}

describe("shell completion", () => {
  test("every script is valid for its shell", async () => {
    for (const shell of ["bash", "zsh", "fish"] as const) {
      const { stdout } = await execa("spinup", ["--completion", shell], { env });

      const binary = Bun.which(shell);
      if (!binary) continue;
      // A file, not stdin: fish 3.7 refuses to syntax-check from a pipe.
      const file = path.join(root, `completion.${shell}`);
      await writeFile(file, stdout);
      const check = await execa(binary, ["-n", file], { env, reject: false });
      expect(`${shell} ${check.exitCode} ${check.stderr}`).toBe(`${shell} 0 `);
    }
  }, 30_000);

  test("completes registered aliases after spinup", async () => {
    expect(await complete(["spinup", "my"])).toEqual(["myapp"]);
  }, 30_000);

  test("completes flags from the CLI definition", async () => {
    const flags = await complete(["spinup", "myapp", "--st"]);
    expect(flags).toEqual(expect.arrayContaining(["--status", "--stop"]));
    expect(flags).not.toContain("--complete");
  }, 30_000);

  test("completes actions after --action and services after --restart, through the alias command too", async () => {
    expect((await complete(["spinup", "myapp", "--action", ""])).sort()).toEqual(["dev", "migrate"]);
    expect((await complete(["myapp", "--restart", ""])).sort()).toEqual(["api", "web"]);
  }, 30_000);

  test("an unknown alias offers nothing and prints nothing", async () => {
    const { stdout, stderr } = await execa("spinup", ["--complete", "actions", "nope"], { env, reject: false });
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  }, 30_000);
});
