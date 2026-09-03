#!/usr/bin/env bun
/**
 * claudep: run Claude Code under separate accounts on one machine.
 *
 * Keeps ~/.claude as the untouched "default" profile and creates thin overlay
 * profiles under ~/.claudep/<name>. Shared config (CLAUDE.md, settings,
 * skills, plugins, hooks, agents, sessions/memory) is symlinked back into the
 * base; credentials, .claude.json and runtime state are per profile.
 *
 * Claude Code namespaces its macOS Keychain entry by CLAUDE_CONFIG_DIR
 * ("Claude Code-credentials-<sha256(dir)[0:8]>"), so each profile is a fully
 * separate login. Run `claudep help` for usage.
 *
 * Zero runtime dependencies. Requires bun >= 1.1 and a `claude` binary on PATH.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export type Env = Record<string, string | undefined>;

/** Home directory. $HOME wins so tests and containers can redirect it; bun's
 *  os.homedir() reads getpwuid() and ignores the variable. */
export function homeDir(env: Env = process.env): string {
  return env.HOME || homedir();
}

/** Canonical form of a config dir: absolute, no trailing slash, NFC.
 *  Claude Code hashes the *literal* CLAUDE_CONFIG_DIR string for the keychain
 *  service name, so the same profile must always produce the same string. */
export function canon(p: string, home: string = homeDir()): string {
  const expanded = p.startsWith("~/") ? join(home, p.slice(2)) : p;
  return resolve(expanded).replace(/\/+$/, "").normalize("NFC");
}

export type Layout = {
  home: string;
  /** CLAUDE_CONFIG_DIR as set in the caller's shell, if any. */
  callerConfigDir: string | undefined;
  /** True when the caller's CLAUDE_CONFIG_DIR points inside the profiles root,
   *  i.e. a claudep profile is active in this shell (pinned by hand or by the hook). */
  managed: boolean;
  /** The active profile name when `managed` and the dir is a valid profile. */
  activeProfile: string | undefined;
  /** The base config dir every profile links back into. */
  base: string;
  /** Global state file for the base. Without CLAUDE_CONFIG_DIR it lives at
   *  ~/.claude.json; with it, inside the config dir. */
  baseGlobalJson: string;
  profilesRoot: string;
};

export function layout(env: Env = process.env): Layout {
  const home = homeDir(env);
  const callerConfigDir = env.CLAUDE_CONFIG_DIR;
  const profilesRoot = canon(env.CLAUDE_PROFILES_DIR ?? join(home, ".claudep"), home);
  const callerCanon = callerConfigDir !== undefined ? canon(callerConfigDir, home) : undefined;
  const managed = callerCanon !== undefined && callerCanon.startsWith(`${profilesRoot}/`);
  const tail = managed && callerCanon !== undefined ? callerCanon.slice(profilesRoot.length + 1) : undefined;
  const activeProfile = tail !== undefined && NAME_RE.test(tail) ? tail : undefined;
  // A custom CLAUDE_CONFIG_DIR outside the profiles root is the user's real base.
  // One inside it is a claudep profile and must never be treated as the base.
  const customBase = callerCanon !== undefined && !managed;
  const base = customBase && callerCanon !== undefined ? callerCanon : canon(join(home, ".claude"), home);
  return {
    home,
    callerConfigDir,
    managed,
    activeProfile,
    base,
    baseGlobalJson: customBase ? join(base, ".claude.json") : join(home, ".claude.json"),
    profilesRoot,
  };
}

/** The directory-pin file. A repo (or any directory tree) that contains one
 *  names the profile every hooked shell should use inside that tree. */
export const PIN_FILE = ".claudep";

export type Pin = { name: string; file: string; dir: string };

/** First non-empty, non-comment line of a pin file, trimmed. Empty means "no pin". */
export function readPinName(file: string): string {
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    return line;
  }
  return "";
}

/** Nearest PIN_FILE walking upward from startDir. Only regular files count
 *  (~/.claudep is a directory and is skipped). The nearest file wins even when
 *  it is empty, which is how a subtree cancels a parent pin. The shell hook
 *  from `shell-init` mirrors this exactly. */
export function resolvePin(startDir: string): Pin | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const file = join(dir, PIN_FILE);
    let isFile = false;
    try {
      isFile = statSync(file).isFile();
    } catch {
      isFile = false;
    }
    if (isFile) return { name: readPinName(file), file, dir };
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export type Current = {
  kind: "base" | "profile" | "custom";
  name: string | undefined;
  dir: string;
  setBy: "none" | "hook" | "manual";
};

/** What this shell is running Claude Code as, and how it got that way. */
export function currentProfile(L: Layout, env: Env = process.env): Current {
  const cfg = env.CLAUDE_CONFIG_DIR;
  if (!cfg) return { kind: "base", name: undefined, dir: L.base, setBy: "none" };
  const dir = canon(cfg, L.home);
  const auto = env.CLAUDEP_AUTO;
  const setBy = auto !== undefined && canon(auto, L.home) === dir ? "hook" : "manual";
  if (L.activeProfile !== undefined) return { kind: "profile", name: L.activeProfile, dir, setBy };
  return { kind: "custom", name: undefined, dir, setBy };
}

