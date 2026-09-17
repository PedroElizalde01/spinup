import { readFile } from "node:fs/promises";
import path from "node:path";

import { execa } from "execa";
import YAML from "yaml";

export type DockerComposeService = {
  name: string;
  dependsOn: string[];
  image?: string;
  profiles: string[];
  /** Host ports the service publishes. Container-only and ranged ports are left out. */
  ports: number[];
};

export type ComposeProject = {
  /** The files Compose itself reads, main file first. */
  files: string[];
  /** "docker" when Compose resolved it; "static" when parsed here, which misses include/extends/interpolation. */
  resolution: "docker" | "static";
  /** Services that start without selecting a profile. Profiled services stay optional. */
  services: DockerComposeService[];
};

// Compose's own precedence. With both compose.yaml and docker-compose.yml present it
// uses compose.yaml; checking docker-compose.yml first described a different app.
const MAIN_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
const OVERRIDE_FILES = ["compose.override.yaml", "compose.override.yml", "docker-compose.override.yaml", "docker-compose.override.yml"];

// Resolution is a local file operation; it must never hold up a scan.
const COMPOSE_CONFIG_TIMEOUT_MS = 5000;

type ComposePort = string | number | { published?: string | number };

type ComposeServiceDefinition = {
  image?: string;
  depends_on?: string[] | Record<string, unknown>;
  profiles?: string[];
  ports?: ComposePort[];
};

/**
 * "5432:5432", "127.0.0.1:8080:80/tcp" and { published: 5432 } publish a host port.
 * "3000" alone publishes a random one, and a range cannot be checked meaningfully.
 */
function hostPorts(ports: ComposePort[] | undefined): number[] {
  const found: number[] = [];

  for (const entry of ports ?? []) {
    let published: string | undefined;

    if (typeof entry === "object") {
      published = entry.published === undefined ? undefined : String(entry.published);
    } else {
      const parts = String(entry).split("/")[0]!.split(":");
      published = parts.length >= 2 ? parts[parts.length - 2] : undefined;
    }

    if (published && /^\d+$/.test(published)) {
      found.push(Number(published));
    }
  }

  return found;
}

type ComposeDocument = {
  services?: Record<string, ComposeServiceDefinition | null>;
};

function normalizeDependsOn(value: ComposeServiceDefinition["depends_on"]): string[] {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : Object.keys(value);
}

function toServices(document: ComposeDocument | undefined): DockerComposeService[] {
  return Object.entries(document?.services ?? {})
    .map(([name, definition]) => ({
      name,
      dependsOn: normalizeDependsOn(definition?.depends_on),
      image: definition?.image,
      profiles: definition?.profiles ?? [],
      ports: hostPorts(definition?.ports),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function parseComposeServices(raw: string): DockerComposeService[] {
  // merge: true keeps YAML 1.1 "<<" merge-key behavior, which Compose files rely on for
  // anchors. Without it the key is parsed literally and anchored fields are lost.
  return toServices(YAML.parse(raw, { merge: true }) as ComposeDocument | undefined);
}

async function firstExisting(root: string, names: string[]): Promise<string | undefined> {
  for (const name of names) {
    try {
      await readFile(path.join(root, name));
      return name;
    } catch {
      // Try the next name.
    }
  }

  return undefined;
}

async function resolveWithDocker(root: string): Promise<DockerComposeService[] | undefined> {
  try {
    // The resolved document can contain interpolated secrets; it is parsed, never logged.
    const { stdout } = await execa("docker", ["compose", "config", "--format", "json"], {
      cwd: root,
      timeout: COMPOSE_CONFIG_TIMEOUT_MS,
    });
    return toServices(JSON.parse(stdout) as ComposeDocument);
  } catch {
    return undefined;
  }
}

async function resolveStatically(root: string, files: string[]): Promise<DockerComposeService[]> {
  const merged: Record<string, ComposeServiceDefinition> = {};

  for (const file of files) {
    const document = YAML.parse(await readFile(path.join(root, file), "utf8"), { merge: true }) as ComposeDocument | undefined;

    for (const [name, definition] of Object.entries(document?.services ?? {})) {
      // An override replaces the keys it sets, like Compose does for these fields.
      merged[name] = { ...merged[name], ...(definition ?? {}) };
    }
  }

  return toServices({ services: merged });
}

/**
 * The container application Compose would start from this directory. Compose is
 * the authority when it is installed; the static reading is a labelled fallback.
 */
export async function inspectCompose(root: string): Promise<ComposeProject | undefined> {
  const main = await firstExisting(root, MAIN_FILES);

  if (!main) {
    return undefined;
  }

  const override = await firstExisting(root, OVERRIDE_FILES);
  const files = override ? [main, override] : [main];
  const resolved = await resolveWithDocker(root);
  const services = resolved ?? (await resolveStatically(root, files));

  return {
    files,
    resolution: resolved ? "docker" : "static",
    services: services.filter((service) => service.profiles.length === 0),
  };
}
