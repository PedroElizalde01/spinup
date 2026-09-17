import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";

import { parseConfig, stringifyConfig } from "../src/core/config.ts";
import { detectProject } from "../src/core/detector.ts";
import { generateConfig, generatedComments, NothingToRunError } from "../src/core/generator.ts";
import { scanProject } from "../src/core/scanner.ts";
import type { SpinupConfig } from "../src/types/config.ts";
import { cleanupTempDir, makeTempDir, writeProjectFile } from "./helpers.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => cleanupTempDir(dir)));
});

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await makeTempDir("spinup-detect-");
  tempDirs.push(root);

  for (const [relative, contents] of Object.entries(files)) {
    await writeProjectFile(root, relative, contents);
  }

  return root;
}

async function detect(root: string) {
  const scan = await scanProject(root);
  const detection = detectProject(scan);
  return { scan, detection };
}

/** Every generated config must pass the same validation a hand-written one does. */
async function generate(root: string, name = "fixture"): Promise<SpinupConfig> {
  const { scan, detection } = await detect(root);
  const config = generateConfig(scan, name, detection);
  const rendered = stringifyConfig(config, generatedComments(detection));
  expect(parseConfig(rendered)).toEqual(config);
  return config;
}

function services(config: SpinupConfig) {
  const action = config.actions[config.default]!;
  return action.mode === "tmux" ? action.windows.flatMap((window) => window.panes) : action.tasks ?? [];
}

const json = (value: unknown) => JSON.stringify(value);

describe("workspaces and orchestrators", () => {
  test("mixed Compose and pnpm workspaces: one compose service, members depend on it", async () => {
    const root = await fixture({
      "package.json": json({ name: "mono", workspaces: ["apps/*"] }),
      "pnpm-lock.yaml": "lockfileVersion: 9\n",
      "docker-compose.yml": "services:\n  db:\n    image: postgres\n",
      "apps/web/package.json": json({ name: "web", dependencies: { next: "15.0.0" }, scripts: { dev: "next dev" } }),
      "apps/api/package.json": json({ name: "api", dependencies: { "@nestjs/core": "11.0.0" }, scripts: { "start:dev": "nest start --watch", start: "nest start" } }),
    });

    const config = await generate(root, "jims");
    const panes = services(config);

    expect(config.actions.dev!.mode).toBe("tmux");
    expect(panes.map((pane) => pane.name)).toEqual(["compose", "api", "web"]);
    expect(panes.find((pane) => pane.name === "compose")!.cmd).toBe("docker compose up");
    expect(panes.find((pane) => pane.name === "api")).toMatchObject({ cmd: "pnpm start:dev", cwd: "apps/api", dependsOn: ["compose"] });
    expect(panes.find((pane) => pane.name === "web")!.dependsOn).toEqual(["compose", "api"]);
    expect(config.actions.docker?.mode).toBe("simple");
  });

  // The root script used to vanish on the monorepo path, and every member was launched separately.
  test("a root dev script in a monorepo is the orchestrator; members are not expanded", async () => {
    const root = await fixture({
      "package.json": json({ name: "mono", workspaces: ["packages/*"], scripts: { dev: "turbo dev" } }),
      "pnpm-lock.yaml": "",
      "packages/ui/package.json": json({ name: "ui", scripts: { dev: "vite" } }),
    });

    const { detection } = await detect(root);

    expect(detection.services).toHaveLength(1);
    expect(detection.services[0]).toMatchObject({ name: "app", path: ".", command: "pnpm dev" });
    expect(detection.services[0]!.origin).toContain("package.json scripts.dev");
  });

  test("declared workspace globs outside apps/ are found and exclusions are honored", async () => {
    const root = await fixture({
      "package.json": json({ name: "mono", workspaces: ["components/*", "!components/legacy"] }),
      "components/button/package.json": json({ scripts: { dev: "vite" } }),
      "components/legacy/package.json": json({ scripts: { dev: "vite" } }),
    });

    const { scan, detection } = await detect(root);

    expect(scan.candidates.map((candidate) => candidate.path)).toEqual(["components/button"]);
    expect(detection.services.map((service) => service.name)).toEqual(["button"]);
  });

  test("the packageManager field wins without a lockfile, and a conflicting lockfile is reported", async () => {
    const declaredOnly = await fixture({ "package.json": json({ packageManager: "pnpm@9.1.0", scripts: { dev: "vite" } }) });
    expect((await detect(declaredOnly)).detection.services[0]!.command).toBe("pnpm dev");

    const conflicting = await fixture({ "package.json": json({ packageManager: "pnpm@9.1.0", scripts: { dev: "vite" } }), "yarn.lock": "" });
    const { detection } = await detect(conflicting);
    expect(detection.services[0]!.command).toBe("pnpm dev");
    expect(detection.notes.join("\n")).toContain("lockfile belongs to yarn");
  });
});

