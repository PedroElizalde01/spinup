// Bundled into the compiled binary, so source and release report the same version.
import packageJson from "../../package.json" with { type: "json" };

export const TAGLINE = "spin up any project from anywhere";

/** Two-row half-block wordmark, 22 columns. Shared by the setup card and the help banner. */
export const GLYPH: readonly [string, string] = ["█▀▀ █▀█ █ █▄ █ █ █ █▀█", "▄▄█ █▀▀ █ █ ▀█ █▄█ █▀▀"];

/**
 * Wordmark, version and tagline for `spinup` with no arguments and `--help`.
 * Plain text when stdout is not a terminal so piped help stays clean.
 */
export function banner(): string {
  const color = process.stdout.isTTY && process.env.NO_COLOR === undefined;
  const paint = (value: string) => (color ? `\x1b[1m\x1b[36m${value}\x1b[0m` : value);
  const dim = (value: string) => (color ? `\x1b[2m${value}\x1b[0m` : value);

  return [`${paint(GLYPH[0])}   ${dim(`v${packageJson.version}`)}`, `${paint(GLYPH[1])}   ${dim(TAGLINE)}`, ""].join("\n");
}
