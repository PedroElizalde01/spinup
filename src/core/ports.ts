import path from "node:path";

import { execa } from "execa";

import { inspectCompose } from "../docker/compose.ts";
import type { Action, Pane, Task } from "../types/config.ts";
import { portOpen } from "./readiness.ts";

export type PortClaim = {
  port: number;
  host?: string;
  /** Why the action needs it, e.g. "db ready condition" or "compose service postgres". */
  source: string;
};

export type BusyPort = PortClaim & {
  /** "pid 4312 (postgres)" when the owner could be read. */
  owner?: string;
};

function entries(action: Action): Array<Task | Pane> {
  return action.mode === "tmux" ? action.windows.flatMap((window) => window.panes) : action.tasks ?? [];
}

/**
 * Ports the action will try to bind: declared readiness ports, and the host ports
 * of any Compose application it starts. Anything else a command binds is unknowable
 * without running it.
 */
export async function claimedPorts(projectRoot: string, actionRoot: string, action: Action): Promise<PortClaim[]> {
  const claims: PortClaim[] = [];

  for (const entry of entries(action)) {
    if (entry.ready && "port" in entry.ready) {
      claims.push({ port: entry.ready.port, host: entry.ready.host, source: `${entry.name} ready condition` });
    }

    if (/^docker\s+compose\s/.test(entry.cmd.trim())) {
      const compose = await inspectCompose(path.resolve(actionRoot, entry.cwd)).catch(() => undefined);

      for (const service of compose?.services ?? []) {
        for (const port of service.ports) {
          claims.push({ port, source: `compose service ${service.name}` });
        }
      }
    }
  }

  // One report per port, keeping the first reason.
  return claims.filter((claim, index) => claims.findIndex((other) => other.port === claim.port) === index);
}

/** Best effort: lsof names the listener on macOS and most Linux systems. */
async function portOwner(port: number): Promise<string | undefined> {
  try {
    const { stdout } = await execa("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], { timeout: 3000, reject: false });
    const pid = /^p(\d+)$/m.exec(stdout)?.[1];
    const command = /^c(.+)$/m.exec(stdout)?.[1];
    return pid ? `pid ${pid}${command ? ` (${command})` : ""}` : undefined;
  } catch {
    return undefined;
  }
}

/** Reports claims something is already listening on. Never touches the listener. */
export async function findBusyPorts(claims: PortClaim[]): Promise<BusyPort[]> {
  const busy: BusyPort[] = [];

  for (const claim of claims) {
    if (await portOpen(claim.port, claim.host)) {
      busy.push({ ...claim, owner: await portOwner(claim.port) });
    }
  }

  return busy;
}

export function describeBusyPort(busy: BusyPort): string {
  return `Port ${busy.port} (${busy.source}) is already in use${busy.owner ? ` by ${busy.owner}` : ""}.`;
}
