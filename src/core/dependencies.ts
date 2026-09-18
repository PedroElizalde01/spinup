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
 * A tree: each service hangs under the dependency that gates its start, the one
 * in the latest wave, so any graph draws as a tree with no service repeated.
 * Other dependencies are noted as "also after".
 */
export function visualizeDependencyGraph<T extends Runnable>(items: T[]): string {
  const ordered = buildDependencyGraph(items);
  const waves = startWaves(ordered);
  const gate = (item: T): string | undefined =>
    unique(item.dependsOn ?? []).reduce<string | undefined>((best, name) => (best === undefined || waves.get(name)! > waves.get(best)! ? name : best), undefined);
  const lines: string[] = [];

  const draw = (parent: string | undefined, prefix: string) => {
    const children = ordered.filter((item) => gate(item) === parent);

    children.forEach((item, index) => {
      const last = index === children.length - 1;
      const also = unique(item.dependsOn ?? []).filter((name) => name !== gate(item));
      const notes = [
        item.ready ? `ready when ${describeReady(item.ready)}` : "",
        also.length > 0 ? `also after ${also.join(", ")}` : "",
      ].filter(Boolean);
      const branch = parent === undefined ? "" : last ? "└─ " : "├─ ";
      lines.push(`${prefix}${branch}${item.name}${notes.length > 0 ? `  ${notes.join("  ·  ")}` : ""}`);
      draw(item.name, parent === undefined ? "" : `${prefix}${last ? "   " : "│  "}`);
    });
  };

  draw(undefined, "");
  return lines.join("\n");
}
