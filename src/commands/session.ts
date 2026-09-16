import { waitUntilReady } from "../core/readiness.ts";
import { keepPaneOnExit, paneView, respawnPane } from "../tmux/layout.ts";
import { resolvePaneCwd } from "../tmux/runner.ts";
import {
  attachSession,
  canonicalProject,
  ensureTmuxInstalled,
  findSessionId,
  killSessionQuietly,
  listServicePanes,
  readSessionOwner,
  TMUX_OWNED_KEYS,
} from "../tmux/session.ts";
import { emit, EXIT } from "../ui/output.ts";
import { launchProject } from "./run.ts";
import {
  actionEntries,
  loadProject,
  resolveLaunchEnvironment,
  selectAction,
  sessionNameFor,
  type LoadedProject,
  type SelectedAction,
} from "./shared.ts";

type SessionOptions = {
  action?: string;
};

type OwnedSession = LoadedProject &
  SelectedAction & {
    sessionName: string;
    /** Null when no session with that name is running. */
    sessionId: string | null;
  };

/**
 * The tmux session this project's action owns, if it is running. A session with
 * that name owned by anything else is refused: these commands only ever act on
 * sessions spinup created for this project and action.
 */
async function findOwnedSession(alias: string | undefined, options: SessionOptions, verb: string): Promise<OwnedSession> {
  const project = await loadProject(alias);
  const selected = selectAction(project.config, options.action);

  if (selected.action.mode !== "tmux") {
    throw new Error(
      `Action "${selected.actionName}" runs in the foreground (mode: simple), so there is no session to ${verb}. ` +
        "Stop it with Ctrl+C in its terminal.",
    );
  }

  await ensureTmuxInstalled();
  const sessionName = sessionNameFor(project.alias, project.config, selected.actionName);
  const sessionId = await findSessionId(sessionName);

  if (sessionId) {
    const owner = await readSessionOwner(sessionId);
    const here = await canonicalProject(project.projectRoot);

    if (!owner || owner.project !== here || owner.action !== selected.actionName) {
      throw new Error(
        `tmux session "${sessionName}" exists but is not the "${selected.actionName}" session of ${project.projectRoot}; spinup will not ${verb} it.`,
      );
    }
  }

  return { ...project, ...selected, sessionName, sessionId };
}

export async function statusProject(alias: string | undefined, options: SessionOptions = {}): Promise<void> {
  const session = await findOwnedSession(alias, options, "inspect");
  const panes = session.sessionId ? await listServicePanes(session.sessionId) : [];
  const configured = actionEntries(session.action).map((entry) => entry.name);

  const services = configured.map((name) => {
    const pane = panes.find((candidate) => candidate.service === name);
    return {
      name,
      state: !pane ? "missing" : pane.exitStatus === undefined ? "running" : "exited",
      exitStatus: pane?.exitStatus ?? null,
      pid: pane && pane.exitStatus === undefined ? pane.pid : null,
      window: pane?.window ?? null,
    };
  });

  const report = {
    alias: session.alias,
    action: session.actionName,
    session: session.sessionName,
    running: Boolean(session.sessionId),
    services: session.sessionId ? services : [],
  };

  // Scripts can branch on it: 0 running, 3 not running, like service managers.
  if (!report.running) {
    process.exitCode = EXIT.notRunning;
  }

  emit(report, () => {
    if (!report.running) {
      console.log(`${session.alias} (${session.actionName}) is not running.`);
      return;
    }

    console.log(`${session.alias} (${session.actionName}) is running in tmux session "${session.sessionName}".\n`);
    const width = Math.max(...services.map((service) => service.name.length));

    for (const service of services) {
      const detail =
        service.state === "running"
          ? `running  pid ${service.pid}`
          : service.state === "exited"
            ? `exited   status ${service.exitStatus}`
            : "missing  (its pane was closed)";
      console.log(`  ${service.name.padEnd(width)}  ${detail}`);
    }
  });
}

export async function attachProject(alias: string | undefined, options: SessionOptions = {}): Promise<void> {
  const session = await findOwnedSession(alias, options, "attach to");

  if (!session.sessionId) {
    throw new Error(`${session.alias} (${session.actionName}) is not running. Start it with: ${session.registered ? session.alias : "spinup --start"}`);
  }

  await attachSession(session.sessionName, session.sessionId);
}

export async function stopProject(alias: string | undefined, options: SessionOptions = {}): Promise<void> {
  const session = await findOwnedSession(alias, options, "stop");

  if (!session.sessionId) {
    // Already in the requested state; stopping twice is not an error.
    console.log(`${session.alias} (${session.actionName}) was not running.`);
    return;
  }

  await killSessionQuietly(session.sessionId);
  console.log(`Stopped ${session.alias} (${session.actionName}).`);
}

/**
 * With a service, respawns just that pane from the current config and environment
 * and waits for its readiness condition. Without one, stops and relaunches the
 * whole session. Services that depend on a restarted one are named, not restarted:
 * whether they need it depends on the application.
 */
export async function restartProject(alias: string | undefined, service: string | undefined, options: SessionOptions = {}): Promise<void> {
  const session = await findOwnedSession(alias, options, "restart");

  if (!service) {
    if (session.sessionId) {
      await killSessionQuietly(session.sessionId);
      console.log(`Stopped ${session.alias} (${session.actionName}).`);
    }

    await launchProject(session.alias, session.projectRoot, { start: true, action: session.actionName });
    return;
  }

  if (!session.sessionId) {
    throw new Error(`${session.alias} (${session.actionName}) is not running, so "${service}" cannot be restarted on its own.`);
  }

  const entry = actionEntries(session.action).find((candidate) => candidate.name === service);

  if (!entry) {
    const known = actionEntries(session.action).map((candidate) => candidate.name).join(", ");
    throw new Error(`Action "${session.actionName}" has no service "${service}". Services: ${known}`);
  }

  const pane = (await listServicePanes(session.sessionId)).find((candidate) => candidate.service === service);

  if (!pane) {
    throw new Error(`The pane for "${service}" is gone. Restart the whole session with: spinup ${session.alias} --restart`);
  }

  const { environment } = await resolveLaunchEnvironment(session.projectRoot, session.config, session.actionName);
  const env: NodeJS.ProcessEnv = { ...environment, ...entry.env };

  for (const key of TMUX_OWNED_KEYS) {
    delete env[key];
  }

  if (entry.ready && "exit" in entry.ready) {
    await keepPaneOnExit(pane.paneId);
  }

  await respawnPane(pane.paneId, { cwd: resolvePaneCwd(session.projectRoot, session.config, entry.cwd), env, cmd: entry.cmd });
  console.log(`Restarted ${service}.`);

  if (entry.ready) {
    await waitUntilReady(service, entry.ready, paneView(pane.paneId), new AbortController().signal);
    console.log(`${service} is ready.`);
  }

  const dependents = actionEntries(session.action)
    .filter((candidate) => candidate.dependsOn?.includes(service))
    .map((candidate) => candidate.name);

  if (dependents.length > 0) {
    console.log(`These depend on ${service} and may need a restart too: ${dependents.join(", ")}`);
  }
}