describe("nothing is invented", () => {
  test("an empty project detects nothing and generation refuses", async () => {
    const root = await fixture({ "README.md": "hi\n" });
    const { scan, detection } = await detect(root);

    expect(detection.services).toEqual([]);
    expect(() => generateConfig(scan, "empty", detection)).toThrow(NothingToRunError);
  });

  test("a library package with only an index.js is not a server", async () => {
    const root = await fixture({ "package.json": json({ name: "lib", main: "index.js" }), "index.js": "module.exports = {};\n" });
    expect((await detect(root)).detection.services).toEqual([]);
  });

  test("check and test scripts are not development servers", async () => {
    const root = await fixture({ "package.json": json({ scripts: { test: "bun test", check: "tsc --noEmit" } }) });
    expect((await detect(root)).detection.services).toEqual([]);
  });

  test("a FastAPI dependency without an app object is a note, not a guessed command", async () => {
    const root = await fixture({ "requirements.txt": "fastapi\nuvicorn\n" });
    const { detection } = await detect(root);

    expect(detection.services).toEqual([]);
    expect(detection.notes.join("\n")).toContain("FastAPI but no app entrypoint");
  });
});

describe("unique identities", () => {
  test("Node and Python at the root get distinct names", async () => {
    const root = await fixture({
      "package.json": json({ scripts: { dev: "vite" } }),
      "requirements.txt": "flask\n",
      "app.py": "from flask import Flask\napp = Flask(__name__)\n",
    });

    const config = await generate(root);
    expect(services(config).map((service) => service.name).sort()).toEqual(["app-node", "app-python"]);
  });

  test("equal workspace basenames are disambiguated by path", async () => {
    const root = await fixture({
      "package.json": json({ workspaces: ["apps/*", "services/*"] }),
      "apps/api/package.json": json({ scripts: { dev: "vite" } }),
      "services/api/package.json": json({ scripts: { dev: "node server.js" } }),
    });

    const config = await generate(root);
    expect(services(config).map((service) => service.name)).toEqual(["apps-api", "services-api"]);
  });

  test("a Compose service named app does not collide with a Node app or depend on itself", async () => {
    const root = await fixture({
      "package.json": json({ scripts: { dev: "vite" } }),
      "compose.yaml": "services:\n  app:\n    image: nginx\n",
    });

    const config = await generate(root);
    const entries = services(config);

    expect(entries.map((entry) => entry.name)).toEqual(["compose", "app"]);
    expect(entries.every((entry) => !(entry.dependsOn ?? []).includes(entry.name))).toBe(true);
  });
});

describe("compose", () => {
  test("follows Compose's own file precedence, merges the override and leaves profiles optional", async () => {
    const root = await fixture({
      "compose.yaml": [
        "x-base: &base",
        "  restart: always",
        "services:",
        "  db:",
        "    <<: *base",
        "    image: postgres",
        "  cache:",
        "    image: redis",
        "  debug:",
        "    image: busybox",
        "    profiles: [debug]",
      ].join("\n"),
      "docker-compose.yml": "services:\n  legacy:\n    image: nginx\n",
      "compose.override.yaml": "services:\n  extra:\n    image: alpine\n",
    });

    const { scan, detection } = await detect(root);

    expect(scan.compose!.files).toEqual(["compose.yaml", "compose.override.yaml"]);
    expect(scan.compose!.services.map((service) => service.name)).toEqual(["cache", "db", "extra"]);
    expect(detection.services).toHaveLength(1);
    expect(detection.services[0]).toMatchObject({ name: "compose", command: "docker compose up", containers: ["cache", "db", "extra"] });
  });
});

