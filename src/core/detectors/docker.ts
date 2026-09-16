import type { ScanResult } from "../scanner.ts";
import type { DetectedService } from "./types.ts";

/**
 * One `docker compose up` for the whole container application. A process per
 * container started overlapping dependency sets and could enable services that
 * are behind a profile; Compose already owns ordering and lifecycle.
 */
export function detectComposeService(scan: ScanResult, notes: string[]): DetectedService | undefined {
  const compose = scan.compose;

  if (!compose || compose.services.length === 0) {
    return undefined;
  }

  if (compose.resolution === "static") {
    notes.push(
      `Compose was read without the docker CLI; include, extends and variable interpolation in ${compose.files.join(", ")} were not resolved.`,
    );
  }

  return {
    name: "compose",
    path: ".",
    command: "docker compose up",
    runtime: "docker",
    origin: compose.files.join(" + "),
    framework: "Docker Compose",
    containers: compose.services.map((service) => service.name),
    // Attached `up` has no readiness signal of its own; add `ready:` in the config for one.
    delay: 3000,
  };
}
