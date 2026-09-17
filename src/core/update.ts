import { createHash } from "node:crypto";
import { constants, readdirSync } from "node:fs";
import { chmod, open, rename, rm } from "node:fs/promises";
import path from "node:path";

import { execa } from "execa";

const OWNER_REPO = "PedroElizalde01/spinup";
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;

export type UpdateOptions = {
  currentVersion: string;
  /** The running binary, replaced in place. */
  executablePath: string;
  /** A specific version; without one, the latest release. */
  requested?: string;
  log?: (line: string) => void;
};

export type UpdateResult = {
  from: string;
  to: string;
  changed: boolean;
};

function parseVersion(version: string): [number, number, number] {
  const match = VERSION_PATTERN.exec(version);

  if (!match) {
    throw new Error(`"${version}" is not a version like 1.2.3.`);
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);

  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) {
      return a[index]! - b[index]!;
    }
  }

  return 0;
}

/** Same names the release workflow publishes and install.sh downloads. */
export function assetName(platform = process.platform, arch = process.arch): string {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : undefined;
  const cpu = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : undefined;

  if (!os || !cpu) {
    throw new Error(`No spinup release is published for ${platform}/${arch}.`);
  }

  let musl = false;

  if (os === "linux") {
    try {
      musl = readdirSync("/lib").some((entry) => entry.startsWith("ld-musl-"));
    } catch {
      musl = false;
    }
  }

  return `spinup-${os}-${cpu}${musl ? "-musl" : ""}`;
}

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "spinup-updater" } }).catch(
    (error: unknown) => {
      throw new Error(`Could not reach ${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`);
    },
  );

  if (!response.ok) {
    throw Object.assign(new Error(`${url} answered ${response.status}`), { status: response.status });
  }

  return response;
}

/**
 * Replaces the running binary with a verified release. The download must match the
 * release's SHA256SUMS and report the expected version before a single rename puts
 * it in place, so any failure leaves the current binary as it was.
 */
export async function updateBinary(options: UpdateOptions): Promise<UpdateResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const apiUrl = process.env.SPINUP_INSTALL_API_URL ?? `https://api.github.com/repos/${OWNER_REPO}`;
  const downloadUrl = process.env.SPINUP_INSTALL_DOWNLOAD_URL ?? `https://github.com/${OWNER_REPO}/releases/download`;
  const current = options.currentVersion;

  let tag: string;
  let notes = "";

  if (options.requested) {
    parseVersion(options.requested);
    tag = options.requested.startsWith("v") ? options.requested : `v${options.requested}`;
    notes = ((await fetchOk(`${apiUrl}/releases/tags/${tag}`).then((response) => response.json()).catch(() => ({}))) as { body?: string }).body ?? "";
  } else {
    const latest = (await (await fetchOk(`${apiUrl}/releases/latest`)).json()) as { tag_name?: string; body?: string };

    if (!latest.tag_name) {
      throw new Error("Could not determine the latest spinup release.");
    }

    tag = latest.tag_name;
    notes = latest.body ?? "";
  }

  const target = tag.slice(1);
  const order = compareVersions(target, current);

  if (order === 0) {
    log(`spinup ${current} is already the ${options.requested ? "requested" : "latest"} version.`);
    return { from: current, to: target, changed: false };
  }

  if (order < 0 && !options.requested) {
    throw new Error(`The latest release (${target}) is older than this spinup (${current}). Name a version to downgrade: spinup --update ${tag}`);
  }

  const asset = assetName();
  log(`Downloading spinup ${target} (${asset})...`);

  let sums: string;

  try {
    sums = await (await fetchOk(`${downloadUrl}/${tag}/SHA256SUMS`)).text();
  } catch {
    throw new Error(`${tag} has no SHA256SUMS, so it cannot be verified. Nothing was changed.`);
  }

  const expected = sums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === asset || name === `*${asset}`)?.[0];

  if (!expected) {
    throw new Error(`SHA256SUMS for ${tag} has no entry for ${asset}. Nothing was changed.`);
  }

  const binary = Buffer.from(await (await fetchOk(`${downloadUrl}/${tag}/${asset}`)).arrayBuffer());
  const actual = createHash("sha256").update(binary).digest("hex");

  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${asset}: expected ${expected}, got ${actual}. Nothing was changed.`);
  }

  const directory = path.dirname(options.executablePath);
  const staged = path.join(directory, `.spinup-update.${process.pid}.${Date.now().toString(36)}`);

  try {
    const handle = await open(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o700).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EACCES" || error.code === "EPERM") {
        throw new Error(`Cannot write to ${directory}. Update with the installer instead, or run with permission to replace ${options.executablePath}.`);
      }

      throw error;
    });

    try {
      await handle.writeFile(binary);
    } finally {
      await handle.close();
    }

    await chmod(staged, 0o755);
    const reported = await execa(staged, ["--version"]).then(
      (result) => result.stdout.trim(),
      () => undefined,
    );

    if (reported !== target) {
      throw new Error(
        reported === undefined
          ? `The downloaded ${asset} does not run on this system. Nothing was changed.`
          : `The downloaded binary reports ${reported}, expected ${target}. Nothing was changed.`,
      );
    }

    await rename(staged, options.executablePath);
  } finally {
    await rm(staged, { force: true });
  }

  log(`Updated spinup ${current} -> ${target} (${options.executablePath}).`);

  const excerpt = notes
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(0, 15);

  if (excerpt.length > 0) {
    log(`\nRelease notes (https://github.com/${OWNER_REPO}/releases/tag/${tag}):`);

    for (const line of excerpt) {
      log(`  ${line}`);
    }
  }

  return { from: current, to: target, changed: true };
}
