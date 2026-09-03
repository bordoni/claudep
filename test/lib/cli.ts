/**
 * Runs the real claudep.ts as a subprocess against a fake $HOME and a fake
 * `claude`/`security` on PATH, and returns what a user would see.
 */
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const REPO = resolve(import.meta.dir, "..", "..");
export const SCRIPT = join(REPO, "claudep.ts");

const FAKE_CLAUDE = join(import.meta.dir, "fake-claude.ts");
const FAKE_SECURITY = join(import.meta.dir, "fake-security.ts");

function shim(dest: string, script: string): void {
  writeFileSync(dest, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(dest, 0o755);
}

/** Creates <home>/bin with `claude` and `security` shims, optionally a `claudep` symlink. */
export function fakeBin(home: string, opts: { withClaudep?: boolean } = {}): string {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  shim(join(bin, "claude"), FAKE_CLAUDE);
  shim(join(bin, "security"), FAKE_SECURITY);
  if (opts.withClaudep) symlinkSync(SCRIPT, join(bin, "claudep"));
  return bin;
}

export type CliResult = { exitCode: number; stdout: string; stderr: string };

export type RunOptions = {
  home: string;
  /** Extra env for this call. Values of `undefined` unset the variable. */
  env?: Record<string, string | undefined>;
  /** A bin dir to prepend to PATH; defaults to fakeBin(home). */
  bin?: string;
  cwd?: string;
};

export async function runCli(args: string[], opts: RunOptions): Promise<CliResult> {
  const bin = opts.bin ?? fakeBin(opts.home);
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: opts.home,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    NO_COLOR: "1",
    CLAUDE_CONFIG_DIR: undefined,
    CLAUDE_PROFILES_DIR: undefined,
    ...opts.env,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];

  const proc = Bun.spawn([process.execPath, SCRIPT, ...args], {
    env: env as Record<string, string>,
    cwd: opts.cwd ?? opts.home,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}
