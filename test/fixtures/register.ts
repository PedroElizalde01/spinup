// Registers the cwd under an alias in its own process, for contention tests.
import { bootstrapProject } from "../../src/commands/run.ts";

try {
  await bootstrapProject(process.argv[2]!, process.cwd(), "keep");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
