import path from "node:path";

import type { DirectoryScan } from "../scanner.ts";
import type { DetectedService } from "./types.ts";

type Found = Omit<DetectedService, "name" | "path"> & { name?: string };

function at(directory: DirectoryScan, file: string): string {
  return directory.path === "." ? file : path.posix.join(directory.path, file);
}

function detectGo(directory: DirectoryScan): Found[] {
  const facts = directory.ecosystem;

  if (facts.goMod === undefined) {
    return [];
  }

  // air is the project's own reload loop; it knows what to build.
  if (facts.airConfig) {
    return [{ command: "air", runtime: "go", origin: `${at(directory, ".air.toml")} exists`, framework: "Go" }];
  }

  if (facts.goMainAtRoot) {
    return [{ command: "go run .", runtime: "go", origin: `package main in ${at(directory, "main.go")}`, framework: "Go" }];
  }

  // A module with only library packages is not something to run.
  return facts.goCommands.map((command) => ({
    name: command,
    command: `go run ./cmd/${command}`,
    runtime: "go" as const,
    origin: `package main in ${at(directory, `cmd/${command}/main.go`)}`,
    framework: "Go",
  }));
}

/** The bodies of each [[bin]] table in a Cargo.toml. */
function binTables(raw: string): string[] {
  return raw.split(/^\[\[bin\]\]\s*$/m).slice(1);
}

function detectRust(directory: DirectoryScan): Found[] {
  const facts = directory.ecosystem;
  const cargo = facts.cargoToml;

  // A workspace root without a package runs nothing itself; its crates are scanned separately.
  if (cargo === undefined || !/^\[package\]/m.test(cargo)) {
    return [];
  }

  const framework = /^(axum|actix-web|rocket|warp|poem)\s*=/m.exec(cargo)?.[1];
  const label = framework ? { axum: "Axum", "actix-web": "Actix Web", rocket: "Rocket", warp: "Warp", poem: "Poem" }[framework] : "Rust";
  const bins = binTables(cargo)
    .map((section) => /^name\s*=\s*"([^"]+)"/m.exec(section)?.[1])
    .filter((name): name is string => Boolean(name));

  if (bins.length > 1) {
    return bins.map((bin) => ({
      name: bin,
      command: `cargo run --bin ${bin}`,
      runtime: "rust" as const,
      origin: `[[bin]] ${bin} in ${at(directory, "Cargo.toml")}`,
      framework: label,
    }));
  }

  // A library crate (src/lib.rs only) has no binary to run.
  if (!facts.rustMain && bins.length === 0) {
    return [];
  }

  return [
    {
      command: "cargo run",
      runtime: "rust",
      origin: facts.rustMain ? `${at(directory, "src/main.rs")} exists` : `[[bin]] in ${at(directory, "Cargo.toml")}`,
      framework: label,
    },
  ];
}

function detectRuby(directory: DirectoryScan): Found[] {
  const facts = directory.ecosystem;

  if (facts.railsBin) {
    return [{ command: "bin/rails server", runtime: "ruby", origin: `${at(directory, "bin/rails")} exists`, framework: "Rails" }];
  }

  if (facts.configRu && facts.gemfile !== undefined) {
    return [{ command: "bundle exec rackup", runtime: "ruby", origin: `${at(directory, "config.ru")} exists`, framework: "Rack" }];
  }

  return [];
}

function detectPhp(directory: DirectoryScan): Found[] {
  const facts = directory.ecosystem;

  if (facts.artisan) {
    return [{ command: "php artisan serve", runtime: "php", origin: `${at(directory, "artisan")} exists`, framework: "Laravel" }];
  }

  if (facts.publicIndexPhp && facts.composerJson !== undefined) {
    const symfony = facts.composerJson.includes('"symfony/framework-bundle"');
    return [
      {
        command: "php -S localhost:8000 -t public",
        runtime: "php",
        origin: `${at(directory, "public/index.php")} exists`,
        framework: symfony ? "Symfony" : "PHP",
      },
    ];
  }

  return [];
}

function detectJvm(directory: DirectoryScan): Found[] {
  const facts = directory.ecosystem;

  if (facts.gradleBuild !== undefined) {
    const runner = facts.gradlew ? "./gradlew" : "gradle";
    const file = at(directory, facts.gradleFile ?? "build.gradle");

    if (facts.gradleBuild.includes("org.springframework.boot")) {
      return [{ command: `${runner} bootRun`, runtime: "java", origin: `Spring Boot plugin in ${file}`, framework: "Spring Boot" }];
    }

    if (facts.gradleBuild.includes("io.quarkus")) {
      return [{ command: `${runner} quarkusDev`, runtime: "java", origin: `Quarkus plugin in ${file}`, framework: "Quarkus" }];
    }
  }

  if (facts.pomXml !== undefined) {
    const runner = facts.mvnw ? "./mvnw" : "mvn";

    if (facts.pomXml.includes("spring-boot-maven-plugin")) {
      return [{ command: `${runner} spring-boot:run`, runtime: "java", origin: `spring-boot-maven-plugin in ${at(directory, "pom.xml")}`, framework: "Spring Boot" }];
    }

    if (facts.pomXml.includes("quarkus-maven-plugin")) {
      return [{ command: `${runner} quarkus:dev`, runtime: "java", origin: `quarkus-maven-plugin in ${at(directory, "pom.xml")}`, framework: "Quarkus" }];
    }
  }

  // A plain Gradle or Maven build has no conventional dev entrypoint to guess.
  return [];
}

function detectDeno(directory: DirectoryScan): Found[] {
  const task = directory.ecosystem.denoTasks?.dev;
  return task ? [{ command: "deno task dev", runtime: "deno", origin: `${at(directory, "deno.json")} tasks.dev`, framework: "Deno" }] : [];
}

/** Services from Go, Rust, Ruby, PHP, JVM and Deno projects in one directory. */
export function detectEcosystemServices(defaultName: string, directory: DirectoryScan): DetectedService[] {
  return [detectGo, detectRust, detectRuby, detectPhp, detectJvm, detectDeno].flatMap((detect) =>
    detect(directory).map(({ name, ...found }) => ({ ...found, name: name ?? defaultName, path: directory.path })),
  );
}
