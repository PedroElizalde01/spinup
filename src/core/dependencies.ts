import { describeReady } from "./readiness.ts";
import type { Pane, Task } from "../types/config.ts";

type Runnable = Task | Pane;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function buildDependencyGraph<T extends Runnable>(items: T[]): T[] {
  const itemMap = new Map(items.map((item) => [item.name, item]));
  const inDegree = new Map<string, number>(items.map((item) => [item.name, 0]));
  const adjacency = new Map<string, string[]>(items.map((item) => [item.name, []]));

  for (const item of items) {
    for (const dependency of item.dependsOn ?? []) {
      if (!itemMap.has(dependency)) {
        continue;
      }

      adjacency.get(dependency)?.push(item.name);
      inDegree.set(item.name, (inDegree.get(item.name) ?? 0) + 1);
    }
  }

  const queue = items
    .filter((item) => (inDegree.get(item.name) ?? 0) === 0)
    .map((item) => item.name);
  const orderedNames: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    orderedNames.push(current);

    for (const next of adjacency.get(current) ?? []) {
      const remaining = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, remaining);

      if (remaining === 0) {
        queue.push(next);
      }
    }
  }

  if (orderedNames.length !== items.length) {
    const cycle = items
      .filter((item) => (inDegree.get(item.name) ?? 0) > 0)
      .map((item) => item.name);

    throw new Error(`circular dependency detected\n${cycle.join(" -> ")}`);
  }

  return orderedNames.map((name) => itemMap.get(name)!);
}

/**
 * One line per service in start order, naming its actual dependencies. The old
 * rendering drew a single chain through the topological order, so two unrelated
 * services appeared to depend on each other.
 */
/** Start wave of each service: 0 for no dependencies, otherwise one past its latest dependency. */
export function startWaves<T extends Runnable>(items: T[]): Map<string, number> {
  const waves = new Map<string, number>();

  for (const item of buildDependencyGraph(items)) {
    waves.set(item.name, 1 + Math.max(-1, ...(item.dependsOn ?? []).map((name) => waves.get(name) ?? 0)));
  }

  return waves;
}

/**
 * A timeline: one row per service, a bar for the wave it starts in, then what it
 * waits for and when it counts as ready. Bars are start positions, not durations.
 */
export function visualizeDependencyGraph<T extends Runnable>(items: T[]): string {
  const ordered = buildDependencyGraph(items);
  const waves = startWaves(ordered);
  const last = Math.max(0, ...waves.values());
  const step = Math.max(3, Math.min(8, Math.floor(40 / (last + 1))));
  const width = Math.max(...ordered.map((item) => item.name.length));

  return ordered
    .slice()
    .sort((left, right) => waves.get(left.name)! - waves.get(right.name)!)
    .map((item) => {
      const wave = waves.get(item.name)!;
      const bar = " ".repeat(wave * step) + "▮".repeat(step) + "─".repeat((last - wave) * step);
      const dependencies = unique(item.dependsOn ?? []);
      const notes = [
        dependencies.length > 0 ? `after ${dependencies.join(", ")}` : "",
        item.ready ? `ready when ${describeReady(item.ready)}` : "",
      ].filter(Boolean);
      return `${item.name.padEnd(width)}  ${bar}${notes.length > 0 ? `  ${notes.join("  ·  ")}` : ""}`;
    })
    .join("\n");
}
