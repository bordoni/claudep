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
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export type Env = Record<string, string | undefined>;

/** The path module for a platform. Every helper that must be exercised for
 *  win32 on a macOS or Linux host takes `platform` as a parameter and goes
 *  through this instead of the ambient `node:path`. */
export function pathApi(platform: NodeJS.Platform = process.platform): typeof posix | typeof win32 {
  return platform === "win32" ? win32 : posix;
}

/** An MSYS or Git Bash style path such as /c/Users/me. */
export function isMsysPath(p: string): boolean {
  return /^\/[a-zA-Z](\/|$)/.test(p);
}

/** win32 only: drop the \\?\ and \\?\UNC\ prefixes readlink and realpath can
 *  add, and rewrite an MSYS /c/x path to C:/x. A pure string operation; the
 *  result still goes through resolve() to pick the separator. */
export function toNativePath(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return p;
  let out = p;
  if (out.startsWith("\\\\?\\UNC\\")) out = `\\\\${out.slice(8)}`;
  else if (out.startsWith("\\\\?\\")) out = out.slice(4);
  if (isMsysPath(out)) out = `${(out[1] as string).toUpperCase()}:${out.slice(2) || "/"}`;
  return out;
}

/** Home directory. $HOME wins so tests and containers can redirect it; bun's
 *  os.homedir() reads getpwuid() and ignores the variable. On Windows
 *  USERPROFILE is the native home; Git Bash sets HOME to a POSIX-style path
 *  that claude.exe would not understand. */
export function homeDir(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return toNativePath(env.USERPROFILE || env.HOME || homedir(), platform);
  return env.HOME || homedir();
}

/** Canonical form of a config dir: absolute, no trailing separator, NFC, and
 *  on Windows an upper-case drive letter and backslashes. Claude Code hashes
 *  the *literal* CLAUDE_CONFIG_DIR string for the keychain service name and
 *  compares it literally elsewhere, so the same profile must always produce
 *  the same string. */
export function canon(p: string, home: string = homeDir(), platform: NodeJS.Platform = process.platform): string {
  const P = pathApi(platform);
  const tilde = p.startsWith("~/") || (platform === "win32" && p.startsWith("~\\"));
  const expanded = tilde ? P.join(home, p.slice(2)) : toNativePath(p, platform);
  let out = P.resolve(expanded);
  if (platform === "win32" && /^[a-z]:/.test(out)) out = `${(out[0] as string).toUpperCase()}${out.slice(1)}`;
  return out.normalize("NFC");
}

/** Comparison key for a path. Identity on POSIX, where two spellings are two
 *  directories. On Windows the file system is case-insensitive and readlink
 *  may add a \\?\ prefix or use forward slashes, so the key folds all of that. */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return p;
  return toNativePath(p, platform).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return pathKey(a, platform) === pathKey(b, platform);
}

/** True when `child` is strictly inside `parent`. Never use startsWith for
 *  this: "/r" is not a parent of "/rx", and on Windows case must not matter. */
export function isInside(parent: string, child: string, platform: NodeJS.Platform = process.platform): boolean {
  const sep = pathApi(platform).sep;
  const pk = pathKey(parent, platform);
  const prefix = pk.endsWith(sep) ? pk : `${pk}${sep}`;
  return pathKey(child, platform).startsWith(prefix);
}

/** `~` plus the tail of `p` when it lives under `home`, otherwise `p` unchanged. */
export function shortHome(p: string, home: string, platform: NodeJS.Platform = process.platform): string {
  const np = toNativePath(p, platform);
  if (samePath(np, home, platform)) return "~";
  return isInside(home, np, platform) ? `~${np.slice(home.length)}` : np;
}

/** Delete a variable from an env copy. Windows environments are
 *  case-insensitive, so every spelling of the name goes. */
export function deleteEnv(env: Env, name: string, platform: NodeJS.Platform = process.platform): void {
  if (platform !== "win32") {
    delete env[name];
    return;
  }
  const want = name.toUpperCase();
  for (const k of Object.keys(env)) if (k.toUpperCase() === want) delete env[k];
}

