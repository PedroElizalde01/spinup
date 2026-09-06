import YAML from "yaml";

import type { DockerComposeService } from "./service.ts";

type ComposeDocument = {
  services?: Record<
    string,
    {
      image?: string;
      depends_on?: string[] | Record<string, unknown>;
    }
  >;
};

type ComposeDependsOn = string[] | Record<string, unknown> | undefined;

function normalizeDependsOn(value: ComposeDependsOn): string[] {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  return Object.keys(value);
}

export function parseComposeServices(raw: string): DockerComposeService[] {
  // merge: true keeps YAML 1.1 "<<" merge-key behavior, which Compose files rely on for
  // anchors. Without it the key is parsed literally and anchored fields are lost.
  const parsed = (YAML.parse(raw, { merge: true }) as ComposeDocument | undefined) ?? {};
  const services = parsed.services ?? {};

  return Object.entries(services)
    .map(([name, definition]) => ({
      name,
      dependsOn: normalizeDependsOn(definition.depends_on),
      image: definition.image,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
