import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { execa } from "execa";

import { cleanupTempDir, makeTempDir } from "./helpers.ts";

// install.sh against a local fake release: every failure must leave an existing
// spinup exactly as it was and no staging files behind.
const INSTALLER = new URL("../install.sh", import.meta.url).pathname;
const ASSETS = ["linux-x64", "linux-arm64", "linux-x64-musl", "linux-arm64-musl", "darwin-x64", "darwin-arm64"].map(
  (target) => `spinup-${target}`,
);

type Release = {
  binary?: string;
  sums?: "valid" | "wrong" | "missing";
  missingAsset?: boolean;
};

let root: string;
let binDir: string;
let server: ReturnType<typeof Bun.serve>;
let release: Record<string, Release>;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const script = (version: string) => `#!/bin/sh\necho ${version}\n`;

beforeEach(async () => {
  root = await makeTempDir("spinup-install-");
  binDir = path.join(root, "bin");
  await mkdir(binDir, { recursive: true });
  release = {};

  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/api/releases/latest") {
        return Response.json({ tag_name: "v0.5.0" });
      }

      const match = /^\/download\/(v[^/]+)\/(.+)$/.exec(url.pathname);
      const spec = match ? release[match[1]!] : undefined;

      if (!match || !spec) {
        return new Response("not found", { status: 404 });
      }

      const binary = spec.binary ?? script(match[1]!.slice(1));
      const [, , file] = match;

      if (file === "SHA256SUMS") {
        if (spec.sums === "missing") return new Response("not found", { status: 404 });
        const digest = spec.sums === "wrong" ? sha256("tampered") : sha256(binary);
        return new Response([...ASSETS.map((asset) => `${digest}  ${asset}`), `${sha256("man")}  spinup.1`].join("\n") + "\n");
      }

      if (file === "spinup.1") return new Response("man");
      if (ASSETS.includes(file!) && !spec.missingAsset) return new Response(binary);
      return new Response("not found", { status: 404 });
    },
  });
});

afterEach(async () => {
  server.stop(true);
  await cleanupTempDir(root);
});

async function install(args: string[] = []) {
  return execa("bash", [INSTALLER, "--bin-dir", binDir, ...args], {
    reject: false,
    env: {
      ...process.env,
      HOME: root,
      XDG_DATA_HOME: path.join(root, "share"),
      SPINUP_INSTALL_API_URL: `${server.url}api`,
      SPINUP_INSTALL_DOWNLOAD_URL: `${server.url}download`,
    },
  });
}

async function withExistingInstall(): Promise<string> {
  const previous = script("0.4.0");
  await writeFile(path.join(binDir, "spinup"), previous, { mode: 0o755 });
  return previous;
}

async function expectUntouched(previous: string): Promise<void> {
  expect(await readFile(path.join(binDir, "spinup"), "utf8")).toBe(previous);
  expect(await readdir(binDir)).toEqual(["spinup"]);
}

describe("install.sh", () => {
  test("installs the latest release after verifying its checksum, with the man page", async () => {
    release["v0.5.0"] = { sums: "valid" };
    const result = await install();

    expect(`${result.exitCode} ${result.stderr}`).toBe("0 ");
    expect(result.stdout).toContain("Verified spinup-");
    expect((await execa(path.join(binDir, "spinup"), ["--version"])).stdout).toBe("0.5.0");
    expect(await readFile(path.join(root, "share", "man", "man1", "spinup.1"), "utf8")).toBe("man");
    expect(await readdir(binDir)).toEqual(["spinup"]);
  });

  test("a checksum mismatch installs nothing and keeps the previous binary", async () => {
    const previous = await withExistingInstall();
    release["v0.5.0"] = { sums: "wrong" };

    const result = await install();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("checksum mismatch");
    await expectUntouched(previous);
  });

  test("a missing asset installs nothing", async () => {
    const previous = await withExistingInstall();
    release["v0.5.0"] = { sums: "valid", missingAsset: true };

    const result = await install();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("could not download");
    await expectUntouched(previous);
  });

  test("a binary that does not run or reports another version is not installed", async () => {
    const previous = await withExistingInstall();

    release["v0.5.0"] = { sums: "valid", binary: "#!/bin/sh\nexit 1\n" };
    expect((await install()).stderr).toContain("does not run on this system");
    await expectUntouched(previous);

    release["v0.5.0"] = { sums: "valid", binary: script("9.9.9") };
    expect((await install()).stderr).toContain("reports version '9.9.9'");
    await expectUntouched(previous);
  });

  test("a new release without SHA256SUMS is refused; a release from before checksums warns", async () => {
    const previous = await withExistingInstall();

    release["v0.5.0"] = { sums: "missing" };
    const refused = await install();
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("cannot be verified");
    await expectUntouched(previous);

    // The musl asset never existed before v0.5.0; this case is only about glibc hosts.
    if (process.platform === "linux" && (await Bun.file("/lib/ld-musl-x86_64.so.1").exists())) return;
    release["v0.4.0"] = { sums: "missing" };
    const old = await install(["--version", "v0.4.0"]);
    expect(old.exitCode).toBe(0);
    expect(old.stderr).toContain("published before releases carried checksums");
  });

  test.each([
    [["--version"], "--version needs a value"],
    [["--bin-dir"], "--bin-dir needs a value"],
    [["--version", "latest"], "must look like v1.2.3"],
    [["--version", "v0.2.2"], "predates the rename"],
    [["--frobnicate"], "Unknown argument"],
  ])("rejects %p before downloading", async (args, message) => {
    const result = await install(args);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(await readdir(binDir)).toEqual([]);
  });
});
