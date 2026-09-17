import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import type { ReadyCondition } from "../types/config.ts";

export const DEFAULT_READY_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 250;
const PROBE_TIMEOUT_MS = 1000;

/** What a readiness check can observe about a running service, in either backend. */
export type ServiceView = {
  /** Undefined while running; the exit status once it has exited (-1 when unknown). */
  exitStatus(): Promise<number | undefined>;
  /** True once any output so far has matched the pattern. */
  outputMatches(pattern: RegExp): Promise<boolean>;
};

export class ReadinessFailure extends Error {
  readonly service: string;

  constructor(service: string, condition: ReadyCondition, reason: string) {
    super(`[${service}] ${describeReady(condition)} ${reason}`);
    this.name = "ReadinessFailure";
    this.service = service;
  }
}

export function describeReady(condition: ReadyCondition): string {
  if ("port" in condition) return `port ${condition.host ?? "localhost"}:${condition.port}`;
  if ("http" in condition) return `http ${condition.http}`;
  if ("log" in condition) return `log /${condition.log}/`;
  return "exit 0";
}

/** localhost may be IPv4 or IPv6 depending on how the server bound; try both. */
export async function portOpen(port: number, host?: string): Promise<boolean> {
  const hosts = host ? [host] : ["127.0.0.1", "::1"];

  for (const candidate of hosts) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect({ port, host: candidate });
      const finish = (result: boolean) => {
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(false));
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });

    if (open) {
      return true;
    }
  }

  return false;
}

/** Any HTTP answer below 500 means the server is up; a 404 at the probed path still is. */
async function httpAnswers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 2) });
    await response.body?.cancel();
    return response.status < 500;
  } catch {
    return false;
  }
}

async function conditionHolds(condition: ReadyCondition, view: ServiceView): Promise<boolean> {
  if ("port" in condition) return portOpen(condition.port, condition.host);
  if ("http" in condition) return httpAnswers(condition.http);
  if ("log" in condition) return view.outputMatches(new RegExp(condition.log));
  return false;
}

/**
 * Waits until the condition holds, the service exits, the timeout passes, or the
 * run is aborted. One polling loop for every condition and both backends.
 */
export async function waitUntilReady(
  service: string,
  condition: ReadyCondition,
  view: ServiceView,
  signal: AbortSignal,
): Promise<void> {
  const timeout = condition.timeout ?? DEFAULT_READY_TIMEOUT_MS;
  const deadline = Date.now() + timeout;

  for (;;) {
    signal.throwIfAborted();
    const status = await view.exitStatus();

    if ("exit" in condition) {
      if (status === 0) return;
      if (status !== undefined) {
        throw new ReadinessFailure(service, condition, status === -1 ? "failed: the process is gone" : `failed: exited with status ${status}`);
      }
    } else {
      if (await conditionHolds(condition, view)) return;
      if (status !== undefined) {
        throw new ReadinessFailure(
          service,
          condition,
          status === -1 ? "never held: the process is gone" : `never held: exited with status ${status} first`,
        );
      }
    }

    if (Date.now() >= deadline) {
      throw new ReadinessFailure(service, condition, `did not hold within ${timeout}ms`);
    }

    await delay(POLL_INTERVAL_MS, undefined, { signal });
  }
}

type Schedulable = { name: string; dependsOn?: string[]; delay?: number; ready?: ReadyCondition };

/**
 * Starts every service as soon as its own dependencies are ready. Ordering used to
 * be one sequential loop: a delay or a slow service held up everything after it,
 * dependent or not, and a dependency counted as ready the moment it was spawned.
 *
 * `start` launches a service and returns how to observe it. Resolves when all have
 * started and become ready; rejects with the first failure, after aborting.
 */
export async function scheduleServices<T extends Schedulable>(
  items: T[],
  start: (item: T) => Promise<ServiceView | undefined>,
  controller: AbortController,
): Promise<void> {
  const { signal } = controller;
  let firstFailure: unknown;
  const readiness = new Map<string, Promise<void>>();
  const settle = new Map<string, { resolve: () => void; reject: (error: unknown) => void }>();

  for (const item of items) {
    readiness.set(
      item.name,
      new Promise<void>((resolve, reject) => {
        settle.set(item.name, { resolve, reject });
      }),
    );
    // Observed through the launch promises below; never an unhandled rejection.
    readiness.get(item.name)!.catch(() => undefined);
  }

  const launches = items.map(async (item) => {
    const own = settle.get(item.name)!;

    try {
      await Promise.all((item.dependsOn ?? []).map((dependency) => readiness.get(dependency)));
      signal.throwIfAborted();

      const view = await start(item);

      if (item.ready && view) {
        await waitUntilReady(item.name, item.ready, view, signal);
      }

      if (item.delay) {
        await delay(item.delay, undefined, { signal });
      }

      own.resolve();
    } catch (error) {
      // Once anything has failed or the run was aborted, every other wait reports
      // that cause, not its own AbortError.
      const cause = signal.aborted ? signal.reason : error;

      if (!signal.aborted) {
        firstFailure = error;
        controller.abort(error);
      }

      own.reject(cause);
      throw cause;
    }
  });

  const results = await Promise.allSettled(launches);

  if (results.some((result) => result.status === "rejected")) {
    throw firstFailure ?? signal.reason;
  }
}