describe("python", () => {
  test("a nested FastAPI service under uv runs through uv from its own directory", async () => {
    const root = await fixture({
      "services/ml/pyproject.toml": "[project]\nname = 'ml'\ndependencies = ['fastapi']\n",
      "services/ml/uv.lock": "",
      "services/ml/app/main.py": "from fastapi import FastAPI\n\napi = FastAPI()\n",
    });

    const { detection } = await detect(root);

    expect(detection.services).toEqual([
      expect.objectContaining({ name: "ml", path: "services/ml", command: "uv run uvicorn app.main:api --reload", runtime: "python" }),
    ]);
    expect(detection.services[0]!.origin).toBe("api = FastAPI() in services/ml/app/main.py");
  });

  test("Django with a local venv uses the venv's python", async () => {
    const root = await fixture({ "manage.py": "", "requirements.txt": "django\n", ".venv/bin/python": "" });
    expect((await detect(root)).detection.services[0]!.command).toBe(".venv/bin/python manage.py runserver");
  });

  test("Django without a venv uses python3", async () => {
    const root = await fixture({ "manage.py": "", "requirements.txt": "django\n" });
    expect((await detect(root)).detection.services[0]!.command).toBe("python3 manage.py runserver");
  });
});

describe("project-owned launchers", () => {
  test("a task runner dev target wins over package scripts, alternatives are noted, and nothing runs while scanning", async () => {
    const root = await fixture({
      Makefile: "dev:\n\ttouch ran-during-scan.txt\n",
      justfile: "dev:\n  echo hi\n",
      "package.json": json({ scripts: { dev: "vite" } }),
      "compose.yaml": "services:\n  db:\n    image: postgres\n",
    });

    const { detection } = await detect(root);
    const config = await generate(root);

    expect(detection.services).toEqual([expect.objectContaining({ name: "app", command: "just dev", runtime: "launcher" })]);
    expect(detection.notes.join("\n")).toContain("Also found Makefile target dev");
    // Compose is still reachable on its own.
    expect(config.actions.docker).toBeDefined();
    expect(await Bun.file(path.join(root, "ran-during-scan.txt")).exists()).toBe(false);
  });

  test("Procfile.dev entries become services and release is skipped", async () => {
    const root = await fixture({
      "Procfile.dev": "web: bin/rails server -p 3000\nworker: bundle exec sidekiq\nrelease: bin/rails db:migrate\n",
    });

    const config = await generate(root);
    expect(services(config).map((service) => [service.name, service.cmd])).toEqual([
      ["web", "bin/rails server -p 3000"],
      ["worker", "bundle exec sidekiq"],
    ]);
  });

  test("an executable bin/dev is preferred over Procfile.dev", async () => {
    const root = await fixture({ "bin/dev": "#!/bin/sh\nforeman start -f Procfile.dev\n", "Procfile.dev": "web: rails s\n" });
    await chmod(path.join(root, "bin", "dev"), 0o755);

    const { detection } = await detect(root);
    expect(detection.services.map((service) => service.command)).toEqual(["bin/dev"]);
  });
});

describe("generated file", () => {
  test("says where each command came from", async () => {
    const root = await fixture({ "package.json": json({ scripts: { dev: "vite" } }) });
    const { scan, detection } = await detect(root);
    const rendered = stringifyConfig(generateConfig(scan, "p", detection), generatedComments(detection));

    expect(rendered).toContain("# from package.json scripts.dev");
    expect(rendered.split("\n")[0]).toBe("# yaml-language-server: $schema=https://raw.githubusercontent.com/PedroElizalde01/spinup/main/schema/spinup.schema.json");
    expect(rendered).toContain("version: 1");
  });
});

describe("scanner resilience", () => {
  test("a malformed package.json does not abort the scan", async () => {
    const root = await fixture({ "package.json": "{ not json", "manage.py": "" });
    await mkdir(path.join(root, "apps"), { recursive: true });

    expect((await detect(root)).detection.services[0]!.command).toBe("python3 manage.py runserver");
  });
});