export type Layout = {
  platform: NodeJS.Platform;
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

export function layout(env: Env = process.env, platform: NodeJS.Platform = process.platform): Layout {
  const P = pathApi(platform);
  const home = homeDir(env, platform);
  const callerConfigDir = env.CLAUDE_CONFIG_DIR;
  const profilesRoot = canon(env.CLAUDE_PROFILES_DIR ?? P.join(home, ".claudep"), home, platform);
  const callerCanon = callerConfigDir !== undefined ? canon(callerConfigDir, home, platform) : undefined;
  const managed = callerCanon !== undefined && isInside(profilesRoot, callerCanon, platform);
  const tail = managed && callerCanon !== undefined ? callerCanon.slice(profilesRoot.length + 1) : undefined;
  const activeProfile = tail !== undefined && NAME_RE.test(tail) ? tail : undefined;
  // A custom CLAUDE_CONFIG_DIR outside the profiles root is the user's real base.
  // One inside it is a claudep profile and must never be treated as the base.
  const customBase = callerCanon !== undefined && !managed;
  const base = customBase && callerCanon !== undefined ? callerCanon : canon(P.join(home, ".claude"), home, platform);
  return {
    platform,
    home,
    callerConfigDir,
    managed,
    activeProfile,
    base,
    baseGlobalJson: customBase ? P.join(base, ".claude.json") : P.join(home, ".claude.json"),
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
  const dir = canon(cfg, L.home, L.platform);
  const auto = env.CLAUDEP_AUTO;
  const setBy = auto !== undefined && samePath(canon(auto, L.home, L.platform), dir, L.platform) ? "hook" : "manual";
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
export const SHARED_DIRS = [
  "hooks",
  "skills",
  "commands",
  "agents",
  "plugins",
  "plans",
  "projects",
  "rules",
  "output-styles",
  "themes",
  "workflows",
] as const;

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
  "Thumbs.db",
  "desktop.ini",
  ".config.json",
  ".last-cleanup",
  ".last-update-result.json",
  "daemon-auth-cooldown",
  "daemon-auth-status.json",
  "teams",
  "uploads",
  "usage-data",
  "mcp-discovery-cache",
  "mcp-skill-archives",
  "daemon.json",
  "launch.json",
  "scheduled_tasks.json",
  "seed-admin",
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
  return canon(pathApi(L.platform).join(L.profilesRoot, name), L.home, L.platform);
}

export function profileExists(L: Layout, name: string): boolean {
  return NAME_RE.test(name) && !RESERVED.has(name) && existsSync(pathApi(L.platform).join(L.profilesRoot, name));
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

/** The two file-system calls link() makes, injectable so the tests can record
 *  the symlink type and simulate Windows refusing to create one. */
export type LinkDeps = {
  platform: NodeJS.Platform;
  symlink: (target: string, dest: string, type: SharedItem["kind"]) => void;
  readlink: (p: string) => string;
};

export const defaultLinkDeps = (): LinkDeps => ({
  platform: process.platform,
  symlink: (target, dest, type) => symlinkSync(target, dest, type),
  readlink: (p) => readlinkSync(p),
});

export type LinkResult = "linked" | "ok" | "wrong-target" | "conflict" | "denied";

/** Remove a symlink. On Windows a directory symlink is removed with rmdir. */
function removeLink(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    rmdirSync(p);
  }
}

/** false when the OS refused with EPERM, which on Windows means Developer
 *  Mode is off. Anything else propagates. */
function trySymlink(deps: LinkDeps, target: string, dest: string, type: SharedItem["kind"]): boolean {
  try {
    deps.symlink(target, dest, type);
    return true;
  } catch (e) {
    if ((e as { code?: string }).code === "EPERM") return false;
    throw e;
  }
}

/** Idempotent symlink profile/<name> -> base/<name>. Never overwrites real
 *  files. The type is always passed: POSIX ignores it, Windows needs it. */
export function link(
  base: string,
  dir: string,
  item: SharedItem,
  force: boolean,
  deps: LinkDeps = defaultLinkDeps(),
): LinkResult {
  const target = join(base, item.name);
  const dest = join(dir, item.name);
  let st: ReturnType<typeof lstatSync> | undefined;
  try {
    st = lstatSync(dest);
  } catch {
    st = undefined;
  }
  if (!st) return trySymlink(deps, target, dest, item.kind) ? "linked" : "denied";
  if (st.isSymbolicLink()) {
    if (samePath(deps.readlink(dest), target, deps.platform)) return "ok";
    if (force) {
      removeLink(dest);
      return trySymlink(deps, target, dest, item.kind) ? "linked" : "denied";
    }
    return "wrong-target";
  }
  return "conflict";
}

export type LinkState = "ok" | "missing" | "shadowed" | "wrong-target" | "broken";

/** What doctor reports for one shared item. Read-only twin of link(). */
export function linkState(
  base: string,
  dir: string,
  item: SharedItem,
  deps: Pick<LinkDeps, "platform" | "readlink"> = defaultLinkDeps(),
): LinkState {
  const dest = join(dir, item.name);
  let st: ReturnType<typeof lstatSync> | undefined;
  try {
    st = lstatSync(dest);
  } catch {
    st = undefined;
  }
  if (!st) return "missing";
  if (!st.isSymbolicLink()) return "shadowed";
  if (!samePath(deps.readlink(dest), join(base, item.name), deps.platform)) return "wrong-target";
  return existsSync(dest) ? "ok" : "broken";
}

/** What to tell the user when the OS refused to create a symlink. */
export function symlinkDeniedHint(platform: NodeJS.Platform, name: string): string {
  if (platform === "win32")
    return `Windows refused to create a symlink. Turn on Developer Mode (Settings > For developers > Developer Mode), open a new terminal and run: claudep init ${name}`;
  return `the OS refused to create a symlink (EPERM). Check the permissions on the profiles root, then run: claudep init ${name}`;
}

/** True when the profile has Claude Code's file credential store. Existence
 *  only; the file is never read. This is the login check everywhere but macOS. */
export function credentialsFileHas(dir: string, exists: (p: string) => boolean = existsSync): boolean {
  return exists(join(dir, ".credentials.json"));
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

/** Variables Claude Code uses instead of the login in its config dir when
 *  they are set (always in -p mode). They make a profile's login moot. */
export const AUTH_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

/** The AUTH_ENV names that are set and non-empty. Windows environments are
 *  case-insensitive, so any spelling counts there. */
export function authEnvOverrides(env: Env = process.env, platform: NodeJS.Platform = process.platform): string[] {
  return AUTH_ENV.filter((name) => {
    if (platform !== "win32") return Boolean(env[name]);
    return Object.keys(env).some((k) => k.toUpperCase() === name && Boolean(env[k]));
  });
}

/** The oldest Claude Code whose macOS Keychain item is namespaced per config
 *  dir. Before it every config dir shared one login. */
export const MIN_CLAUDE_VERSION = "2.1.144";

export type Version = [number, number, number];

/** The first x.y.z in `claude --version` output. */
export function parseVersion(text: string): Version | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function versionBelow(a: Version, b: Version): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] as number) < (b[i] as number);
  }
  return false;
}

