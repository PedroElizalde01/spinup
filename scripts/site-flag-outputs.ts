// What each inspection flag prints for the website's fixture project, produced by
// the real CLI as if `my-app` were registered from ~/code/my-app. The website reads
// site/flag-outputs.json from this repository's main branch.
// Usage: bun run scripts/site-flag-outputs.ts

import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

/** Flags whose output does not need a running session. Help and the card are included as commands. */
export const FLAG_DEMOS: ReadonlyArray<{ flag: string; command: string[]; description: string }> = [
  { flag: "spinup my-app", command: ["spinup", "my-app"], description: "Register the project: the setup card, .spinup.yml and a my-app command." },
  { flag: "--plan", command: ["my-app", "--plan"], description: "Start order, directories and readiness." },
  { flag: "--graph", command: ["my-app", "--graph"], description: "Which service waits for which." },
  { flag: "--check", command: ["my-app", "--check"], description: "Required tools and busy ports. Exits 2 when the action cannot run." },
  { flag: "--doctor", command: ["my-app", "--doctor"], description: "Config, detection with the origin of each command, tools and notes." },
  { flag: "--env", command: ["my-app", "--env"], description: "Loaded environment files and keys, values masked." },
  { flag: "--dry-run", command: ["my-app", "--dry-run"], description: "Everything a launch resolves, nothing started." },
  { flag: "--list", command: ["spinup", "--list"], description: "Every registered project." },
  { flag: "--help", command: ["spinup", "--help"], description: "Every option." },
];

export type FlagOutput = { flag: string; command: string; description: string; output: string };

export async function renderFlagOutputs(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "spinup-flags-"));
  const project = path.join(home, "code", "my-app");

  try {
    await cp(new URL("../test/fixtures/site-hero", import.meta.url).pathname, project, { recursive: true });
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, NO_COLOR: "1" };
    delete env.SPINUP_SHIM_DIR;
    delete env.RUNIT_SHIM_DIR;

    const run = (args: string[]): string => {
      const child = Bun.spawnSync(["bun", "run", CLI, ...args], { cwd: project, env });
      const text = child.stdout.toString() + child.stderr.toString();
      return text.replaceAll(home, "~").replace(/\n+$/, "");
    };

    // The first demo registers the fixture; the rest inspect it.
    const outputs: FlagOutput[] = FLAG_DEMOS.map(({ flag, command, description }) => {
      // The shim runs `spinup <alias> --start`; a plain `my-app --plan` is `spinup my-app --plan`.
      const args = command[0] === "spinup" ? command.slice(1) : ["my-app", "--start", ...command.slice(1)];
      return { flag, command: command.join(" "), description, output: run(args) };
    });

    return `${JSON.stringify(outputs, null, 2)}\n`;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const target = new URL("../site/flag-outputs.json", import.meta.url).pathname;
  await Bun.write(target, await renderFlagOutputs());
  console.log(`wrote ${target}`);
}
