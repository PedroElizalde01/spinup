import { constants, createWriteStream, type WriteStream } from "node:fs";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Per file, per run. A runaway service cannot fill the disk. */
export const LOG_LIMIT_BYTES = 10 * 1024 * 1024;

function stateHome(): string {
  const value = process.env.XDG_STATE_HOME;
  return value && path.isAbsolute(value) ? value : path.join(homedir(), ".local", "state");
}

export function logDirectory(alias: string): string {
  return path.join(stateHome(), "spinup", "logs", alias);
}

export function logPath(alias: string, service: string): string {
  return path.join(logDirectory(alias), `${service}.log`);
}

/**
 * Keeps the previous run as <service>.log.1 and creates an empty private file.
 * Logs hold whatever a service prints, which can include secrets, so the directory
 * is 0700 and files are 0600 regardless of umask.
 */
export async function prepareLogFile(alias: string, service: string): Promise<string> {
  const directory = logDirectory(alias);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  const file = logPath(alias, service);

  try {
    if ((await stat(file)).isFile()) {
      await rename(file, `${file}.1`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await rm(file, { force: true });
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  await handle.close();
  return file;
}

/** An append stream that stops at the size limit and says so once. */
export class CappedLog {
  private written = 0;
  private stopped = false;
  private readonly stream: WriteStream;

  constructor(file: string) {
    this.stream = createWriteStream(file, { flags: "a", mode: 0o600 });
    // A logging failure must never take the service down with it.
    this.stream.on("error", () => {
      this.stopped = true;
    });
  }

  write(line: string): void {
    if (this.stopped) {
      return;
    }

    const bytes = Buffer.byteLength(line);

    if (this.written + bytes > LOG_LIMIT_BYTES) {
      this.stream.write(`[spinup] log reached ${LOG_LIMIT_BYTES} bytes; later output was not written\n`);
      this.stopped = true;
      return;
    }

    this.written += bytes;
    this.stream.write(line);
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(resolve));
  }
}

/**
 * For tmux: the pane's output through awk, flushed per line and stopped at the
 * limit. head -c enforces a limit but buffers until its input ends, and dd did not
 * stream on macOS. mawk, Debian and Ubuntu's default awk, reads its input in large
 * blocks unless given -W interactive, which other awks reject; the version probe
 * reads /dev/null so it can never consume pane output. awk counts characters,
 * which matches bytes for ASCII output and errs low otherwise.
 */
export function tmuxPipeCommand(file: string): string {
  const quoted = `'${file.replace(/'/g, `'\\''`)}'`;
  const program = `'{ written += length($0) + 1; if (written > ${LOG_LIMIT_BYTES}) { print "[spinup] log reached ${LOG_LIMIT_BYTES} bytes; later output was not written"; exit } print; fflush() }'`;
  return (
    `if awk -W version </dev/null 2>/dev/null | grep -q mawk; ` +
    `then exec awk -W interactive ${program} >> ${quoted}; ` +
    `else exec awk ${program} >> ${quoted}; fi`
  );
}
