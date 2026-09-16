import { homedir } from "node:os";
import path from "node:path";

export function expandHome(inputPath: string): string {
  if (inputPath === "~") {
    return homedir();
  }

  if (inputPath.startsWith("~/")) {
    return path.join(homedir(), inputPath.slice(2));
  }

  return inputPath;
}

/**
 * The XDG spec requires absolute paths and says a relative value must be ignored,
 * so a stray relative override falls back to the default rather than resolving
 * against whatever directory spinup happened to be invoked from.
 */
function resolveOverride(value: string | undefined, fallback: string): string {
  return value && path.isAbsolute(value) ? value : fallback;
}

export function getConfigBaseDir(): string {
  return resolveOverride(process.env.XDG_CONFIG_HOME, path.join(homedir(), ".config"));
}

export function getConfigDir(): string {
  return path.join(getConfigBaseDir(), "spinup");
}

/** Where the registry lived before the tool was renamed from runit. */
export function getLegacyConfigDir(): string {
  return path.join(getConfigBaseDir(), "runit");
}

export function getRegistryPath(): string {
  return path.join(getConfigDir(), "projects.json");
}

export function getShimDir(): string {
  return resolveOverride(process.env.SPINUP_SHIM_DIR ?? process.env.RUNIT_SHIM_DIR, path.join(homedir(), ".local", "bin"));
}