/** `env.CLAUDE_CONFIG_DIR` from a settings file, when present and a string.
 *  Claude Code disables features when it finds one that differs from the
 *  active dir, and under claudep it always differs for some profile. */
export async function settingsEnvConfigDir(settingsPath: string): Promise<string | undefined> {
  const settings = await readJson(settingsPath);
  const env = settings?.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return undefined;
  const value = (env as JsonObject).CLAUDE_CONFIG_DIR;
  return typeof value === "string" ? value : undefined;
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

/** How `claude` is installed. A native binary or npm's Windows shims. */
export type ClaudeLaunch = { bin: string; kind: "exe" | "cmd" | "ps1" };

export type FindDeps = {
  platform: NodeJS.Platform;
  pathVar: string;
  exists: (p: string) => boolean;
  which: (name: string) => string | null;
};

export const defaultFindDeps = (): FindDeps => ({
  platform: process.platform,
  pathVar: process.env.PATH ?? "",
  exists: existsSync,
  which: (name) => Bun.which(name),
});

/** Locate claude. POSIX asks which(). Windows walks PATH one directory at a
 *  time so the first directory wins even when a later one has claude.exe,
 *  and prefers claude.exe over the npm shims inside a directory. */
export function findClaude(deps: FindDeps = defaultFindDeps()): ClaudeLaunch | undefined {
  if (deps.platform !== "win32") {
    const bin = deps.which("claude");
    return bin ? { bin, kind: "exe" } : undefined;
  }
  const candidates: [string, ClaudeLaunch["kind"]][] = [
    ["claude.exe", "exe"],
    ["claude.cmd", "cmd"],
    ["claude.bat", "cmd"],
    ["claude.ps1", "ps1"],
  ];
  for (const dir of splitPathVar(deps.pathVar, "win32")) {
    for (const [file, kind] of candidates) {
      const bin = win32.join(dir, file);
      if (deps.exists(bin)) return { bin, kind };
    }
  }
  return undefined;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** The command word for `cmd.exe /d /s /c "..."`, the way cross-spawn does
 *  it: caret-escape cmd's metacharacters, spaces included, and no quotes. */
export function cmdExeCommand(cmd: string): string {
  return cmd.replace(CMD_META, "^$1");
}

/** One argument for the same line: double backslashes before quotes, escape
 *  quotes, wrap in quotes, then caret-escape every metacharacter. Twice when
 *  the target is a .cmd shim, because its own cmd.exe parses `%*` again. */
export function cmdExeQuote(arg: string, doubleEscape = true): string {
  let out = arg.replace(/(?=(\\+?)?)"/g, '$1$1\\"');
  out = out.replace(/(\\+)$/, "$1$1");
  out = `"${out}"`.replace(CMD_META, "^$1");
  if (doubleEscape) out = out.replace(CMD_META, "^$1");
  return out;
}

/** argv and spawn option for a launch. A .cmd shim cannot be executed
 *  directly; it runs through cmd.exe with one pre-quoted command line. */
export function claudeSpawn(launch: ClaudeLaunch, args: string[]): { cmd: string[]; verbatim: boolean } {
  if (launch.kind !== "cmd") return { cmd: [launch.bin, ...args], verbatim: false };
  const line = [cmdExeCommand(launch.bin), ...args.map((a) => cmdExeQuote(a))].join(" ");
  return { cmd: ["cmd.exe", "/d", "/s", "/c", `"${line}"`], verbatim: true };
}

/** Signals the wrapper ignores (so it survives to report the child's exit
 *  code; the terminal delivers Ctrl+C to the child itself) and forwards.
 *  Windows has no SIGHUP. */
export function wrapperSignals(platform: NodeJS.Platform): { ignore: NodeJS.Signals[]; forward: NodeJS.Signals[] } {
  if (platform === "win32") return { ignore: ["SIGINT"], forward: ["SIGTERM"] };
  return { ignore: ["SIGINT"], forward: ["SIGTERM", "SIGHUP"] };
}

function claudeLaunch(): ClaudeLaunch {
  const launch = findClaude();
  if (!launch) die("`claude` not found on PATH. Install Claude Code first: https://code.claude.com/docs/en/setup");
  if (launch.kind === "ps1")
    die(
      `only ${launch.bin} was found. Install Claude Code with the native installer or npm so claude.exe or claude.cmd exists: https://code.claude.com/docs/en/setup`,
    );
  return launch;
}

function spawnClaude(L: Layout, dir: string | undefined, args: string[], io: "inherit" | "pipe") {
  const { cmd, verbatim } = claudeSpawn(claudeLaunch(), args);
  return Bun.spawn(cmd, {
    env: claudeEnv(L, dir),
    stdin: io === "inherit" ? "inherit" : "ignore",
    stdout: io,
    stderr: io,
    windowsVerbatimArguments: verbatim,
  });
}

/** Environment for a profile. `undefined` dir means "the base", i.e. leave the
 *  caller's CLAUDE_CONFIG_DIR exactly as it is (set or unset). */
export function envFor(
  dir: string | undefined,
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): Env {
  const out: Env = { ...env };
  if (dir !== undefined) {
    deleteEnv(out, "CLAUDE_CONFIG_DIR", platform);
    out.CLAUDE_CONFIG_DIR = dir;
  }
  return out;
}

/** Environment for running claude against the base. If a claudep profile is
 *  active in this shell (hook or manual pin), strip it so "default" really is
 *  the base and not whatever the current directory pinned. */
export function baseEnv(L: Layout, env: Env = process.env): Env {
  const out: Env = { ...env };
  if (L.managed) {
    deleteEnv(out, "CLAUDE_CONFIG_DIR", L.platform);
    deleteEnv(out, "CLAUDEP_AUTO", L.platform);
  }
  return out;
}

function claudeEnv(L: Layout, dir: string | undefined): Env {
  return dir === undefined ? baseEnv(L) : envFor(dir, process.env, L.platform);
}

async function execClaude(L: Layout, dir: string | undefined, args: string[]): Promise<never> {
  const proc = spawnClaude(L, dir, args, "inherit");
  // Ctrl+C reaches the child through the terminal; keep the wrapper alive so
  // it can report the child's real exit code.
  const signals = wrapperSignals(L.platform);
  for (const s of signals.ignore) process.on(s, () => {});
  for (const s of signals.forward) process.on(s, () => proc.kill(s));
  await proc.exited;
  process.exit(proc.exitCode ?? 1);
}

async function captureClaude(
  L: Layout,
  dir: string | undefined,
  args: string[],
): Promise<{ code: number; out: string }> {
  const proc = spawnClaude(L, dir, args, "pipe");
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
    const r = link(L.base, dir, item, f.bools.has("--force"));
    if (r === "linked") ok(`${item.name} → shared`);
    else if (r === "ok") console.log(`${c.dim("·")} ${item.name} ${c.dim("already shared")}`);
    else if (r === "denied") die(symlinkDeniedHint(L.platform, name));
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
  if (alias !== undefined) writeAlias(L, name, alias);

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

/** PATH entries. `:` on POSIX, `;` on Windows, where `:` would split every
 *  entry at its drive letter. */
export function splitPathVar(pathVar: string, platform: NodeJS.Platform = process.platform): string[] {
  return pathVar.split(pathApi(platform).delimiter).filter((p) => p !== "");
}

/** True when some PATH entry resolves (through symlinks) to `dir`. */
export function onPath(
  dir: string,
  pathVar: string = process.env.PATH ?? "",
  platform: NodeJS.Platform = process.platform,
): boolean {
  const want = realpathSync(dir);
  return splitPathVar(pathVar, platform).some((p) => {
    try {
      return samePath(realpathSync(canon(p, undefined, platform)), want, platform);
    } catch {
      return false;
    }
  });
}

export type AliasKind = "sh" | "cmd";

/** The shim text. Both say "generated by claudep" and ` run <name> -- ` so
 *  `claudep rm` can find them. */
export function aliasShim(kind: AliasKind, self: string, name: string): string {
  if (kind === "cmd")
    return `@echo off\r\nREM generated by claudep. Runs Claude Code under the "${name}" profile\r\nbun "${self}" run ${name} -- %*\r\n`;
  return `#!/bin/sh\n# generated by claudep. Runs Claude Code under the "${name}" profile\nexec bun "${self}" run ${name} -- "$@"\n`;
}

/** Where the shims for `<cmd>` go. One sh file on POSIX. On Windows a .cmd
 *  file, which PowerShell finds through PATHEXT, plus the sh file for Git Bash. */
export function aliasFiles(
  dir: string,
  cmd: string,
  platform: NodeJS.Platform = process.platform,
): { path: string; kind: AliasKind }[] {
  const P = pathApi(platform);
  const sh = { path: P.join(dir, cmd), kind: "sh" as const };
  if (platform !== "win32") return [sh];
  return [{ path: P.join(dir, `${cmd}.cmd`), kind: "cmd" as const }, sh];
}

/** Write the shim(s) for `<cmd>` next to the claudep on PATH: `claudep run <name> -- "$@"`. */
function writeAlias(L: Layout, name: string, cmd: string): void {
  if (!NAME_RE.test(cmd)) die(`invalid alias command name "${cmd}"`);
  const self = realpathSync(Bun.main);
  for (const { path: dest, kind } of aliasFiles(aliasDir(), cmd, L.platform)) {
    if (existsSync(dest)) {
      const current = Bun.file(dest);
      if (!lstatSync(dest).isSymbolicLink() && current.size > 0) {
        warn(`${dest} already exists. Not overwriting; remove it first to regenerate`);
        continue;
      }
    }
    writeFileSync(dest, aliasShim(kind, self, name));
    if (kind === "sh") chmodSync(dest, 0o755);
    ok(`alias ${c.bold(cmd)} → profile ${name} (${dest})`);
  }
  if (!onPath(aliasDir(), undefined, L.platform)) warn(`${aliasDir()} is not on your PATH`);
}

async function cmdAlias(L: Layout, args: string[]): Promise<void> {
  const [name, cmd] = args;
  if (!name || !cmd) die("usage: claudep alias <profile> <command>   e.g. claudep alias enterprise eclaude");
  if (!profileExists(L, name)) die(`profile "${name}" does not exist. Run: claudep init ${name}`);
  writeAlias(L, name, cmd);
}

async function cmdRun(L: Layout, args: string[]): Promise<never> {
  const name = args[0];
  if (!name) die("usage: claudep run <name> [claude args…]");
  const rest = args.slice(1);
  if (rest[0] === "--") rest.shift();
  if (name === "default" || name === "base") return execClaude(L, undefined, rest);
  const dir = profileDir(L, name);
  if (!existsSync(dir)) die(`profile "${name}" does not exist. Run: claudep init ${name}`);
  for (const v of authEnvOverrides(process.env, L.platform))
    console.error(`claudep: ${v} is set; Claude Code will use it instead of the "${name}" login`);
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

export function formatTable(rows: Row[], home: string, platform: NodeJS.Platform = process.platform): string[] {
  const cols = ["PROFILE", "LOGIN", "EMAIL", "ORG", "PLAN", "DIR"];
  const data = rows.map((r) => [
    r.name,
    r.status.loggedIn ? "yes" : "no",
    r.status.email ?? "-",
    r.status.orgName ?? "-",
    r.status.subscriptionType ?? "-",
    shortHome(r.dir, home, platform),
  ]);
  const widths = cols.map((h, i) => Math.max(h.length, ...data.map((d) => (d[i] as string).length)));
  const fmt = (cells: string[]) => cells.map((v, i) => v.padEnd(widths[i] as number)).join("  ");
  return [fmt(cols), ...data.map((d) => fmt(d))];
}

function printTable(rows: Row[], home: string, platform: NodeJS.Platform): void {
  const [header, ...lines] = formatTable(rows, home, platform);
  console.log(c.bold(header as string));
  lines.forEach((line, i) => {
    console.log(rows[i]?.status.loggedIn ? line : c.dim(line));
  });
}

/** The flat object `status --json` prints for one row; `list --json` prints an array of them. */
function rowJson(row: Row): JsonObject {
  return { name: row.name, dir: row.dir, ...row.status };
}

async function cmdList(L: Layout, args: string[]): Promise<void> {
  const f = parseFlags(args, ["--json"], []);
  const names = ["default", ...listProfileNames(L)];
  const rows = await collectRows(L, names);
  if (f.bools.has("--json")) {
    console.log(JSON.stringify(rows.map(rowJson), null, 2));
    return;
  }
  printTable(rows, L.home, L.platform);
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
  if (f.bools.has("--json")) console.log(JSON.stringify(rowJson(row), null, 2));
  else printTable([row], L.home, L.platform);
}

function cmdEnv(L: Layout, args: string[]): void {
  const name = args[0];
  const syntax = shellSyntax(process.env, L.platform);
  if (!name)
    die(
      syntax === "powershell"
        ? "usage: claudep env <name> | Invoke-Expression   or   claudep env --unset | Invoke-Expression"
        : 'usage: eval "$(claudep env <name>)"   or   eval "$(claudep env --unset)"',
    );
  if (name === "--unset") {
    process.stdout.write(envScript(undefined, syntax));
    return;
  }
  const dir = profileDir(L, name);
  if (!existsSync(dir)) die(`profile "${name}" does not exist`);
  process.stdout.write(envScript(dir, syntax));
}

function describeCurrent(cur: Current): string {
  const label = currentLabel(cur);
  const how = cur.setBy === "hook" ? "shell hook" : cur.setBy === "manual" ? "manual pin" : "nothing pinned";
  return `${label} (${how})`;
}

/** The one-word answer: the profile name, `default` for the base, `custom` otherwise. */
export function currentLabel(cur: Current): string {
  return cur.kind === "profile" ? (cur.name ?? "?") : cur.kind === "custom" ? "custom" : "default";
}

function cmdCurrent(L: Layout, args: string[]): void {
  const f = parseFlags(args, ["--json", "--name"], []);
  const cur = currentProfile(L);
  const label = currentLabel(cur);
  if (f.bools.has("--name")) {
    console.log(label);
    return;
  }
  const pin = resolvePin(process.cwd());
  if (f.bools.has("--json")) {
    console.log(JSON.stringify({ ...cur, pin: pin ?? null }, null, 2));
    return;
  }
  console.log(`${c.bold(label)}  ${c.dim(shortHome(cur.dir, L.home, L.platform))}`);
  if (cur.setBy === "hook")
    console.log(`set by: shell hook${pin ? ` (${PIN_FILE} in ${shortHome(pin.dir, L.home, L.platform)})` : ""}`);
  else if (cur.setBy === "manual") console.log("set by: manual pin (claudep env or export CLAUDE_CONFIG_DIR)");
  else console.log("set by: nothing pinned; this is ~/.claude");
  if (cur.kind === "custom") console.log(c.dim("CLAUDE_CONFIG_DIR points outside the claudep profiles root"));
  const msysWarning = msysConfigDirWarning(L);
  if (msysWarning) console.log(c.yellow(msysWarning));
  if (pin && pin.name !== "" && pin.name !== cur.name) {
    console.log(
      c.yellow(
        `pinned here: ${pin.name} (${shortHome(pin.file, L.home, L.platform)}), but this shell is on ${label}. Load the hook: ${hookHint(defaultShell(process.env, L.platform))}`,
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
      console.log(`no ${PIN_FILE} pin from ${shortHome(process.cwd(), L.home, L.platform)} upward`);
      process.exit(1);
    }
    console.log(`${pin.name}  ${c.dim(shortHome(pin.file, L.home, L.platform))}`);
    return;
  }
  if (!NAME_RE.test(name)) die(`invalid profile name "${name}"`);
  if (!f.bools.has("--force") && !profileExists(L, name))
    die(`profile "${name}" does not exist. Run: claudep init ${name}   (or pass --force to pin it anyway)`);
  writeFileSync(file, `${name}\n`);
  ok(`${shortHome(file, L.home, L.platform)} pins this directory tree to ${c.bold(name)}`);
  if (!process.env.CLAUDEP_AUTO && !process.env.CLAUDE_CONFIG_DIR)
    console.log(c.dim(`Shells load pins through the hook: ${hookHint(defaultShell(process.env, L.platform))}`));
}

/** The shell hook. Pure parameter expansion and builtins: it runs on every
 *  directory change (zsh chpwd) or prompt (bash PROMPT_COMMAND), so no
 *  subprocess is allowed here. Logic mirrors resolvePin(). */
export type Shell = "zsh" | "bash" | "powershell";
export const SHELLS: readonly Shell[] = ["zsh", "bash", "powershell"];

/** The shell to name in hints and to default `shell-init` to. */
export function defaultShell(env: Env = process.env, platform: NodeJS.Platform = process.platform): Shell {
  if (platform === "win32") return env.MSYSTEM ? "bash" : "powershell";
  const name = env.SHELL ? posix.basename(env.SHELL) : "";
  if (name === "zsh" || name === "bash") return name;
  return platform === "darwin" ? "zsh" : "bash";
}

/** The one line that loads the hook in a shell's rc file. */
export function hookHint(shell: Shell): string {
  if (shell === "powershell") return "claudep shell-init powershell | Out-String | Invoke-Expression";
  return `eval "$(claudep shell-init ${shell})"`;
}

export type EnvSyntax = "sh" | "powershell";

/** What `claudep env` prints. PowerShell syntax only on Windows outside Git Bash. */
export function shellSyntax(env: Env = process.env, platform: NodeJS.Platform = process.platform): EnvSyntax {
  return platform === "win32" && !env.MSYSTEM ? "powershell" : "sh";
}

/** The `claudep env` script: pin the shell to `dir`, or clear the pin. */
export function envScript(dir: string | undefined, syntax: EnvSyntax): string {
  if (syntax === "powershell") {
    if (dir === undefined) return "Remove-Item Env:CLAUDE_CONFIG_DIR, Env:CLAUDEP_AUTO -ErrorAction SilentlyContinue\n";
    // Clearing CLAUDEP_AUTO turns this into a manual pin the shell hook will not touch.
    return `$env:CLAUDE_CONFIG_DIR = '${dir.replace(/'/g, "''")}'\nRemove-Item Env:CLAUDEP_AUTO -ErrorAction SilentlyContinue\n`;
  }
  if (dir === undefined) return "unset CLAUDE_CONFIG_DIR CLAUDEP_AUTO\n";
  return `export CLAUDE_CONFIG_DIR='${dir.replace(/'/g, `'\\''`)}'\nunset CLAUDEP_AUTO\n`;
}

export function shellInit(shell: Shell, profilesRoot: string, platform: NodeJS.Platform = process.platform): string {
  return shell === "powershell" ? powershellHook(profilesRoot) : shHook(shell, profilesRoot, platform);
}

/** The PowerShell hook, for Windows PowerShell 5.1 and PowerShell 7. Wraps
 *  `prompt` because there is no chpwd and LocationChangedAction is 7 only.
 *  Cmdlets and builtins only, ASCII only, and every value it manages lives
 *  in $global: because the profile dot-sources what Invoke-Expression ran.
 *  The parent step is .NET GetDirectoryName: Split-Path cannot combine
 *  -LiteralPath with -Parent, and -Path would expand wildcards. */
function powershellHook(profilesRoot: string): string {
  const q = profilesRoot.replace(/'/g, "''");
  return `# claudep shell hook. Load it from your $PROFILE:  ${hookHint("powershell")}
$global:_claudep_root = '${q}'
function global:_claudep_auto {
  $here = $ExecutionContext.SessionState.Path.CurrentFileSystemLocation.ProviderPath
  if ($here -ceq $global:_claudep_last_pwd) { return }
  $global:_claudep_last_pwd = $here
  # Only manage a CLAUDE_CONFIG_DIR this hook set itself. A manual pin wins.
  if ($env:CLAUDE_CONFIG_DIR -and ($env:CLAUDE_CONFIG_DIR -cne $env:CLAUDEP_AUTO)) { return }
  $dir = $here
  $name = ''
  $found = ''
  while ($true) {
    $pin = Join-Path $dir '${PIN_FILE}'
    if (Test-Path -LiteralPath $pin -PathType Leaf) {
      $found = $dir
      foreach ($line in @(Get-Content -LiteralPath $pin)) {
        $t = ([string]$line).Trim()
        if ($t -eq '' -or $t.StartsWith('#')) { continue }
        $name = $t
        break
      }
      break
    }
    $parent = [System.IO.Path]::GetDirectoryName($dir)
    if (-not $parent -or ($parent -ceq $dir)) { break }
    $dir = $parent
  }
  if ($name -eq '') {
    # No pin here: hand the shell back to the base account.
    if ($env:CLAUDEP_AUTO) { Remove-Item Env:CLAUDE_CONFIG_DIR, Env:CLAUDEP_AUTO -ErrorAction SilentlyContinue }
    return
  }
  $target = Join-Path $global:_claudep_root $name
  if (-not (Test-Path -LiteralPath $target -PathType Container)) {
    if ($env:CLAUDEP_AUTO) { Remove-Item Env:CLAUDE_CONFIG_DIR, Env:CLAUDEP_AUTO -ErrorAction SilentlyContinue }
    [Console]::Error.WriteLine('claudep: ' + (Join-Path $found '${PIN_FILE}') + ' names profile "' + $name + '", which does not exist. Run: claudep init ' + $name)
    return
  }
  $env:CLAUDE_CONFIG_DIR = $target
  $env:CLAUDEP_AUTO = $target
}
if (-not $global:_claudep_prompt_orig) {
  $global:_claudep_prompt_orig = if (Test-Path Function:\\prompt) { $function:prompt } else { { 'PS> ' } }
  function global:prompt { _claudep_auto; & $global:_claudep_prompt_orig }
}
_claudep_auto
`;
}

function shHook(shell: "zsh" | "bash", profilesRoot: string, platform: NodeJS.Platform): string {
  const q = profilesRoot.replace(/'/g, `'\\''`);
  // Under Git Bash $PWD is POSIX-style but the exported value must be the
  // native path claude.exe reads, so the root and its separator are embedded
  // as the native bun saw them and only the walk uses $PWD.
  const sep = platform === "win32" ? "\\" : "/";
  const core = `# claudep shell hook. Load it from your rc file:  eval "$(claudep shell-init ${shell})"
_claudep_root='${q}'
_claudep_sep='${sep}'
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
        _claudep_line="\${_claudep_line%$'\\r'}"
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
  if [ ! -d "$_claudep_root$_claudep_sep$_claudep_name" ]; then
    [ -n "\${CLAUDEP_AUTO:-}" ] && unset CLAUDE_CONFIG_DIR CLAUDEP_AUTO
    printf 'claudep: %s/${PIN_FILE} names profile "%s", which does not exist. Run: claudep init %s\\n' "$_claudep_found" "$_claudep_name" "$_claudep_name" >&2
    return 0
  fi
  export CLAUDE_CONFIG_DIR="$_claudep_root$_claudep_sep$_claudep_name" CLAUDEP_AUTO="$_claudep_root$_claudep_sep$_claudep_name"
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
  const shell = args[0] ?? defaultShell(process.env, L.platform);
  if (!SHELLS.includes(shell as Shell)) die(`unsupported shell "${shell}". Use zsh, bash or powershell`);
  process.stdout.write(shellInit(shell as Shell, L.profilesRoot, L.platform));
}

/** A POSIX-style CLAUDE_CONFIG_DIR on Windows is one claude.exe cannot read. */
function msysConfigDirWarning(L: Layout, env: Env = process.env): string | undefined {
  const cfg = env.CLAUDE_CONFIG_DIR;
  if (L.platform !== "win32" || !cfg || !isMsysPath(cfg)) return undefined;
  return `CLAUDE_CONFIG_DIR is a POSIX-style path (${cfg}); claude.exe will not read it. Set it with: eval "$(claudep env <name>)"`;
}

async function cmdDoctor(L: Layout, args: string[]): Promise<void> {
  const names = args[0] ? [args[0]] : listProfileNames(L);
  let problems = 0;
  const launch = findClaude();
  if (launch && launch.kind !== "ps1") {
    const { out } = await captureClaude(L, undefined, ["--version"]);
    ok(`claude: ${launch.bin} (${out.trim() || "version unknown"})`);
    if (launch.kind === "cmd")
      console.log(
        `${c.dim("·")} claude is the npm cmd shim and runs through cmd.exe; the native installer's claude.exe avoids that hop`,
      );
    const v = parseVersion(out);
    const floor = parseVersion(MIN_CLAUDE_VERSION);
    if (L.platform === "darwin" && v && floor && versionBelow(v, floor)) {
      bad(
        `Claude Code ${v.join(".")} is older than ${MIN_CLAUDE_VERSION}; every config dir shares one Keychain item there, so profiles cannot hold separate logins. Update Claude Code`,
      );
      problems++;
    }
  } else if (launch) bad(`only ${launch.bin} found; claudep needs claude.exe or claude.cmd`);
  else bad("claude binary not found on PATH");
  ok(`base: ${L.base}${L.callerConfigDir && !L.managed ? c.yellow("  (from CLAUDE_CONFIG_DIR in your shell)") : ""}`);
  const msysWarning = msysConfigDirWarning(L);
  if (msysWarning) warn(msysWarning);
  const settingsFile = join(L.base, "settings.json");
  const pinnedInSettings = await settingsEnvConfigDir(settingsFile);
  if (pinnedInSettings !== undefined) {
    bad(
      `${settingsFile} sets env.CLAUDE_CONFIG_DIR (${pinnedInSettings}). Claude Code disables features when that differs from the active dir, which it does in every profile. Remove it; pin shells with claudep env or a ${PIN_FILE} file instead`,
    );
    problems++;
  }
  for (const v of authEnvOverrides(process.env, L.platform))
    warn(`${v} is set in this shell; Claude Code uses it instead of the profile login, always in -p mode`);
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

  for (const name of names) {
    const dir = profileDir(L, name);
    console.log(`\n${c.bold(name)}  ${c.dim(dir)}`);
    if (!existsSync(dir)) {
      bad("profile dir missing");
      problems++;
      continue;
    }
    let missing = 0;
    for (const item of shared) {
      const state = linkState(L.base, dir, item);
      if (state === "ok") continue;
      problems++;
      if (state === "missing") {
        missing++;
        warn(`${item.name}: not linked (run: claudep init ${name})`);
      } else if (state === "shadowed") warn(`${item.name}: real ${item.kind} shadows the shared one`);
      else if (state === "wrong-target")
        bad(`${item.name}: symlink points elsewhere (${readlinkSync(join(dir, item.name))})`);
      else bad(`${item.name}: broken symlink`);
    }
    if (missing && L.platform === "win32")
      console.log(
        `${c.dim("·")} Windows creates symlinks only with Developer Mode on; claudep init ${name} says so when it is off`,
      );
    ok(`${shared.length} shared item(s) checked`);
    const strays = readdirSync(dir).filter((n) => !sharedNames.has(n) && !KNOWN_PRIVATE.has(n) && !n.endsWith(".md"));
    if (strays.length) warn(`unexpected private items: ${strays.join(", ")}`);
    if (L.platform === "darwin") {
      const svc = keychainService(dir);
      if (await keychainHas(svc)) ok(`keychain item "${svc}" present`);
      else warn(`no keychain item "${svc}". Not logged in yet (claudep ${name} auth login)`);
    } else if (credentialsFileHas(dir)) ok(".credentials.json present");
    else warn(`no .credentials.json in the profile. Not logged in yet (claudep ${name} auth login)`);
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
  if (
    !isInside(realpathSync(L.profilesRoot), real, L.platform) ||
    samePath(real, realpathSync(L.base), L.platform) ||
    samePath(real, L.home, L.platform)
  )
    die(`refusing to remove ${real}: not inside ${L.profilesRoot}`);
  const cur = currentProfile(L);
  if (cur.kind === "profile" && cur.name === name) {
    const unset =
      shellSyntax(process.env, L.platform) === "powershell"
        ? "claudep env --unset | Invoke-Expression"
        : 'eval "$(claudep env --unset)"';
    warn(
      `this shell is on ${name} (${cur.setBy === "hook" ? "shell hook" : "manual pin"}). After removal run: ${unset}`,
    );
  }
  const pin = resolvePin(process.cwd());
  if (pin && pin.name === name)
    warn(
      `${shortHome(pin.file, L.home, L.platform)} pins this directory tree to ${name}. Remove it with: claudep local --remove`,
    );
  if (!f.bools.has("--yes")) {
    const yes = confirm(`Remove profile "${name}" (${dir})? Shared items are only unlinked; ${L.base} is untouched.`);
    if (!yes) {
      console.log("aborted");
      return;
    }
  }
  if (!f.bools.has("--keep-login")) {
    const proc = spawnClaude(L, dir, ["auth", "logout"], "inherit");
    if ((await proc.exited) === 0) ok("logged out (token revoked, credentials removed)");
    else warn("logout failed or was not logged in. Continuing");
  }
  // Unlink the shared items first so no recursive delete ever looks through
  // a symlink into the base, whatever the platform's rm does with them.
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (lstatSync(p).isSymbolicLink()) removeLink(p);
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
  const root = shortHome(L.profilesRoot, L.home, L.platform);
  console.log(`${c.bold("claudep")} ${c.dim(version())}: run Claude Code under separate accounts on one machine

${c.bold("USAGE")}
  claudep <name> [claude args…]        run claude with profile <name>  (alias for "run")
  claudep init <name> [options]        create/update a profile and log in
  claudep list [--json]                show every profile and who it is logged in as
  claudep status <name> [--json]       login state for one profile ("default" = ~/.claude)
  claudep current [--json|--name]      which profile this shell is on, and why; --name prints only the name
  claudep env <name> | --unset         print the CLAUDE_CONFIG_DIR export (or the unset) for eval / Invoke-Expression
  claudep alias <name> <command>       write a shim so "<command>" == "claudep <name>"
  claudep doctor [name]                verify symlinks, keychain entry, unclassified files
  claudep rm <name> [--keep-login]     log out and delete a profile (base is never touched)
  claudep --version                    print the version

${c.bold("DIRECTORY PINS")}
  claudep local <name> [--force]       write ./${PIN_FILE} so this tree uses <name>; --remove deletes it
  claudep local                        show the pin that applies to the current directory
  claudep resolve [dir] [--json]       print the profile pinned for a directory (exit 1 when none)
  claudep shell-init [zsh|bash|powershell]   print the hook that applies pins on cd; load it from your rc file

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
  claudep env enterprise | Invoke-Expression    # the same from PowerShell
  claudep local enterprise                      # pin this repo; commit the ${PIN_FILE} file for the team
  eval "$(claudep shell-init zsh)"              # in .zshrc: shells follow ${PIN_FILE} pins on cd
  ${hookHint("powershell")}   # the same line for $PROFILE

${c.bold("HOW IT WORKS")}
  ~/.claude stays exactly as it is and remains the "default" profile. Each named profile is a
  thin directory under ${root}/<name> that Claude Code is pointed at via
  CLAUDE_CONFIG_DIR. Inside it, shared config is a symlink back into ~/.claude:
    ${[...SHARED_FILES, "*.md", ...SHARED_DIRS].join("  ")}
  Everything account-specific is real and per profile: .claude.json (login identity, MCP
  servers, folder trust), org-pushed remote-settings.json, history, todos, caches.
  On macOS credentials never touch the profile dir: Claude Code stores them in the Keychain under
  "Claude Code-credentials-<sha256(CLAUDE_CONFIG_DIR)[0:8]>", so every profile has its own
  login and refresh token and they cannot clobber each other. On Linux and Windows the login is
  <profile>/.credentials.json, a real file inside the profile that is never shared.

${c.bold("PIN RULES")}
  The nearest ${PIN_FILE} file upward from the current directory wins; an empty one cancels a
  parent pin. The hook only changes a CLAUDE_CONFIG_DIR it set itself (tracked in CLAUDEP_AUTO),
  so a manual pin from "claudep env" stays put. Leaving every pinned tree returns the shell to
  ~/.claude.

${c.bold("ENVIRONMENT")}
  CLAUDE_PROFILES_DIR   where profiles live (default ~/.claudep; keep it out of iCloud/Dropbox)
  CLAUDEP_AUTO          set by the hook next to CLAUDE_CONFIG_DIR; marks the pin as hook-managed

${c.dim("claudep is an independent, unofficial tool. It is not affiliated with, endorsed by or supported by Anthropic.")}
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
      return cmdList(L, args);
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
