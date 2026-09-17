// The setup card the website's hero shows, produced by the real CLI code from a
// fixture project, as if registered from ~/code/my-app. A test fails when this
// output and the committed site/hero-card.json disagree; the website reads that file.
// Usage: bun run scripts/site-hero-card.ts [--check]

import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = new URL(import.meta.url).pathname;

/** Runs in a child whose HOME is the fixture home: the home directory is read once per process. */
async function emit(): Promise<void> {
  const project = path.join(process.env.HOME!, "code", "my-app");
  const { scanProject } = await import("../src/core/scanner.ts");
  const { detectProject } = await import("../src/core/detector.ts");
  const { generateConfig } = await import("../src/core/generator.ts");
  const { buildSetupCard } = await import("../src/commands/run.ts");

  const scan = await scanProject(project);
  const detection = detectProject(scan);
  const card = buildSetupCard("my-app", project, generateConfig(scan, "my-app", detection), detection, "registered");
  const services = detection.services.map((service) => ({ name: service.name, command: service.command }));

  process.stdout.write(`${JSON.stringify({ command: "spinup my-app", card, services }, null, 2)}\n`);
}

export async function renderHeroCard(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "spinup-hero-"));

  try {
    await cp(new URL("../test/fixtures/site-hero", import.meta.url).pathname, path.join(home, "code", "my-app"), { recursive: true });
    const env: Record<string, string | undefined> = { ...process.env, HOME: home };
    delete env.SPINUP_SHIM_DIR;
    delete env.RUNIT_SHIM_DIR;

    const child = Bun.spawnSync(["bun", "run", SCRIPT, "--emit"], { env });

    if (!child.success) {
      throw new Error(`rendering the hero card failed: ${child.stderr.toString()}`);
    }

    return child.stdout.toString();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (process.argv.includes("--emit")) {
    await emit();
  } else {
    const target = new URL("../site/hero-card.json", import.meta.url).pathname;
    const rendered = await renderHeroCard();

    if (process.argv.includes("--check")) {
      if ((await Bun.file(target).text()) !== rendered) {
        console.error("site/hero-card.json is out of date; run: bun run scripts/site-hero-card.ts");
        process.exit(1);
      }
    } else {
      await Bun.write(target, rendered);
      console.log(`wrote ${target}`);
    }
  }
}
