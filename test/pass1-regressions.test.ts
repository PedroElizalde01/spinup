import { describe, expect, test } from "bun:test";

import { parseComposeServices } from "../src/docker/compose.ts";
import { exactTarget } from "../src/tmux/session.ts";

describe("compose parsing after the js-yaml -> yaml migration", () => {
  // The `yaml` package defaults to YAML 1.2, where "<<" is an ordinary key. Without
  // merge: true the anchored fields are silently dropped instead of merged.
  test("resolves merge keys from anchors", () => {
    const raw = [
      "x-base: &base",
      "  restart: always",
      "services:",
      "  cache:",
      "    <<: *base",
      "    image: redis",
      "  db:",
      "    <<: *base",
      "    image: postgres",
      "    depends_on: [cache]",
    ].join("\n");

    const services = parseComposeServices(raw);

    expect(services.map((service) => service.name)).toEqual(["cache", "db"]);
    expect(services.find((service) => service.name === "db")?.image).toBe("postgres");
    expect(services.find((service) => service.name === "db")?.dependsOn).toEqual(["cache"]);
  });

  test("normalizes both depends_on forms", () => {
    const raw = [
      "services:",
      "  a:",
      "    image: a",
      "  b:",
      "    image: b",
      "    depends_on:",
      "      a:",
      "        condition: service_healthy",
    ].join("\n");

    expect(parseComposeServices(raw).find((service) => service.name === "b")?.dependsOn).toEqual(["a"]);
  });

  test("tolerates a compose file with no services", () => {
    expect(parseComposeServices("version: '3'\n")).toEqual([]);
  });
});

describe("build and CLI safety flags", () => {
  // F04: Bun autoloads .env from the invocation directory into compiled executables,
  // which leaked an unrelated project's environment into the launched one.
  test("release build disables Bun autoload of caller dotenv and bunfig", async () => {
    const script = await Bun.file(new URL("../scripts/build-release.sh", import.meta.url)).text();

    expect(script).toContain("--no-compile-autoload-dotenv");
    expect(script).toContain("--no-compile-autoload-bunfig");
  });

  // F02: tmux -t matches by name prefix, so alias "api" resolved a user's unrelated
  // "api-staging" session. The behavioral counterpart lives in tmux-workspace.test.ts.
  test("tmux session targets use the exact-match prefix", () => {
    expect(exactTarget("api")).toBe("=api");
  });
});
