import { detectProject } from "../core/detector.ts";
import { checkDocker, checkTools, collectToolWarnings, inferRequiredTools, validateConfigPaths } from "../core/health.ts";
import { scanProject } from "../core/scanner.ts";
import { emit, EXIT } from "../ui/output.ts";
import { loadRegisteredProject, selectAction } from "./shared.ts";

type CheckOptions = {
  action?: string;
};

export async function checkProject(alias: string, options: CheckOptions = {}): Promise<void> {
  const { projectRoot, config } = await loadRegisteredProject(alias);
  const { actionName } = selectAction(config, options.action);
  const scanResult = await scanProject(projectRoot);
  const detection = detectProject(scanResult);
  const tools = await checkTools(inferRequiredTools(config, detection, actionName));
  const pathProblems = await validateConfigPaths(projectRoot, config, actionName);
  const toolProblems = collectToolWarnings(detection, tools);
  const docker = tools.some((tool) => tool.name === "docker") ? await checkDocker() : undefined;

  if (docker?.cli && !docker.compose) {
    toolProblems.push("The Docker CLI is installed but the Compose plugin is not.");
  }

  if (docker?.cli && !docker.daemon) {
    toolProblems.push("The Docker daemon is not reachable.");
  }

  const problems = [...toolProblems, ...pathProblems];
  const report = {
    action: actionName,
    tools: tools.map((tool) => ({ name: tool.name, installed: tool.installed, resolvedCommand: tool.resolvedCommand ?? null })),
    docker: docker ?? null,
    problems,
    ready: problems.length === 0,
  };

  // A diagnostic that reports a broken environment must not exit 0; scripts and
  // CI rely on the status, not the text.
  if (!report.ready) {
    process.exitCode = EXIT.notReady;
  }

  emit(report, () => {
    console.log("+--------------------+");
    console.log("| Environment Check  |");
    console.log("+--------------------+\n");
    console.log(`Action: ${actionName}\n`);

    for (const tool of tools) {
      const resolved = tool.resolvedCommand && tool.resolvedCommand !== tool.name ? ` (${tool.resolvedCommand})` : "";
      console.log(`${tool.name}${resolved} ${tool.installed ? "✓" : "✗"}`);
    }

    if (docker?.cli) {
      console.log(`docker compose ${docker.compose ? "✓" : "✗"}`);
      console.log(`docker daemon ${docker.daemon ? "✓" : "✗"}`);
    }

    if (problems.length > 0) {
      console.log("\nProblems:");

      for (const problem of problems) {
        console.log(`  ${problem}`);
      }

      console.log(`\n${problems.length} problem(s) found.`);
      return;
    }

    console.log("\nReady.");
  });
}
