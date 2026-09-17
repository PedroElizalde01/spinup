import { checkDocker, checkTools, collectToolWarnings, inferRequiredTools, validateConfigPaths } from "../core/health.ts";
import { claimedPorts, describeBusyPort, findBusyPorts } from "../core/ports.ts";
import { canonicalProject, findSessionId, readSessionOwner } from "../tmux/session.ts";
import { emit, EXIT } from "../ui/output.ts";
import { loadProject, resolveActionRoot, selectAction, sessionNameFor } from "./shared.ts";

type CheckOptions = {
  action?: string;
};

export async function checkProject(alias: string | undefined, options: CheckOptions = {}): Promise<void> {
  const project = await loadProject(alias);
  const { projectRoot, config } = project;
  const { actionName, action } = selectAction(config, options.action);
  // Requirements come from the selected commands alone; no scan is needed.
  const tools = await checkTools(inferRequiredTools(config, actionName));
  const pathProblems = await validateConfigPaths(projectRoot, config, actionName);
  const toolProblems = collectToolWarnings(tools);
  const docker = tools.some((tool) => tool.name === "docker") ? await checkDocker() : undefined;

  if (docker?.cli && !docker.compose) {
    toolProblems.push("The Docker CLI is installed but the Compose plugin is not.");
  }

  if (docker?.cli && !docker.daemon) {
    toolProblems.push("The Docker daemon is not reachable.");
  }

  // A port the action's own running session holds is expected, not a conflict.
  let ownSessionRunning = false;

  if (action.mode === "tmux") {
    try {
      const sessionId = await findSessionId(sessionNameFor(project.alias, config, actionName));
      const owner = sessionId ? await readSessionOwner(sessionId) : null;
      ownSessionRunning = Boolean(owner && owner.action === actionName && owner.project === (await canonicalProject(projectRoot)));
    } catch {
      // No tmux: nothing of ours can be running.
    }
  }

  const busyPorts = ownSessionRunning
    ? []
    : await findBusyPorts(await claimedPorts(projectRoot, resolveActionRoot(projectRoot, config), action));
  const problems = [...toolProblems, ...pathProblems, ...busyPorts.map(describeBusyPort)];
  const report = {
    action: actionName,
    busyPorts,
    portsChecked: !ownSessionRunning,
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

    if (ownSessionRunning) {
      console.log("ports: not checked, the action's session is running");
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
