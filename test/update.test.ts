import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { assetName, compareVersions, updateBinary } from "../src/core/update.ts";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const script = (version: string) => `#!/bin/sh\necho ${version}\n`;

let root: string;
let executable: string;
let server: ReturnType<typeof Bun.serve>;
let binaries: Record<string, string>;
let tamper: boolean;
const saved = { api: process.env.SPINUP_INSTALL_API_URL, download: process.env.SPINUP_INSTALL_DOWNLOAD_URL };

beforeEach(async () => {
  root = await makeTempDir("spinup-update-");
  executable = path.join(root, "spinup");
  await writeFile(executable, script("0.5.0"));
  await chmod(executable, 0o755);
  binaries = { "v0.6.0": script("0.6.0"), "v0.4.0": script("0.4.0") };
  tamper = false;

  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/api/releases/latest") return Response.json({ tag_name: "v0.6.0", body: "- faster\n- safer" });
      if (url.pathname.startsWith("/api/releases/tags/")) return Response.json({ body: "notes" });

      const match = /^\/download\/(v[^/]+)\/(.+)$/.exec(url.pathname);
      const binary = match ? binaries[match[1]!] : undefined;

      if (!match || binary === undefined) return new Response("missing", { status: 404 });
      if (match[2] === "SHA256SUMS") return new Response(`${tamper ? sha256("x") : sha256(binary)}  ${assetName()}\n`);
      if (match[2] === assetName()) return new Response(binary);
      return new Response("missing", { status: 404 });
    },
  });

  process.env.SPINUP_INSTALL_API_URL = `${server.url}api`;
  process.env.SPINUP_INSTALL_DOWNLOAD_URL = `${server.url}download`;
});

afterEach(async () => {
  server.stop(true);
  process.env.SPINUP_INSTALL_API_URL = saved.api;
  process.env.SPINUP_INSTALL_DOWNLOAD_URL = saved.download;
  if (saved.api === undefined) delete process.env.SPINUP_INSTALL_API_URL;
  if (saved.download === undefined) delete process.env.SPINUP_INSTALL_DOWNLOAD_URL;
  await cleanupTempDir(root);
});

const quiet = () => undefined;

describe("self-update", () => {
  test("compares versions numerically", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
  });

  test("replaces the binary with the verified latest release and prints its notes", async () => {
    const lines: string[] = [];
    const result = await updateBinary({ currentVersion: "0.5.0", executablePath: executable, log: (line) => lines.push(line) });

    expect(result).toEqual({ from: "0.5.0", to: "0.6.0", changed: true });
    expect(await readFile(executable, "utf8")).toBe(script("0.6.0"));
    expect(lines.join("\n")).toContain("- faster");
    expect(await readdir(root)).toEqual(["spinup"]);
  });

  test("a checksum mismatch changes nothing", async () => {
    tamper = true;
    await expect(updateBinary({ currentVersion: "0.5.0", executablePath: executable, log: quiet })).rejects.toThrow("Checksum mismatch");
    expect(await readFile(executable, "utf8")).toBe(script("0.5.0"));
    expect(await readdir(root)).toEqual(["spinup"]);
  });

  test("a binary reporting another version is not installed", async () => {
    binaries["v0.6.0"] = script("7.7.7");
    await expect(updateBinary({ currentVersion: "0.5.0", executablePath: executable, log: quiet })).rejects.toThrow("reports 7.7.7");
    expect(await readFile(executable, "utf8")).toBe(script("0.5.0"));
  });

  test("a release without checksums is refused", async () => {
    await expect(
      updateBinary({ currentVersion: "0.5.0", executablePath: executable, requested: "v0.7.0", log: quiet }),
    ).rejects.toThrow("cannot be verified");
  });

  test("the latest release being older is refused; naming an older version downgrades", async () => {
    await expect(updateBinary({ currentVersion: "0.9.0", executablePath: executable, log: quiet })).rejects.toThrow("Name a version to downgrade");

    const result = await updateBinary({ currentVersion: "0.5.0", executablePath: executable, requested: "0.4.0", log: quiet });
    expect(result.to).toBe("0.4.0");
    expect(await readFile(executable, "utf8")).toBe(script("0.4.0"));
  });

  test("already current is not an error and downloads nothing", async () => {
    const result = await updateBinary({ currentVersion: "0.6.0", executablePath: executable, log: quiet });
    expect(result.changed).toBe(false);
    expect(await readFile(executable, "utf8")).toBe(script("0.5.0"));
  });
});