/** Version from the package.json next to this file. */
export function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** Top-level base items symlinked into every profile (only if they exist). */
export const SHARED_FILES = ["CLAUDE.md", "settings.json", "keybindings.json", "statusline-command.sh"] as const;
export const SHARED_DIRS = ["hooks", "skills", "commands", "agents", "plugins", "plans", "projects"] as const;

/** Per-profile state. First block is Claude Code's own runtime-state list;
 *  the rest are observed extras. Never shared. */
export const KNOWN_PRIVATE = new Set<string>([
  ".claude.json",
  ".claude.json.backup",
  ".credentials.json",
  "sessions",
  "todos",
  "shell-snapshots",
  "statsig",
  "file-history",
  "history.jsonl",
  "ide",
  "logs",
  "backups",
  ".session_ingress_token",
  "remote-settings.json",
  "policy-limits.json",
  "stats-cache.json",
  "mcp-needs-auth-cache.json",
  "telemetry",
  "debug",
  "cache",
  "daemon",
  "daemon.log",
  "tasks",
  "jobs",
  "session-env",
  "paste-cache",
  "scheduled-tasks",
  "chrome",
  "feedback",
  "local",
  "settings.local.json",
  ".DS_Store",
  ".config.json",
  ".last-cleanup",
  ".last-update-result.json",
  "daemon-auth-cooldown",
  "daemon-auth-status.json",
]);

/** Keys copied from the base .claude.json into a fresh profile so first-run
 *  onboarding does not repeat. Account identity is deliberately excluded. */
export const SEED_KEYS = [
  "hasCompletedOnboarding",
  "lastOnboardingVersion",
  "theme",
  "editorMode",
  "preferredNotifChannel",
  "shiftEnterKeyBindingInstalled",
  "autoUpdates",
  "installMethod",
] as const;

