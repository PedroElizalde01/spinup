// What each inspection flag prints for the website's fixture project, produced by
// the real CLI as if `my-app` were registered from ~/code/my-app. The website reads
// site/flag-outputs.json from this repository's main branch.
// Usage: bun run scripts/site-flag-outputs.ts

import { chmod, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

/** Flags whose output does not need a running session. Help and the card are included as commands. */
export const FLAG_DEMOS: ReadonlyArray<{ flag: string; command: string[]; description: string }> = [
  { flag: "spinup my-app", command: ["spinup", "my-app"], description: "Register the project: the setup card, .spinup.yml and a my-app command." },
  { flag: "--plan", command: ["my-app", "--plan"], description: "Start order, what each service waits for, and when it counts as ready." },
  { flag: "--graph", command: ["my-app", "--graph"], description: "The dependency graph with every readiness condition." },
  { flag: "--check", command: ["my-app", "--check"], description: "Required tools, the Docker daemon and busy ports. Exits 2 when the action cannot run." },
  { flag: "--doctor", command: ["my-app", "--doctor"], description: "Config, detection with the origin of each command, tools and notes." },
  { flag: "--env", command: ["my-app", "--env"], description: "Every environment file and key, values masked, later files winning." },
  { flag: "--dry-run", command: ["my-app", "--dry-run"], description: "Everything a launch resolves, including ports, with nothing started." },
  { flag: "--action migrate", command: ["my-app", "--action", "migrate", "--plan"], description: "Any other action in the config, such as migrations, with the same tooling." },
  { flag: "--list", command: ["spinup", "--list"], description: "Every registered project and where it lives." },
  { flag: "--help", command: ["spinup", "--help"], description: "Every option." },
];

const FIXTURES = new URL("../test/fixtures/", import.meta.url).pathname;

/** Stands in for Docker so --check and --doctor show a machine where Compose works. */
const FAKE_DOCKER = `#!/bin/sh
case "$1 $2" in
  "compose config") echo '{"services":{"postgres":{"image":"postgres:16","ports":["5432:5432"]},"redis":{"image":"redis:7","ports":["6379:6379"]}}}' ;;
  "compose version") echo "Docker Compose version v2.29.0" ;;
  "info --format") echo "27.1.0" ;;
  *) echo "Docker version 27.1.0" ;;
esac
`;

export type FlagOutput = { flag: string; command: string; description: string; output: string };

export async function renderFlagOutputs(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "spinup-flags-"));
  const project = path.join(home, "code", "my-app");

  try {
    await cp(path.join(FIXTURES, "site-demo"), project, { recursive: true });
    await cp(path.join(FIXTURES, "site-hero"), path.join(home, "code", "blog"), { recursive: true });
    await Bun.write(path.join(home, "code", "docs", "package.json"), JSON.stringify({ name: "docs", scripts: { dev: "astro dev" } }));
    await Bun.write(path.join(home, "bin", "docker"), FAKE_DOCKER);
    await chmod(path.join(home, "bin", "docker"), 0o755);

    const env: Record<string, string | undefined> = { ...process.env, HOME: home, NO_COLOR: "1", PATH: `${path.join(home, "bin")}:${process.env.PATH}` };
    delete env.SPINUP_SHIM_DIR;
    delete env.RUNIT_SHIM_DIR;

    // An empty network namespace, where no port is busy, when the kernel allows one.
    const isolate = Bun.spawnSync(["unshare", "-rn", "true"]).success ? ["unshare", "-rn"] : [];

    const run = (args: string[], cwd = project): string => {
      const child = Bun.spawnSync([...isolate, "bun", "run", CLI, ...args], { cwd, env });
      const text = child.stdout.toString() + child.stderr.toString();
      return text.replaceAll(home, "~").replace(/\n+$/, "");
    };

    run(["blog"], path.join(home, "code", "blog"));
    run(["docs"], path.join(home, "code", "docs"));

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
