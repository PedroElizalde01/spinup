/**
 * One place decides how a command's result reaches the user. In JSON mode stdout
 * carries exactly one document and nothing else; diagnostics go to stderr.
 */
let jsonMode = false;

export function setJsonMode(enabled: boolean): void {
  jsonMode = enabled;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

export function emit(report: unknown, render: () => void): void {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  render();
}

/** Honors NO_COLOR and --no-color, and never colors a pipe. */
export function colorEnabled(): boolean {
  return Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
}

/** Exit statuses the CLI promises. Tasks and signals have their own, see executor. */
export const EXIT = {
  ok: 0,
  usage: 1,
  notReady: 2,
} as const;
