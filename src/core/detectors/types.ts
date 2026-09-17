import type { PackageManager } from "../scanner.ts";

/** "launcher" is a command the project defines itself: bin/dev, make dev, a Procfile.dev entry. */
export type RuntimeKind = "node" | "python" | "docker" | "go" | "rust" | "ruby" | "php" | "java" | "deno" | "launcher";

export type DetectedService = {
  name: string;
  path: string;
  command: string;
  runtime: RuntimeKind;
  /** Why this command was chosen, e.g. "apps/api/package.json scripts.dev". */
  origin: string;
  framework?: string;
  dependsOn?: string[];
  delay?: number;
  env?: Record<string, string>;
  /** Compose services behind a single `docker compose up`. */
  containers?: string[];
};

export type ProjectDetection = {
  stack: "node" | "python" | "docker" | "go" | "rust" | "ruby" | "php" | "java" | "deno" | "mixed" | "unknown";
  packageManager?: PackageManager;
  frameworks: string[];
  services: DetectedService[];
  prisma: boolean;
  monorepo: boolean;
  prismaCommands?: {
    generate: string;
    migrate: string;
  };
  /** Things the user should know about the choices made: conflicts, alternatives, guesses not taken. */
  notes: string[];
};
