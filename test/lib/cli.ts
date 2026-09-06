/**
 * Runs the real claudep.ts as a subprocess against a fake $HOME and a fake
 * `claude`/`security` on PATH, and returns what a user would see.
 */
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

export const REPO = resolve(import.meta.dir, "..", "..");
export const SCRIPT = join(REPO, "claudep.ts");

const FAKE_CLAUDE = join(import.meta.dir, "fake-claude.ts");
const FAKE_SECURITY = join(import.meta.dir, "fake-security.ts");
const WIN = process.platform === "win32";

/** A command named `name` that runs `script` with bun. An sh file on POSIX;
 *  on Windows a .cmd file, which is what an npm-installed claude is too, so
 *  the tests there go through claudep's cmd.exe launcher. */
function shim(bin: string, name: string, script: string): void {
  if (WIN) {
    writeFileSync(join(bin, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return;
  }
  const dest = join(bin, name);
  writeFileSync(dest, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(dest, 0o755);
}

/** Creates <home>/bin with `claude` and `security` shims, optionally a `claudep` on PATH. */
export function fakeBin(home: string, opts: { withClaudep?: boolean } = {}): string {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  shim(bin, "claude", FAKE_CLAUDE);
  if (!WIN) shim(bin, "security", FAKE_SECURITY);
  if (opts.withClaudep) {
    if (WIN) shim(bin, "claudep", SCRIPT);
    else symlinkSync(SCRIPT, join(bin, "claudep"));
  }
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

/** Windows environment blocks are case-insensitive and the runner's PATH is
 *  spelled `Path`, so every spelling of a name goes before it is set. */
function setEnv(env: Record<string, string | undefined>, name: string, value: string | undefined): void {
  for (const k of Object.keys(env)) if (k.toUpperCase() === name.toUpperCase()) delete env[k];
  if (value !== undefined) env[name] = value;
}

export async function runCli(args: string[], opts: RunOptions): Promise<CliResult> {
  const bin = opts.bin ?? fakeBin(opts.home);
  const env: Record<string, string | undefined> = { ...process.env };
  setEnv(env, "HOME", opts.home);
  setEnv(env, "USERPROFILE", opts.home);
  setEnv(env, "PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
  setEnv(env, "NO_COLOR", "1");
  setEnv(env, "CLAUDE_CONFIG_DIR", undefined);
  setEnv(env, "CLAUDE_PROFILES_DIR", undefined);
  for (const [k, v] of Object.entries(opts.env ?? {})) setEnv(env, k, v);

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
