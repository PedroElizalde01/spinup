// Runs a simple action in its own process so signal tests cannot take down the
// test runner. Usage: bun run run-tasks.ts '<json tasks>'; cwd is the project root.
import { executeAction, exitCodeFor } from "../../src/core/executor.ts";
import type { SpinupConfig, Task } from "../../src/types/config.ts";

const tasks = JSON.parse(process.argv[2] ?? "[]") as Task[];
const config: SpinupConfig = {
  name: "fixture",
  root: ".",
  default: "dev",
  actions: { dev: { mode: "simple", tasks } },
};

try {
  await executeAction(process.cwd(), config, "dev", { environment: process.env });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = exitCodeFor(error);
}