export const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
export const RESERVED = new Set([
  "default",
  "base",
  "init",
  "run",
  "list",
  "ls",
  "status",
  "env",
  "doctor",
  "rm",
  "remove",
  "alias",
  "help",
  "current",
  "local",
  "resolve",
  "shell-init",
  "version",
]);

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const tty = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const c = {
  bold: (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s),
  green: (s: string) => (tty ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (tty ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (tty ? `\x1b[31m${s}\x1b[0m` : s),
};
const ok = (msg: string) => console.log(`${c.green("✓")} ${msg}`);
const warn = (msg: string) => console.log(`${c.yellow("!")} ${msg}`);
const bad = (msg: string) => console.log(`${c.red("✗")} ${msg}`);

export function die(msg: string, code = 1): never {
  console.error(`${c.red("error:")} ${msg}`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Profile helpers
// ---------------------------------------------------------------------------

export function profileDir(L: Layout, name: string): string {
  if (!NAME_RE.test(name)) die(`invalid profile name "${name}" (use [a-z0-9_-], starting with a letter or digit)`);
  if (RESERVED.has(name)) die(`"${name}" is a reserved word and cannot be a profile name`);
  return canon(join(L.profilesRoot, name), L.home);
}

export function profileExists(L: Layout, name: string): boolean {
  return NAME_RE.test(name) && !RESERVED.has(name) && existsSync(join(L.profilesRoot, name));
}

export function listProfileNames(L: Layout): string[] {
  if (!existsSync(L.profilesRoot)) return [];
  return readdirSync(L.profilesRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && NAME_RE.test(d.name) && !RESERVED.has(d.name))
    .map((d) => d.name)
    .sort();
}

/** Keychain service name Claude Code uses for a non-default config dir. */
export function keychainService(dir: string): string {
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

export type SharedItem = { name: string; kind: "file" | "dir" };

/** Shared items that actually exist in the base right now. */
export function sharedItems(base: string): SharedItem[] {
  const items: SharedItem[] = [];
  const seen = new Set<string>();
  const push = (name: string, kind: SharedItem["kind"]) => {
    if (seen.has(name)) return;
    if (!existsSync(join(base, name))) return;
    seen.add(name);
    items.push({ name, kind });
  };
  for (const f of SHARED_FILES) push(f, "file");
  if (existsSync(base)) {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.name.endsWith(".md") && !entry.isDirectory()) push(entry.name, "file");
    }
  }
  for (const d of SHARED_DIRS) push(d, "dir");
  return items;
}

export type LinkResult = "linked" | "ok" | "wrong-target" | "conflict";

/** Idempotent symlink profile/<name> -> base/<name>. Never overwrites real files. */
export function link(base: string, dir: string, name: string, force: boolean): LinkResult {
  const target = join(base, name);
  const dest = join(dir, name);
  let st: ReturnType<typeof lstatSync> | undefined;
  try {
    st = lstatSync(dest);
  } catch {
    st = undefined;
  }
  if (!st) {
    symlinkSync(target, dest);
    return "linked";
  }
  if (st.isSymbolicLink()) {
    if (readlinkSync(dest) === target) return "ok";
    if (force) {
      rmSync(dest);
      symlinkSync(target, dest);
      return "linked";
    }
    return "wrong-target";
  }
  return "conflict";
}

export type JsonObject = Record<string, unknown>;

export async function readJson(path: string): Promise<JsonObject | undefined> {
  try {
    const parsed: unknown = JSON.parse(await Bun.file(path).text());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : undefined;
  } catch {
    return undefined;
  }
}

export type SeedResult = "seeded" | "exists" | "no-base";

export async function seedGlobalJson(baseGlobalJson: string, dir: string, copyMcp: boolean): Promise<SeedResult> {
  const dest = join(dir, ".claude.json");
  if (existsSync(dest)) return "exists";
  const base = await readJson(baseGlobalJson);
  if (!base) return "no-base";
  const seed: JsonObject = {};
  for (const k of SEED_KEYS) if (k in base) seed[k] = base[k];
  if (copyMcp && base.mcpServers && typeof base.mcpServers === "object") seed.mcpServers = base.mcpServers;
  await Bun.write(dest, `${JSON.stringify(seed, null, 2)}\n`);
  return "seeded";
}

// ---------------------------------------------------------------------------
// Running claude
// ---------------------------------------------------------------------------

function claudeBin(): string {
  const bin = Bun.which("claude");
  if (!bin) die("`claude` not found on PATH. Install Claude Code first: https://code.claude.com/docs/en/setup");
  return bin;
}

/** Environment for a profile. `undefined` dir means "the base", i.e. leave the
 *  caller's CLAUDE_CONFIG_DIR exactly as it is (set or unset). */
export function envFor(dir: string | undefined, env: Env = process.env): Env {
  const out: Env = { ...env };
  if (dir !== undefined) out.CLAUDE_CONFIG_DIR = dir;
  return out;
}

/** Environment for running claude against the base. If a claudep profile is
 *  active in this shell (hook or manual pin), strip it so "default" really is
 *  the base and not whatever the current directory pinned. */
export function baseEnv(L: Layout, env: Env = process.env): Env {
  const out: Env = { ...env };
  if (L.managed) {
    delete out.CLAUDE_CONFIG_DIR;
    delete out.CLAUDEP_AUTO;
  }
  return out;
}

function claudeEnv(L: Layout, dir: string | undefined): Env {
  return dir === undefined ? baseEnv(L) : envFor(dir);
}

async function execClaude(L: Layout, dir: string | undefined, args: string[]): Promise<never> {
  const proc = Bun.spawn([claudeBin(), ...args], {
    env: claudeEnv(L, dir),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  // Ctrl+C reaches the child through the terminal; keep the wrapper alive so
  // it can report the child's real exit code.
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => proc.kill("SIGTERM"));
  process.on("SIGHUP", () => proc.kill("SIGHUP"));
  await proc.exited;
  process.exit(proc.exitCode ?? 1);
}

async function captureClaude(
  L: Layout,
  dir: string | undefined,
  args: string[],
): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([claudeBin(), ...args], {
    env: claudeEnv(L, dir),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, out };
}

export type AuthStatus = {
  loggedIn: boolean;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
  authMethod?: string;
};

export function parseAuthStatus(text: string): AuthStatus {
  try {
    const j: unknown = JSON.parse(text);
    if (!j || typeof j !== "object") return { loggedIn: false };
    const o = j as JsonObject;
    const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);
    return {
      loggedIn: o.loggedIn === true,
      email: str("email"),
      orgName: str("orgName"),
      subscriptionType: str("subscriptionType"),
      authMethod: str("authMethod"),
    };
  } catch {
    return { loggedIn: false };
  }
}

async function authStatus(L: Layout, dir: string | undefined): Promise<AuthStatus> {
  const { out } = await captureClaude(L, dir, ["auth", "status", "--json"]);
  return parseAuthStatus(out);
}

/** Minimal spawner shape so the keychain check can be exercised without a real `security`. */
export type Spawner = (cmd: string[]) => { exited: Promise<number> };

export type KeychainDeps = { platform: NodeJS.Platform; username: string; spawn: Spawner };

const defaultKeychainDeps = (): KeychainDeps => ({
  platform: process.platform,
  username: userInfo().username,
  spawn: (cmd) => Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }),
});

/** true/false on macOS, undefined elsewhere. Exit code only; the secret is never read. */
export async function keychainHas(
  service: string,
  deps: KeychainDeps = defaultKeychainDeps(),
): Promise<boolean | undefined> {
  if (deps.platform !== "darwin") return undefined;
  const proc = deps.spawn(["security", "find-generic-password", "-s", service, "-a", deps.username]);
  return (await proc.exited) === 0;
}

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

export type Flags = { bools: Set<string>; strs: Map<string, string>; rest: string[] };

export function parseFlags(args: string[], boolNames: readonly string[], strNames: readonly string[]): Flags {
  const flags: Flags = { bools: new Set(), strs: new Map(), rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (boolNames.includes(a)) {
      flags.bools.add(a);
    } else if (strNames.includes(a)) {
      const v = args[i + 1];
      if (v === undefined) die(`${a} requires a value`);
      flags.strs.set(a, v);
      i++;
    } else if (a.startsWith("--") && strNames.some((s) => a.startsWith(`${s}=`))) {
      const eq = a.indexOf("=");
      flags.strs.set(a.slice(0, eq), a.slice(eq + 1));
    } else if (a.startsWith("-")) {
      die(`unknown flag ${a}`);
    } else {
      flags.rest.push(a);
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdInit(L: Layout, args: string[]): Promise<void> {
  const f = parseFlags(args, ["--copy-mcp", "--no-login", "--sso", "--console", "--force"], ["--email", "--alias"]);
  const name = f.rest[0];
  if (!name)
    die(
      "usage: claudep init <name> [--copy-mcp] [--no-login] [--sso] [--email <e>] [--console] [--alias <cmd>] [--force]",
    );
  if (!existsSync(L.base)) die(`base config dir ${L.base} does not exist. Run \`claude\` once first`);
  const dir = profileDir(L, name);
  const fresh = !existsSync(dir);
  mkdirSync(dir, { recursive: true });
  console.log(`${c.bold(fresh ? "Creating" : "Updating")} profile ${c.bold(name)} at ${dir}`);

  let conflicts = 0;
  for (const item of sharedItems(L.base)) {
    const r = link(L.base, dir, item.name, f.bools.has("--force"));
    if (r === "linked") ok(`${item.name} → shared`);
    else if (r === "ok") console.log(`${c.dim("·")} ${item.name} ${c.dim("already shared")}`);
    else if (r === "wrong-target") {
      warn(`${item.name} is a symlink to somewhere else (re-run with --force to relink)`);
      conflicts++;
    } else {
      warn(`${item.name} is a real file or dir inside the profile. Left alone; move it away to share it`);
      conflicts++;
    }
  }

  const seeded = await seedGlobalJson(L.baseGlobalJson, dir, f.bools.has("--copy-mcp"));
  if (seeded === "seeded")
    ok(`.claude.json seeded${f.bools.has("--copy-mcp") ? " (with user-scope MCP servers)" : ""}`);
  else if (seeded === "exists") console.log(`${c.dim("·")} .claude.json ${c.dim("already present")}`);
  else warn(`could not read ${L.baseGlobalJson}; Claude Code will run its first-time onboarding`);

  const alias = f.strs.get("--alias");
  if (alias !== undefined) writeAlias(name, alias);

  if (conflicts) warn(`${conflicts} item(s) need attention, see above`);

  if (f.bools.has("--no-login")) {
    console.log(`\nNext: ${c.bold(`claudep ${name} auth login`)}`);
    return;
  }
  const loginArgs = ["auth", "login"];
  if (f.bools.has("--sso")) loginArgs.push("--sso");
  if (f.bools.has("--console")) loginArgs.push("--console");
  const email = f.strs.get("--email");
  if (email !== undefined) loginArgs.push("--email", email);
  console.log(`\n${c.bold("Logging in")} to profile ${name} …`);
  await execClaude(L, dir, loginArgs);
}

function scriptDir(): string {
  return dirname(realpathSync(Bun.main));
}

/** Directory where alias shims are written: next to the `claudep` command on
 *  PATH (usually a symlink into the repo), falling back to the script dir. */
export function aliasDir(): string {
  const onPathBin = Bun.which("claudep");
  return onPathBin ? dirname(onPathBin) : scriptDir();
}

/** True when some PATH entry resolves (through symlinks) to `dir`. */
export function onPath(dir: string, pathVar: string = process.env.PATH ?? ""): boolean {
  const want = realpathSync(dir);
  return pathVar.split(":").some((p) => {
    try {
      return realpathSync(canon(p)) === want;
    } catch {
      return false;
    }
  });
}

/** Write a tiny shim `<cmd>` next to the claudep on PATH: `exec claudep run <name> -- "$@"`. */
function writeAlias(name: string, cmd: string): void {
  if (!NAME_RE.test(cmd)) die(`invalid alias command name "${cmd}"`);
  const dest = join(aliasDir(), cmd);
  const self = realpathSync(Bun.main);
  if (existsSync(dest)) {
    const current = Bun.file(dest);
    if (!lstatSync(dest).isSymbolicLink() && current.size > 0) {
      warn(`${dest} already exists. Not overwriting; remove it first to regenerate`);
      return;
    }
  }
  const shim = `#!/bin/sh\n# generated by claudep. Runs Claude Code under the "${name}" profile\nexec bun "${self}" run ${name} -- "$@"\n`;
  writeFileSync(dest, shim);
  chmodSync(dest, 0o755);
  ok(`alias ${c.bold(cmd)} → profile ${name} (${dest})`);
  if (!onPath(aliasDir())) warn(`${aliasDir()} is not on your PATH`);
}

async function cmdAlias(L: Layout, args: string[]): Promise<void> {
  const [name, cmd] = args;
  if (!name || !cmd) die("usage: claudep alias <profile> <command>   e.g. claudep alias enterprise eclaude");
  if (!profileExists(L, name)) die(`profile "${name}" does not exist. Run: claudep init ${name}`);
  writeAlias(name, cmd);
}

async function cmdRun(L: Layout, args: string[]): Promise<never> {
  const name = args[0];
  if (!name) die("usage: claudep run <name> [claude args…]");
  const rest = args.slice(1);
  if (rest[0] === "--") rest.shift();
  if (name === "default" || name === "base") return execClaude(L, undefined, rest);
  const dir = profileDir(L, name);
  if (!existsSync(dir)) die(`profile "${name}" does not exist. Run: claudep init ${name}`);
  return execClaude(L, dir, rest);
}

export type Row = { name: string; dir: string; status: AuthStatus };

async function collectRows(L: Layout, names: string[]): Promise<Row[]> {
  return Promise.all(
    names.map(async (name) => {
      const dir = name === "default" ? L.base : profileDir(L, name);
      return { name, dir, status: await authStatus(L, name === "default" ? undefined : dir) };
    }),
  );
}

export function formatTable(rows: Row[], home: string): string[] {
  const cols = ["PROFILE", "LOGIN", "EMAIL", "ORG", "PLAN", "DIR"];
  const data = rows.map((r) => [
    r.name,
    r.status.loggedIn ? "yes" : "no",
    r.status.email ?? "-",
    r.status.orgName ?? "-",
    r.status.subscriptionType ?? "-",
    r.dir.startsWith(home) ? `~${r.dir.slice(home.length)}` : r.dir,
  ]);
  const widths = cols.map((h, i) => Math.max(h.length, ...data.map((d) => (d[i] as string).length)));
  const fmt = (cells: string[]) => cells.map((v, i) => v.padEnd(widths[i] as number)).join("  ");
  return [fmt(cols), ...data.map((d) => fmt(d))];
}

function printTable(rows: Row[], home: string): void {
  const [header, ...lines] = formatTable(rows, home);
  console.log(c.bold(header as string));
  lines.forEach((line, i) => {
    console.log(rows[i]?.status.loggedIn ? line : c.dim(line));
  });
}

async function cmdList(L: Layout): Promise<void> {
  const names = ["default", ...listProfileNames(L)];
  printTable(await collectRows(L, names), L.home);
  if (names.length === 1) console.log(c.dim("\nNo profiles yet. Create one: claudep init <name>"));
  const cur = currentProfile(L);
  if (cur.kind !== "base") console.log(c.dim(`\nactive in this shell: ${describeCurrent(cur)}`));
}

async function cmdStatus(L: Layout, args: string[]): Promise<void> {
  const f = parseFlags(args, ["--json"], []);
  const name = f.rest[0];
  if (!name) die("usage: claudep status <name> [--json]");
  if (name !== "default" && !profileExists(L, name)) die(`profile "${name}" does not exist`);
  const [row] = await collectRows(L, [name]);
  if (!row) return;
  if (f.bools.has("--json")) console.log(JSON.stringify({ name: row.name, dir: row.dir, ...row.status }, null, 2));
  else printTable([row], L.home);
}

function cmdEnv(L: Layout, args: string[]): void {
  const name = args[0];
  if (!name) die('usage: eval "$(claudep env <name>)"   or   eval "$(claudep env --unset)"');
  if (name === "--unset") {
    console.log("unset CLAUDE_CONFIG_DIR CLAUDEP_AUTO");
    return;
  }
  const dir = profileDir(L, name);
  if (!existsSync(dir)) die(`profile "${name}" does not exist`);
  // Clearing CLAUDEP_AUTO turns this into a manual pin the shell hook will not touch.
  console.log(`export CLAUDE_CONFIG_DIR='${dir.replace(/'/g, `'\\''`)}'`);
  console.log("unset CLAUDEP_AUTO");
}

function describeCurrent(cur: Current): string {
  const label = cur.kind === "profile" ? (cur.name ?? "?") : cur.kind === "custom" ? "custom" : "default";
  const how = cur.setBy === "hook" ? "shell hook" : cur.setBy === "manual" ? "manual pin" : "nothing pinned";
  return `${label} (${how})`;
}

function shortHome(p: string, home: string): string {
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function cmdCurrent(L: Layout, args: string[]): void {
  const f = parseFlags(args, ["--json"], []);
  const cur = currentProfile(L);
  const pin = resolvePin(process.cwd());
  if (f.bools.has("--json")) {
    console.log(JSON.stringify({ ...cur, pin: pin ?? null }, null, 2));
    return;
  }
  const label = cur.kind === "profile" ? (cur.name ?? "?") : cur.kind === "custom" ? "custom" : "default";
  console.log(`${c.bold(label)}  ${c.dim(shortHome(cur.dir, L.home))}`);
  if (cur.setBy === "hook")
    console.log(`set by: shell hook${pin ? ` (${PIN_FILE} in ${shortHome(pin.dir, L.home)})` : ""}`);
  else if (cur.setBy === "manual") console.log("set by: manual pin (claudep env or export CLAUDE_CONFIG_DIR)");
  else console.log("set by: nothing pinned; this is ~/.claude");
  if (cur.kind === "custom") console.log(c.dim("CLAUDE_CONFIG_DIR points outside the claudep profiles root"));
  if (pin && pin.name !== "" && pin.name !== cur.name) {
    console.log(
      c.yellow(
        `pinned here: ${pin.name} (${shortHome(pin.file, L.home)}), but this shell is on ${label}. Load the hook: eval "$(claudep shell-init zsh)"`,
      ),
    );
  }
}

function cmdResolve(L: Layout, args: string[]): void {
  const f = parseFlags(args, ["--json"], []);
  const start = f.rest[0] ?? process.cwd();
  const pin = resolvePin(start);
  if (!pin || pin.name === "") process.exit(1);
  if (!NAME_RE.test(pin.name)) die(`${pin.file} names an invalid profile "${pin.name}"`);
  if (f.bools.has("--json"))
    console.log(JSON.stringify({ ...pin, dir: pin.dir, profileDir: join(L.profilesRoot, pin.name) }, null, 2));
  else console.log(pin.name);
}

function cmdLocal(L: Layout, args: string[]): void {
  const f = parseFlags(args, ["--remove", "--force"], []);
  const file = join(process.cwd(), PIN_FILE);
  if (f.bools.has("--remove")) {
    if (!existsSync(file)) die(`no ${PIN_FILE} in ${process.cwd()}`);
    rmSync(file);
    ok(`removed ${file}`);
    return;
  }
  const name = f.rest[0];
  if (!name) {
    const pin = resolvePin(process.cwd());
    if (!pin || pin.name === "") {
      console.log(`no ${PIN_FILE} pin from ${shortHome(process.cwd(), L.home)} upward`);
      process.exit(1);
    }
    console.log(`${pin.name}  ${c.dim(shortHome(pin.file, L.home))}`);
    return;
  }
  if (!NAME_RE.test(name)) die(`invalid profile name "${name}"`);
  if (!f.bools.has("--force") && !profileExists(L, name))
    die(`profile "${name}" does not exist. Run: claudep init ${name}   (or pass --force to pin it anyway)`);
  writeFileSync(file, `${name}\n`);
  ok(`${shortHome(file, L.home)} pins this directory tree to ${c.bold(name)}`);
  if (!process.env.CLAUDEP_AUTO && !process.env.CLAUDE_CONFIG_DIR)
    console.log(c.dim(`Shells load pins through the hook: eval "$(claudep shell-init zsh)"`));
}

/** The shell hook. Pure parameter expansion and builtins: it runs on every
 *  directory change (zsh chpwd) or prompt (bash PROMPT_COMMAND), so no
 *  subprocess is allowed here. Logic mirrors resolvePin(). */
export function shellInit(shell: "zsh" | "bash", profilesRoot: string): string {
  const q = profilesRoot.replace(/'/g, `'\\''`);
  const core = `# claudep shell hook. Load it from your rc file:  eval "$(claudep shell-init ${shell})"
_claudep_root='${q}'
_claudep_auto() {
  [ "$PWD" = "\${_claudep_last_pwd:-}" ] && return 0
  _claudep_last_pwd="$PWD"
  # Only manage a CLAUDE_CONFIG_DIR this hook set itself. A manual pin wins.
  if [ -n "\${CLAUDE_CONFIG_DIR:-}" ] && [ "$CLAUDE_CONFIG_DIR" != "\${CLAUDEP_AUTO:-}" ]; then return 0; fi
  _claudep_dir="$PWD"
  _claudep_name=""
  _claudep_found=""
  while :; do
    if [ -f "\${_claudep_dir%/}/${PIN_FILE}" ]; then
      _claudep_found="\${_claudep_dir:-/}"
      while read -r _claudep_line || [ -n "$_claudep_line" ]; do
        case "$_claudep_line" in "" | "#"*) continue ;; esac
        _claudep_name="$_claudep_line"
        break
      done < "\${_claudep_dir%/}/${PIN_FILE}"
      break
    fi
    if [ -z "$_claudep_dir" ] || [ "$_claudep_dir" = "/" ]; then break; fi
    _claudep_dir="\${_claudep_dir%/*}"
  done
  if [ -z "$_claudep_name" ]; then
    # No pin here: hand the shell back to the base account.
    [ -n "\${CLAUDEP_AUTO:-}" ] && unset CLAUDE_CONFIG_DIR CLAUDEP_AUTO
    return 0
  fi
  if [ ! -d "$_claudep_root/$_claudep_name" ]; then
    [ -n "\${CLAUDEP_AUTO:-}" ] && unset CLAUDE_CONFIG_DIR CLAUDEP_AUTO
    printf 'claudep: %s/${PIN_FILE} names profile "%s", which does not exist. Run: claudep init %s\\n' "$_claudep_found" "$_claudep_name" "$_claudep_name" >&2
    return 0
  fi
  export CLAUDE_CONFIG_DIR="$_claudep_root/$_claudep_name" CLAUDEP_AUTO="$_claudep_root/$_claudep_name"
}
`;
  const tail =
    shell === "zsh"
      ? `autoload -Uz add-zsh-hook
add-zsh-hook chpwd _claudep_auto
_claudep_auto
`
      : `case ";\${PROMPT_COMMAND:-};" in *";_claudep_auto;"*) ;; *) PROMPT_COMMAND="_claudep_auto\${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;; esac
_claudep_auto
`;
  return core + tail;
}

function cmdShellInit(L: Layout, args: string[]): void {
  const shell = args[0] ?? "zsh";
  if (shell !== "zsh" && shell !== "bash") die(`unsupported shell "${shell}". Use zsh or bash`);
  process.stdout.write(shellInit(shell, L.profilesRoot));
}

async function cmdDoctor(L: Layout, args: string[]): Promise<void> {
  const names = args[0] ? [args[0]] : listProfileNames(L);
  const bin = Bun.which("claude");
  if (bin) {
    const { out } = await captureClaude(L, undefined, ["--version"]);
    ok(`claude: ${bin} (${out.trim() || "version unknown"})`);
  } else bad("claude binary not found on PATH");
  ok(`base: ${L.base}${L.callerConfigDir && !L.managed ? c.yellow("  (from CLAUDE_CONFIG_DIR in your shell)") : ""}`);
  ok(`profiles root: ${L.profilesRoot}`);

  const shared = sharedItems(L.base);
  const sharedNames = new Set(shared.map((s) => s.name));
  const unclassified = existsSync(L.base)
    ? readdirSync(L.base)
        .filter((n) => !sharedNames.has(n) && !KNOWN_PRIVATE.has(n) && !n.endsWith(".md"))
        .sort()
    : [];
  if (unclassified.length) {
    warn(`base items neither shared nor known-private (they stay per-profile): ${unclassified.join(", ")}`);
  }

  let problems = 0;
  for (const name of names) {
    const dir = profileDir(L, name);
    console.log(`\n${c.bold(name)}  ${c.dim(dir)}`);
    if (!existsSync(dir)) {
      bad("profile dir missing");
      problems++;
      continue;
    }
    for (const item of shared) {
      const dest = join(dir, item.name);
      let st: ReturnType<typeof lstatSync> | undefined;
      try {
        st = lstatSync(dest);
      } catch {
        st = undefined;
      }
      if (!st) {
        warn(`${item.name}: not linked (run: claudep init ${name})`);
        problems++;
      } else if (!st.isSymbolicLink()) {
        warn(`${item.name}: real ${item.kind} shadows the shared one`);
        problems++;
      } else if (readlinkSync(dest) !== join(L.base, item.name)) {
        bad(`${item.name}: symlink points elsewhere (${readlinkSync(dest)})`);
        problems++;
      } else if (!existsSync(dest)) {
        bad(`${item.name}: broken symlink`);
        problems++;
      }
    }
    ok(`${shared.length} shared item(s) checked`);
    const strays = readdirSync(dir).filter((n) => !sharedNames.has(n) && !KNOWN_PRIVATE.has(n) && !n.endsWith(".md"));
    if (strays.length) warn(`unexpected private items: ${strays.join(", ")}`);
    const svc = keychainService(dir);
    const has = await keychainHas(svc);
    if (has === undefined) console.log(`${c.dim("·")} keychain check skipped (not macOS)`);
    else if (has) ok(`keychain item "${svc}" present`);
    else warn(`no keychain item "${svc}". Not logged in yet (claudep ${name} auth login)`);
    const s = await authStatus(L, dir);
    if (s.loggedIn) ok(`logged in as ${s.email ?? "?"} (${s.orgName ?? "?"}, ${s.subscriptionType ?? "?"})`);
    else warn("not logged in");
  }
  if (!names.length) console.log(c.dim("\nNo profiles to check."));
  if (problems) {
    console.log(`\n${c.red(`${problems} problem(s)`)}`);
    process.exit(1);
  }
}

async function cmdRm(L: Layout, args: string[]): Promise<void> {
  const f = parseFlags(args, ["--keep-login", "--yes"], []);
  const name = f.rest[0];
  if (!name) die("usage: claudep rm <name> [--keep-login] [--yes]");
  const dir = profileDir(L, name);
  if (!existsSync(dir)) die(`profile "${name}" does not exist`);
  const real = realpathSync(dir);
  if (!real.startsWith(`${realpathSync(L.profilesRoot)}/`) || real === realpathSync(L.base) || real === L.home)
    die(`refusing to remove ${real}: not inside ${L.profilesRoot}`);
  if (!f.bools.has("--yes")) {
    const yes = confirm(`Remove profile "${name}" (${dir})? Shared items are only unlinked; ${L.base} is untouched.`);
    if (!yes) {
      console.log("aborted");
      return;
    }
  }
  if (!f.bools.has("--keep-login")) {
    const proc = Bun.spawn([claudeBin(), "auth", "logout"], {
      env: envFor(dir),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await proc.exited) === 0) ok("logged out (token revoked, keychain item removed)");
    else warn("logout failed or was not logged in. Continuing");
  }
  rmSync(dir, { recursive: true, force: true });
  ok(`removed ${dir}`);
  const shims = aliasDir();
  for (const entry of readdirSync(shims)) {
    const p = join(shims, entry);
    try {
      if (!lstatSync(p).isFile()) continue;
      const txt = await Bun.file(p).text();
      if (txt.includes("generated by claudep") && txt.includes(` run ${name} -- `))
        warn(`alias shim ${p} still points at this profile. Remove it if unused`);
    } catch {
      /* ignore unreadable entries */
    }
  }
}

function help(L: Layout): void {
  const root = L.profilesRoot.startsWith(L.home) ? `~${L.profilesRoot.slice(L.home.length)}` : L.profilesRoot;
  console.log(`${c.bold("claudep")} ${c.dim(version())}: run Claude Code under separate accounts on one machine

${c.bold("USAGE")}
  claudep <name> [claude args…]        run claude with profile <name>  (alias for "run")
  claudep init <name> [options]        create/update a profile and log in
  claudep list                         show every profile and who it is logged in as
  claudep status <name> [--json]       login state for one profile ("default" = ~/.claude)
  claudep current [--json]             which profile this shell is on, and why
  claudep env <name> | --unset         print "export CLAUDE_CONFIG_DIR=…" (or the unset) for eval
  claudep alias <name> <command>       write a shim so "<command>" == "claudep <name>"
  claudep doctor [name]                verify symlinks, keychain entry, unclassified files
  claudep rm <name> [--keep-login]     log out and delete a profile (base is never touched)
  claudep --version                    print the version

${c.bold("DIRECTORY PINS")}
  claudep local <name> [--force]       write ./${PIN_FILE} so this tree uses <name>; --remove deletes it
  claudep local                        show the pin that applies to the current directory
  claudep resolve [dir] [--json]       print the profile pinned for a directory (exit 1 when none)
  claudep shell-init [zsh|bash]        print the hook that applies pins on cd; eval it in your rc file

${c.bold("INIT OPTIONS")}
  --sso               force the SSO login flow (Enterprise orgs)
  --email <addr>      pre-fill the login page
  --console           log in with an Anthropic Console (API billing) account instead of a subscription
  --copy-mcp          copy user-scope MCP servers from the base .claude.json
  --alias <command>   also create a shim command, e.g. --alias eclaude
  --no-login          set up files only; log in later with: claudep <name> auth login
  --force             relink shared items whose symlinks point elsewhere

${c.bold("EXAMPLES")}
  claudep init enterprise --sso --email you@company.com --alias eclaude
  eclaude                                       # Claude Code as the enterprise account
  claude                                        # Claude Code as whatever ~/.claude is logged in as
  claudep enterprise -p "summarize this repo"
  eval "$(claudep env enterprise)"              # pin the whole shell to a profile
  claudep local enterprise                      # pin this repo; commit the ${PIN_FILE} file for the team
  eval "$(claudep shell-init zsh)"              # in .zshrc: shells follow ${PIN_FILE} pins on cd

${c.bold("HOW IT WORKS")}
  ~/.claude stays exactly as it is and remains the "default" profile. Each named profile is a
  thin directory under ${root}/<name> that Claude Code is pointed at via
  CLAUDE_CONFIG_DIR. Inside it, shared config is a symlink back into ~/.claude:
    ${[...SHARED_FILES, "*.md", ...SHARED_DIRS].join("  ")}
  Everything account-specific is real and per profile: .claude.json (login identity, MCP
  servers, folder trust), org-pushed remote-settings.json, history, todos, caches.
  Credentials never touch the profile dir: Claude Code stores them in the macOS Keychain under
  "Claude Code-credentials-<sha256(CLAUDE_CONFIG_DIR)[0:8]>", so every profile has its own
  login and refresh token and they cannot clobber each other.

${c.bold("PIN RULES")}
  The nearest ${PIN_FILE} file upward from the current directory wins; an empty one cancels a
  parent pin. The hook only changes a CLAUDE_CONFIG_DIR it set itself (tracked in CLAUDEP_AUTO),
  so a manual pin from "claudep env" stays put. Leaving every pinned tree returns the shell to
  ~/.claude.

${c.bold("ENVIRONMENT")}
  CLAUDE_PROFILES_DIR   where profiles live (default ~/.claudep; keep it out of iCloud/Dropbox)
  CLAUDEP_AUTO          set by the hook next to CLAUDE_CONFIG_DIR; marks the pin as hook-managed
`);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<void> {
  const L = layout();
  const [cmd, ...args] = argv;
  switch (cmd) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      help(L);
      return;
    case "init":
      return cmdInit(L, args);
    case "run":
      return cmdRun(L, args);
    case "list":
    case "ls":
      return cmdList(L);
    case "status":
      return cmdStatus(L, args);
    case "env":
      return cmdEnv(L, args);
    case "current":
      return cmdCurrent(L, args);
    case "local":
      return cmdLocal(L, args);
    case "resolve":
      return cmdResolve(L, args);
    case "shell-init":
      return cmdShellInit(L, args);
    case "version":
    case "--version":
    case "-v":
      console.log(version());
      return;
    case "alias":
      return cmdAlias(L, args);
    case "doctor":
      return cmdDoctor(L, args);
    case "rm":
    case "remove":
      return cmdRm(L, args);
    default:
      if (cmd === "default" || cmd === "base" || profileExists(L, cmd)) return cmdRun(L, [cmd, ...args]);
      if (NAME_RE.test(cmd)) die(`no profile "${cmd}". Create it with: claudep init ${cmd}`);
      die(`unknown command "${cmd}". Try: claudep help`);
  }
}

if (import.meta.main) await main(Bun.argv.slice(2));
