import { afterEach, describe, expect, test } from "bun:test";

import { detectProject } from "../src/core/detector.ts";
import { generateConfig } from "../src/core/generator.ts";
import { scanProject } from "../src/core/scanner.ts";
import { cleanupTempDir, makeTempDir, writeProjectFile } from "./helpers.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => cleanupTempDir(dir)));
});

describe("scan -> detect -> generate", () => {
  test("generates mixed docker + node tmux config with dependencies", async () => {
    const projectRoot = await makeTempDir("spinup-mixed-");
    tempDirs.push(projectRoot);

    await writeProjectFile(
      projectRoot,
      "package.json",
      JSON.stringify({ name: "mono", workspaces: ["apps/*"] }),
    );
    await writeProjectFile(projectRoot, "pnpm-workspace.yaml", "packages:\n  - apps/*\n");
    await writeProjectFile(projectRoot, "pnpm-lock.yaml", "lockfileVersion: 9\n");
    await writeProjectFile(projectRoot, "docker-compose.yml", "services:\n  db:\n    image: postgres\n");
    await writeProjectFile(
      projectRoot,
      "apps/web/package.json",
      JSON.stringify({
        name: "web",
        dependencies: { next: "15.0.0" },
        scripts: { dev: "next dev" },
      }),
    );
    await writeProjectFile(
      projectRoot,
      "apps/api/package.json",
      JSON.stringify({
        name: "api",
        dependencies: { "@nestjs/core": "11.0.0" },
        scripts: { "start:dev": "nest start --watch" },
      }),
    );

    const scan = await scanProject(projectRoot);
    const detection = detectProject(scan);
    const config = generateConfig(scan, "jims");

    expect(detection.stack).toBe("mixed");
    expect(detection.services.map((service) => service.name)).toEqual(["db", "api", "web"]);
    expect(detection.services.find((service) => service.name === "api")?.dependsOn).toEqual(["db"]);
    expect(detection.services.find((service) => service.name === "web")?.dependsOn).toEqual(["db", "api"]);
    expect(config.actions.dev.mode).toBe("tmux");

    if (config.actions.dev.mode !== "tmux") {
      throw new Error("Expected tmux config");
    }

    expect(config.actions.dev.windows[0].panes.map((pane) => pane.name)).toEqual(["db", "api", "web"]);
    expect(config.actions.docker?.mode).toBe("simple");
  });
});
