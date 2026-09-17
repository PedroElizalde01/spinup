import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

import { formatConfigError, parseConfig } from "../src/core/config.ts";

// Documentation examples are part of the contract: a complete config shown in docs/
// or the README must be one spinup accepts.
const DOCS = new URL("../docs/", import.meta.url).pathname;

async function examples(): Promise<Array<[string, string]>> {
  const files = [...(await readdir(DOCS)).map((file) => `${DOCS}${file}`), new URL("../README.md", import.meta.url).pathname];
  const found: Array<[string, string]> = [];

  for (const file of files) {
    const text = await Bun.file(file).text();

    for (const match of text.matchAll(/```yaml\n([\s\S]*?)```/g)) {
      // Fragments (a single action or task list) are illustrations; full files are checked.
      if (/^name:/m.test(match[1]!) && /^actions:/m.test(match[1]!)) {
        found.push([file.split("/").slice(-2).join("/"), match[1]!]);
      }
    }
  }

  return found;
}

describe("documentation", () => {
  test("has complete config examples to check", async () => {
    expect((await examples()).length).toBeGreaterThanOrEqual(2);
  });

  test("every complete config example validates", async () => {
    for (const [file, yaml] of await examples()) {
      try {
        parseConfig(yaml);
      } catch (error) {
        throw new Error(`${file}: ${formatConfigError(error)}`);
      }
    }
  });

  test("every docs page is listed for the website", async () => {
    const pages = (await readdir(DOCS)).filter((file) => file.endsWith(".md")).sort();
    expect(pages).toEqual(["commands.md", "configuration.md", "detection.md", "installation.md", "quick-start.md", "sessions.md", "upgrading.md"]);
  });
});

describe("website hero", () => {
  test("site/hero-card.json is what the CLI prints for the fixture project", async () => {
    const { renderHeroCard } = await import("../scripts/site-hero-card.ts");
    expect(await Bun.file(new URL("../site/hero-card.json", import.meta.url)).text()).toBe(await renderHeroCard());
  });
});

describe("website flag demos", () => {
  test("site/flag-outputs.json holds one non-empty output per demo, in order", async () => {
    const { FLAG_DEMOS } = await import("../scripts/site-flag-outputs.ts");
    const outputs = JSON.parse(await Bun.file(new URL("../site/flag-outputs.json", import.meta.url)).text()) as Array<{ flag: string; output: string }>;
    expect(outputs.map((entry) => entry.flag)).toEqual(FLAG_DEMOS.map((demo) => demo.flag));
    expect(outputs.every((entry) => entry.output.trim().length > 0)).toBe(true);
  });
});
