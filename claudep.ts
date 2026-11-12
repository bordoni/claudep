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
  type Dirent,
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
  /** CLAUDE_CONFIG_DIR as set in the caller's shell, if any. An empty value is
   *  not a directory; it is reported through `emptyConfigDir` instead. */
  callerConfigDir: string | undefined;
  /** CLAUDE_CONFIG_DIR is set but empty. Claude Code then uses the current
   *  directory as its config dir (anthropics/claude-code#104629). */
  emptyConfigDir: boolean;
  /** Where Claude Code reads managed settings on this machine. */
  managedDir: string;
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

/** Claude Code's managed settings folder, fixed per platform as of 2.1.318. */
export function managedSettingsDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode";
  return "/etc/claude-code";
}

export function layout(env: Env = process.env, platform: NodeJS.Platform = process.platform): Layout {
  const P = pathApi(platform);
  const home = homeDir(env, platform);
  const emptyConfigDir = env.CLAUDE_CONFIG_DIR === "";
  const callerConfigDir = emptyConfigDir ? undefined : env.CLAUDE_CONFIG_DIR;
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
    emptyConfigDir,
    managedDir: env.CLAUDEP_MANAGED_DIR || managedSettingsDir(platform),
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
  setBy: "none" | "hook" | "manual" | "run";
};

/** What this shell is running Claude Code as, and how it got that way. */
export function currentProfile(L: Layout, env: Env = process.env): Current {
  const cfg = env.CLAUDE_CONFIG_DIR;
  if (!cfg) return { kind: "base", name: undefined, dir: L.base, setBy: "none" };
  const dir = canon(cfg, L.home, L.platform);
  const auto = env.CLAUDEP_AUTO;
  const run = env.CLAUDEP_RUN;
  const same = (v: string | undefined) =>
    v !== undefined && v !== "" && samePath(canon(v, L.home, L.platform), dir, L.platform);
  // A marker that names another dir was inherited by a nested manual pin, so it does not count.
  const setBy = same(auto) ? "hook" : same(run) ? "run" : "manual";
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

/** Per-profile state. First block is Claude Code's own runtime-state list as of
 *  2.1.263, then observed extras, then what 2.1.280 and 2.1.311 added to that
 *  list. Never shared, and a name here is never shared by the top-level *.md
 *  rule either. Lock files are private by pattern; see isKnownPrivate(). */
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
  // Added to Claude Code's runtime-state list by 2.1.280 (checked 2026-09-30).
  "state",
  "policy-limits.json.stamp.json",
  "policy-limits.json.signature.json",
  "policy-limits.json.signature-iat.json",
  "remote-settings.json.signature.json",
  "remote-settings.json.signature-iat.json",
  "remote-settings-consent.json",
  "remote-settings-helper-consent",
  "hfi-auth.json",
  "shares",
  "storage-v2",
  "daemon.lock",
  "gh-pr-status-cache.json",
  "active-time.json",
  "server-sessions.json",
  "image-cache",
  "file-transfers",
  "computer-use.lock",
  "server.lock",
  "downloads",
  "scratch",
  "traces",
  "startup-perf",
  "feedback-bundles",
  "ccr",
  "bridge-spawn",
  "local-settings",
  "project-settings",
  "remote",
  "systemd",
  "api-dumps",
  "dump-prompts",
  "antproto.json",
  ".cc-writes",
  "loop.md",
  // Added to Claude Code's runtime-state list by 2.1.311 (checked 2026-10-27).
  "remote-settings.json.synced-at",
  "ccr-home-seed.json",
  "remote-control",
  // Trusted-device keys; 2.1.311 writes them to ~/.claude whatever the config dir.
  ".device-keys.json",
  // claudep's own per-profile files.
  "claudep.env",
  "claudep.settings.json",
  "claudep.login",
  "claudep.doctor",
]);

/** Keys copied from the base .claude.json into a fresh profile so first-run
 *  onboarding does not repeat. Account identity is deliberately excluded, and
 *  so is `autoUpdates`: Claude Code migrates `autoUpdates: false` into
 *  `env.DISABLE_AUTOUPDATER` in the user settings.json, which in a profile is
 *  the shared file, so one profile's seed would switch every profile. */
export const SEED_KEYS = [
  "hasCompletedOnboarding",
  "lastOnboardingVersion",
  "theme",
  "editorMode",
  "preferredNotifChannel",
  "shiftEnterKeyBindingInstalled",
  "installMethod",
] as const;

export const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Shells with a directory-pin hook, and the ones with tab completions. */
export type Shell = "zsh" | "bash" | "fish" | "powershell";
export const SHELLS: readonly Shell[] = ["zsh", "bash", "fish", "powershell"];
export const COMPLETION_SHELLS = ["zsh", "bash", "fish", "powershell"] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];
/** What `claudep env --shell` accepts. */
export const ENV_SHELLS = ["sh", "zsh", "bash", "fish", "powershell"] as const;

export type ValueFlag = { name: string; values?: readonly string[] };
export type Command = {
  name: string;
  /** One line, no colons: it becomes the zsh _describe and fish -d text. */
  desc: string;
  aliases?: readonly string[];
  /** What the first positional completes to. */
  arg?: "profile" | "dir" | readonly string[];
  flags?: readonly string[];
  valueFlags?: readonly ValueFlag[];
  /** A real command that the top-level completion does not offer. */
  hidden?: boolean;
};

/** One table for the dispatcher's reserved words, every parseFlags call and
 *  the completion scripts, so none of them can drift from the others. */
export const COMMANDS: readonly Command[] = [
  {
    name: "init",
    desc: "create or update a profile and log in if it has no login",
    arg: "profile",
    flags: ["--sso", "--console", "--copy-mcp", "--no-login", "--force"],
    valueFlags: [{ name: "--email" }, { name: "--alias" }, { name: "--env" }],
  },
  { name: "run", desc: "run claude with a profile", arg: "profile", hidden: true },
  {
    name: "hook",
    desc: "record a StopFailure for list and doctor, or print the settings that call it",
    arg: ["stop-failure"],
    flags: ["--print"],
    hidden: true,
  },
  {
    name: "list",
    desc: "show every profile and who it is logged in as",
    aliases: ["ls"],
    flags: ["--json", "--live"],
  },
  { name: "status", desc: "login state for one profile", arg: "profile", flags: ["--json", "--live"] },
  { name: "current", desc: "which profile this shell is on, and why", flags: ["--json", "--name"] },
  {
    name: "env",
    desc: "print the CLAUDE_CONFIG_DIR pin, or the unset, for your shell",
    arg: "profile",
    flags: ["--unset"],
    valueFlags: [{ name: "--shell", values: ENV_SHELLS }],
  },
  {
    name: "vars",
    desc: "list, set or unset the variables a profile exports",
    arg: "profile",
    flags: ["--unset", "--json"],
  },
  {
    name: "settings",
    desc: "list, set or unset the settings claudep run gives a profile",
    arg: "profile",
    flags: ["--unset", "--json"],
  },
  {
    name: "alias",
    desc: "list the shim commands on PATH, or write one that runs claudep with a profile",
    arg: "profile",
    flags: ["--json"],
  },
  { name: "ps", desc: "live Claude Code sessions in every profile", arg: "profile", flags: ["--json", "--stale"] },
  { name: "handoff", desc: "resume this directory's latest session under another profile", arg: "profile" },
  { name: "statusline", desc: "print the profile and its usage from the statusline JSON on stdin" },
  {
    name: "usage",
    desc: "five-hour and weekly usage for every profile",
    arg: "profile",
    flags: ["--json", "--live", "--cached"],
  },
  {
    name: "doctor",
    desc: "verify symlinks, keychain entry, unclassified files, Claude Code version",
    arg: "profile",
    flags: ["--json", "--accept", "--unaccept"],
  },
  {
    name: "rm",
    desc: "log out and delete a profile",
    aliases: ["remove"],
    arg: "profile",
    flags: ["--keep-login", "--yes", "--force"],
  },
  { name: "local", desc: "pin this directory tree to a profile", arg: "profile", flags: ["--remove", "--force"] },
  { name: "resolve", desc: "print the profile pinned for a directory", arg: "dir", flags: ["--json"] },
  { name: "shell-init", desc: "print the hook that applies pins on cd", arg: SHELLS },
  { name: "completion", desc: "print tab completions for a shell", arg: COMPLETION_SHELLS },
  { name: "help", desc: "show the help" },
  { name: "version", desc: "print the version", aliases: ["--version"] },
];

/** The words a completion offers for a command: its name and the aliases
 *  that are words (a `--version` alias is a flag, not a word). */
export function commandWords(c: Command): string[] {
  return [c.name, ...(c.aliases ?? [])].filter((w) => !w.startsWith("-"));
}

/** Profile names that would collide with the dispatcher. Derived from the
 *  table plus the two names for the base. */
export const RESERVED = new Set([
  "default",
  "base",
  ...COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]).filter((w) => NAME_RE.test(w)),
]);

/** The boolean and value flag names a command accepts, for parseFlags. */
export function flagSpec(name: string): [readonly string[], readonly string[]] {
  const c = COMMANDS.find((x) => x.name === name);
  return [c?.flags ?? [], (c?.valueFlags ?? []).map((v) => v.name)];
}

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

/** Exit codes for claudep's own failures on the launch path, from sysexits.h.
 *  Claude's own exit code passes through unchanged, so these never collide with its 1. */
export const EXIT = {
  /** Usage error or an invalid profile name (EX_USAGE). */
  usage: 64,
  /** The profile does not exist (EX_NOUSER). */
  noProfile: 67,
  /** `claude` is missing, or only a .ps1 was found (EX_UNAVAILABLE). */
  noClaude: 69,
  /** Claude stopped on a usage limit or a billing error (EX_TEMPFAIL). */
  limit: 75,
  /** Claude stopped because the login no longer works (EX_NOPERM). */
  login: 77,
  /** The profile's claudep.settings.json cannot be read (EX_CONFIG). */
  config: 78,
} as const;

export function die(msg: string, code = 1): never {
  console.error(`${c.red("error:")} ${msg}`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Profile helpers
// ---------------------------------------------------------------------------

export function profileDir(L: Layout, name: string): string {
  if (!NAME_RE.test(name))
    die(`invalid profile name "${name}" (use [a-z0-9_-], starting with a letter or digit)`, EXIT.usage);
  if (RESERVED.has(name)) die(`"${name}" is a reserved word and cannot be a profile name`, EXIT.usage);
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

/** Claude Code 2.1.311 guards its state with `<file>.lock` directories
 *  (proper-lockfile), plain lock files such as `.update.lock`, and
 *  `.oauth_refresh.lock.owner`, each next to the state it guards. None is shared. */
const LOCK_RE = /\.lock(\.owner)?$/;

/** A top-level name that is per-profile state: listed in KNOWN_PRIVATE, or a lock. */
export function isKnownPrivate(name: string): boolean {
  return KNOWN_PRIVATE.has(name) || LOCK_RE.test(name);
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
      if (entry.name.endsWith(".md") && !entry.isDirectory() && !KNOWN_PRIVATE.has(entry.name))
        push(entry.name, "file");
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

/** Link the allowlisted items a profile is missing, and return their names.
 *  `claudep run` calls this before every launch, so an item that appeared in
 *  the base after `init` reaches the profile. Only SHARED_FILES and SHARED_DIRS
 *  qualify: a new top-level *.md could be per-instance state, as loop.md was in
 *  2.1.280, so those wait for `init`. Items the user accepted as different stay
 *  as they are. Any failure, such as two launches racing for one link, is
 *  skipped: this must never stop claude from starting. */
export function healLinks(
  base: string,
  dir: string,
  accepted: ReadonlySet<string> = new Set(),
  deps: LinkDeps = defaultLinkDeps(),
): string[] {
  const linked: string[] = [];
  try {
    if (builtOnOtherBase(base, dir, deps)) return linked;
    for (const item of sharedItems(base)) {
      if (!isLaunchLinked(item.name) || accepted.has(item.name)) continue;
      try {
        if (linkState(base, dir, item, deps) === "missing" && link(base, dir, item, false, deps) === "linked")
          linked.push(item.name);
      } catch {}
    }
  } catch {}
  return linked;
}

/** True when a profile's shared symlinks all point away from `base`, as they do
 *  after `init` ran with a custom CLAUDE_CONFIG_DIR. New links from `base` would
 *  mix two bases in one profile. One link into `base` is enough to say otherwise,
 *  so a single item the user repointed does not stop the rest. */
export function builtOnOtherBase(
  base: string,
  dir: string,
  deps: Pick<LinkDeps, "platform" | "readlink"> = defaultLinkDeps(),
): boolean {
  let here = false;
  let away = false;
  for (const name of [...SHARED_FILES, ...SHARED_DIRS]) {
    const dest = join(dir, name);
    try {
      if (!lstatSync(dest).isSymbolicLink()) continue;
      if (samePath(deps.readlink(dest), join(base, name), deps.platform)) here = true;
      else away = true;
    } catch {}
  }
  return away && !here;
}

/** True for the items healLinks() links on launch. */
export function isLaunchLinked(name: string): boolean {
  return (SHARED_FILES as readonly string[]).includes(name) || (SHARED_DIRS as readonly string[]).includes(name);
}

/** Why a real file or directory in a profile differs from the shared one, for
 *  the doctor line: what links into the base and what only the profile has for
 *  a directory, and for settings.json the top-level key names that differ. Key
 *  names only; a settings value can hold a secret. */
export function shadowDetail(
  base: string,
  dir: string,
  item: SharedItem,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const P = pathApi(platform);
  const own = P.join(dir, item.name);
  const shared = P.join(base, item.name);
  if (item.kind === "dir") return shadowDirDetail(base, own, shared, platform);
  if (item.name !== "settings.json") return "";
  const diff = settingsKeyDiff(readTrimmed(shared), readTrimmed(own));
  if (!diff) return "one of the two is not a JSON object";
  if (!diff.differ.length) return "no top-level key differs";
  const carry = diff.carry.length ? `; claudep settings ${name} <key>=<value> can carry ${diff.carry.join(", ")}` : "";
  return `keys that differ: ${diff.differ.join(", ")}${carry}`;
}

const NAMES_SHOWN = 10;

function shadowDirDetail(base: string, own: string, shared: string, platform: NodeJS.Platform): string {
  const P = pathApi(platform);
  let entries: string[];
  try {
    entries = readdirSync(own);
  } catch {
    return "";
  }
  let inBase = new Set<string>();
  try {
    inBase = new Set(readdirSync(shared));
  } catch {}
  let links = 0;
  const only: string[] = [];
  const copies: string[] = [];
  for (const entry of entries.sort()) {
    const p = P.join(own, entry);
    let intoBase = false;
    try {
      if (lstatSync(p).isSymbolicLink()) intoBase = isInside(base, P.resolve(own, readlinkSync(p)), platform);
    } catch {}
    if (intoBase) links++;
    else if (inBase.has(entry)) copies.push(entry);
    else only.push(entry);
  }
  const names = (list: string[]) => {
    const more = list.length > NAMES_SHOWN ? ` and ${list.length - NAMES_SHOWN} more` : "";
    return `${list.slice(0, NAMES_SHOWN).join(", ")}${more}`;
  };
  const copied = copies.length ? `; its own copy of: ${names(copies)}` : "";
  return `${links} of ${entries.length} entries link into the base${copied}; only here: ${only.length ? names(only) : "nothing"}`;
}

/** The top-level keys two settings.json texts disagree on, and those a profile
 *  can move to claudep.settings.json. undefined when either is not an object. */
export function settingsKeyDiff(
  baseText: string | undefined,
  profileText: string | undefined,
): { differ: string[]; carry: string[] } | undefined {
  const parse = (text: string | undefined): JsonObject | undefined => {
    try {
      const j: unknown = JSON.parse(text ?? "");
      return j && typeof j === "object" && !Array.isArray(j) ? (j as JsonObject) : undefined;
    } catch {
      return undefined;
    }
  };
  const a = parse(baseText);
  const b = parse(profileText);
  if (!a || !b) return undefined;
  const differ = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !Bun.deepEquals(a[k], b[k])).sort();
  return { differ, carry: differ.filter((k) => k in b && !refusedSettingKey(k)) };
}

/** The file holding the differences a profile's owner meant to have. Plain
 *  text, one shared item per line, because claudep.settings.json is handed to
 *  Claude Code. */
export const ACCEPT_FILE = "claudep.doctor";

export function readAccepted(dir: string): Set<string> {
  const text = readTrimmed(join(dir, ACCEPT_FILE)) ?? "";
  return new Set(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#")),
  );
}

export function acceptedText(name: string, items: Iterable<string>): string {
  const head = `# Differences "claudep doctor" accepts for the profile "${name}". Edit with: claudep doctor --accept ${name} <item>\n`;
  return head + [...items].map((i) => `${i}\n`).join("");
}

/** Known-private names in a profile that are still symlinks into the base.
 *  An older claudep linked every top-level *.md, which once included loop.md;
 *  link() never deletes, so doctor names them for the user to remove. */
export function staleSharedLinks(base: string, dir: string, platform: NodeJS.Platform = process.platform): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isSymbolicLink() && KNOWN_PRIVATE.has(e.name))
    .filter((e) => samePath(readlinkSync(join(dir, e.name)), join(base, e.name), platform))
    .map((e) => e.name)
    .sort();
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

/** Every variable that holds a credential Claude Code reads, as of 2.1.318:
 *  AUTH_ENV, Claude Code's own scrub list, and the cloud provider secrets.
 *  claudep.env refuses them all. Names that hold a path or a file descriptor,
 *  such as ANTHROPIC_IDENTITY_TOKEN_FILE, hold no secret and stay allowed.
 *  ANTHROPIC_CUSTOM_HEADERS is here because it can carry auth headers. Only
 *  AUTH_ENV makes Claude Code ignore the stored login; the refresh token writes
 *  a new login through `claude auth login` instead. */
export const CREDENTIAL_ENV = [
  ...AUTH_ENV,
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_WORK_SECRET",
  "CLAUDE_API_KEY",
  "CLAUDE_BRIDGE_OAUTH_TOKEN",
  "CLAUDE_TRUSTED_DEVICE_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_SESSIONS_OAUTH_TOKEN",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "CLAUDE_CODE_ARTIFACTS_API_TOKEN",
  "CLAUDE_CODE_MEMORY_API_TOKEN",
  "CLAUDE_CODE_SLACK_TAG_TOKEN",
  "CLAUDE_CODE_GATEWAY_TOKEN",
  "CLAUDE_CODE_HFI_BEARER_TOKEN",
  "CLAUDE_CODE_MCP_SERVE_AUTH_TOKEN",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AZURE_CLIENT_SECRET",
  "AZURE_PASSWORD",
  "AZURE_CLIENT_CERTIFICATE_PASSWORD",
  "GOOGLE_OAUTH_ACCESS_TOKEN",
  "CLOUDSDK_AUTH_ACCESS_TOKEN",
  "CLOUDSDK_PROXY_PASSWORD",
  "ANTHROPIC_ENVIRONMENT_KEY",
  "ENVIRONMENT_SERVICE_KEY",
  "MCP_CLIENT_SECRET",
  "MCP_XAA_IDP_CLIENT_SECRET",
] as const;

/** Moves Claude Code's credential store away from the config dir: the Keychain
 *  hash on macOS and `.credentials.json` on Linux and Windows. One inherited
 *  value puts every profile on one login. */
export const SECURE_STORAGE_ENV = "CLAUDE_SECURESTORAGE_CONFIG_DIR";

/** Where an inherited CLAUDE_SECURESTORAGE_CONFIG_DIR puts this config dir's
 *  login, or undefined when it is unset or names `dir` itself. Claude Code reads
 *  an empty value as ~/.claude. */
export function secureStorageOverride(
  dir: string,
  env: Env = process.env,
  home: string = homeDir(env),
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const key = Object.keys(env).find((k) => (platform === "win32" ? k.toUpperCase() : k) === SECURE_STORAGE_ENV);
  const value = key === undefined ? undefined : env[key];
  if (value === undefined) return undefined;
  const target = value === "" ? pathApi(platform).join(home, ".claude") : canon(value, home, platform);
  return samePath(target, dir, platform) ? undefined : target;
}

/** The fix for an empty CLAUDE_CONFIG_DIR, shared by every command that stops on it. */
export const EMPTY_CONFIG_DIR_MESSAGE =
  "CLAUDE_CONFIG_DIR is set but empty, so Claude Code uses the current directory as its config dir (https://github.com/anthropics/claude-code/issues/104629). Fix it: unset CLAUDE_CONFIG_DIR";

// ---------------------------------------------------------------------------
// Per-profile variables: <profile>/claudep.env
// ---------------------------------------------------------------------------

/** The per-profile variables file. KEY=VALUE lines and # comments; data, never
 *  sourced. `run`, `env` and every shell hook read it, and a variable the user
 *  set themselves always wins over it. */
export const ENV_FILE = "claudep.env";
/** Space-separated names of the variables `claudep env` or the hook exported
 *  from a claudep.env, so they can be cleared again and never mistaken for
 *  variables the user set. */
export const ENV_KEYS_VAR = "CLAUDEP_ENV_KEYS";
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type EnvVar = [key: string, value: string];

/** Why a key cannot go in claudep.env, or undefined when it can. The profile
 *  dir and claudep's own markers are set by claudep, and credential material
 *  never lives in a claudep file. Case-insensitive, as Windows is. */
export function refusedEnvKey(key: string): string | undefined {
  const k = key.toUpperCase();
  if (k === "CLAUDE_CONFIG_DIR") return "claudep sets CLAUDE_CONFIG_DIR itself";
  if (k === SECURE_STORAGE_ENV) return "it moves the profile's login out of the profile";
  if (k.startsWith("CLAUDEP_")) return "CLAUDEP_ variables belong to claudep";
  if ((CREDENTIAL_ENV as readonly string[]).includes(k)) return "claudep never stores credentials";
  return undefined;
}

const REFUSED_ENV = ["CLAUDE_CONFIG_DIR", SECURE_STORAGE_ENV, "CLAUDEP_*", ...CREDENTIAL_ENV];

/** refusedEnvKey as a case-insensitive regex, for the fish and PowerShell hooks.
 *  Anchored alternatives, no group: every ( in the fish hook is a string call. */
export function refusedEnvRegex(): string {
  return REFUSED_ENV.map((k) => (k.endsWith("*") ? `^${k.slice(0, -1)}` : `^${k}$`)).join("|");
}

/** refusedEnvKey as an sh case pattern; every letter matches either case. */
export function refusedEnvCase(): string {
  return REFUSED_ENV.map((k) => k.replace(/[A-Za-z]/g, (ch) => `[${ch.toUpperCase()}${ch.toLowerCase()}]`)).join(" | ");
}

/** One KEY=VALUE from the command line, or the reason it is refused. Values
 *  are single-line, not empty (Windows cannot hold an empty variable) and
 *  carry no surrounding whitespace, so every shell reads the file the same way. */
export function validateEnvEntry(entry: string): EnvVar | string {
  const eq = entry.indexOf("=");
  if (eq === -1) return `"${entry}" is not KEY=VALUE`;
  const key = entry.slice(0, eq);
  const value = entry.slice(eq + 1);
  if (!ENV_KEY_RE.test(key))
    return `"${key}" is not a variable name (letters, digits and _, not starting with a digit)`;
  const refused = refusedEnvKey(key);
  if (refused) return `${key} is not allowed: ${refused}`;
  if (value === "") return `${key}: the value is empty; remove it with: claudep vars <name> --unset ${key}`;
  if (/[\r\n\0]/.test(value)) return `${key}: the value must be one line`;
  if (value !== value.trim()) return `${key}: the value must not start or end with whitespace`;
  return [key, value];
}

/** The variables in a claudep.env text, first occurrence of a key winning, and
 *  the 1-based numbers of lines that were skipped. Lines are trimmed, and a
 *  line with no value is skipped; the hooks read them the same way. */
export function parseEnvFile(text: string): { vars: EnvVar[]; skipped: number[] } {
  const vars: EnvVar[] = [];
  const skipped: number[] = [];
  const seen = new Set<string>();
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const eq = line.indexOf("=");
    const key = eq === -1 ? "" : line.slice(0, eq);
    if (!ENV_KEY_RE.test(key) || refusedEnvKey(key) || eq === line.length - 1) {
      skipped.push(i + 1);
      return;
    }
    if (seen.has(key)) return;
    seen.add(key);
    vars.push([key, line.slice(eq + 1)]);
  });
  return { vars, skipped };
}

export function readProfileEnv(dir: string): { vars: EnvVar[]; skipped: number[] } {
  try {
    return parseEnvFile(readFileSync(join(dir, ENV_FILE), "utf8"));
  } catch {
    return { vars: [], skipped: [] };
  }
}

/** The claudep.env text for a set of variables. */
export function envFileText(name: string, vars: readonly EnvVar[]): string {
  const head = `# Variables for the claudep profile "${name}". Set them with: claudep vars ${name} KEY=VALUE\n`;
  return head + vars.map(([k, v]) => `${k}=${v}\n`).join("");
}

function envHas(env: Env, key: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return env[key] !== undefined;
  const want = key.toUpperCase();
  return Object.keys(env).some((k) => k.toUpperCase() === want && env[k] !== undefined);
}

/** The variable names in CLAUDEP_ENV_KEYS, i.e. what claudep exported earlier. */
export function exportedEnvKeys(env: Env = process.env): string[] {
  return (env[ENV_KEYS_VAR] ?? "").split(" ").filter((k) => ENV_KEY_RE.test(k) && !refusedEnvKey(k));
}

/** What to clear and what to set when a shell or a run moves to a profile with
 *  `vars`. Variables claudep exported before are cleared first; then each file
 *  variable is set only where the user has not set it. */
export function envPlan(
  vars: readonly EnvVar[],
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): { clear: string[]; set: EnvVar[] } {
  const clear = exportedEnvKeys(env);
  const rest: Env = { ...env };
  for (const k of clear) deleteEnv(rest, k, platform);
  return { clear, set: vars.filter(([k]) => !envHas(rest, k, platform)) };
}

/** `env` with a profile's variables applied the way envPlan describes. */
export function withProfileVars(vars: readonly EnvVar[], env: Env, platform: NodeJS.Platform = process.platform): Env {
  const plan = envPlan(vars, env, platform);
  const out: Env = { ...env };
  for (const k of plan.clear) deleteEnv(out, k, platform);
  deleteEnv(out, ENV_KEYS_VAR, platform);
  for (const [k, v] of plan.set) out[k] = v;
  return out;
}

/** The oldest Claude Code whose macOS Keychain item is namespaced per config
 *  dir. Before it every config dir shared one login. */
export const MIN_CLAUDE_VERSION = "2.1.144";

/** From this Claude Code on, a write through a symlink is also judged at the
 *  path it lands on. Auto memory in a profile whose projects/ is shared lands
 *  in ~/.claude/projects and asks for approval on every write, which auto mode
 *  cannot give (anthropics/claude-code#98044). No fixed version yet. */
export const MEMORY_SYMLINK_PROMPT_FROM = "2.1.280";
export const MEMORY_SYMLINK_ISSUE = "https://github.com/anthropics/claude-code/issues/98044";

export type Version = [number, number, number];

/** True when this Claude Code prompts on every auto-memory write through the
 *  shared projects/ symlink. An unknown version is not reported. */
export function memoryWritesPrompt(v: Version | undefined, shared: readonly SharedItem[]): boolean {
  const from = parseVersion(MEMORY_SYMLINK_PROMPT_FROM);
  if (!v || !from || versionBelow(v, from)) return false;
  return shared.some((s) => s.name === "projects");
}

/** The first `.git` walking upward from `cwd`, a directory or a worktree's
 *  file, the way Claude Code finds the root it keys project data by. */
export function gitRoot(cwd: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const P = pathApi(platform);
  let dir = P.resolve(cwd);
  for (;;) {
    try {
      const st = statSync(P.join(dir, ".git"));
      if (st.isDirectory() || st.isFile()) return dir;
    } catch {}
    const up = P.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

function readTrimmed(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return undefined;
  }
}

/** The main checkout for a linked worktree's root, otherwise `root`. Follows
 *  `.git` (gitdir: X), X/commondir and the X/gitdir back-pointer, and gives up
 *  on anything that does not check out, as Claude Code 2.1.286 does. */
export function canonicalGitRoot(root: string, platform: NodeJS.Platform = process.platform): string {
  const P = pathApi(platform);
  const dotGit = readTrimmed(P.join(root, ".git"));
  if (!dotGit?.startsWith("gitdir:")) return root;
  const gitDir = P.resolve(root, dotGit.slice(7).trim());
  const commonDir = readTrimmed(P.join(gitDir, "commondir"));
  if (!commonDir) return root;
  const common = P.resolve(gitDir, commonDir);
  if (!samePath(P.dirname(gitDir), P.join(common, "worktrees"), platform)) return root;
  const back = readTrimmed(P.join(gitDir, "gitdir"));
  if (!back || !samePath(P.resolve(gitDir, back), P.join(root, ".git"), platform)) return root;
  if (P.basename(common) === ".git") return P.dirname(common);
  return existsSync(P.join(common, ".git")) ? root : common;
}

/** Java's String.hashCode, which Claude Code uses to shorten long folder names. */
function javaHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** The folder Claude Code keeps a project's data in under `projects/`.
 *  CLAUDE_CODE_PROJECT_DIR_NAME wins when CLAUDE_CONFIG_DIR is set and it is a
 *  plain name. Otherwise every character outside [a-zA-Z0-9] becomes "-", and
 *  a name over 200 characters is cut and gets the base-36 hash of the path. */
export function projectSlug(root: string, env: Env = process.env): string {
  const named = env.CLAUDE_CODE_PROJECT_DIR_NAME;
  if (named && /^[A-Za-z0-9_-]{1,64}$/.test(named) && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(named))
    return named;
  const slug = root.replace(/[^a-zA-Z0-9]/g, "-");
  return slug.length <= 200 ? slug : `${slug.slice(0, 200)}-${Math.abs(javaHash(root)).toString(36)}`;
}

/** `p` with its deepest existing ancestor resolved through symlinks and the
 *  rest appended as spelled. */
export function realpathPartial(p: string, platform: NodeJS.Platform = process.platform): string {
  const P = pathApi(platform);
  const tail: string[] = [];
  let dir = P.resolve(p);
  for (;;) {
    try {
      return P.join(toNativePath(realpathSync.native(dir), platform), ...tail);
    } catch {}
    const up = P.dirname(dir);
    if (up === dir) return P.resolve(p);
    tail.unshift(P.basename(dir));
    dir = up;
  }
}

/** The auto-memory directory `claudep run` hands Claude Code through
 *  `--settings`, or undefined when there is nothing to fix. Since 2.1.280 a
 *  memory write in a profile is also judged where the shared projects/
 *  symlink lands, and prompts every time (anthropics/claude-code#98044).
 *  Naming the landing path itself gives both spellings one answer. Skipped
 *  when the caller passes their own --settings, which would replace this one,
 *  or moves memory with CLAUDE_CODE_REMOTE_MEMORY_DIR. */
export function memoryDirOverride(
  dir: string,
  cwd: string,
  args: readonly string[],
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (args.some((a) => a === "--settings" || a.startsWith("--settings="))) return undefined;
  if (env.CLAUDE_CODE_REMOTE_MEMORY_DIR) return undefined;
  const P = pathApi(platform);
  const start = P.resolve(cwd).normalize("NFC");
  const git = gitRoot(start, platform);
  const root = git === undefined ? start : canonicalGitRoot(git, platform).normalize("NFC");
  const spelled = P.join(dir, "projects", projectSlug(root, env), "memory");
  const real = realpathPartial(spelled, platform);
  return samePath(real, spelled, platform) ? undefined : real;
}

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
  return (await settingsEnv(settingsPath)).CLAUDE_CONFIG_DIR;
}

/** The string values of a settings file's `env` block. Claude Code copies
 *  them into its own environment at start. */
export async function settingsEnv(settingsPath: string): Promise<Env> {
  return stringValues((await readJson(settingsPath))?.env);
}

/** The string values of an `env` object, as Claude Code applies them. */
export function stringValues(env: unknown): Env {
  if (!env || typeof env !== "object" || Array.isArray(env)) return {};
  const out: Env = {};
  for (const [k, v] of Object.entries(env as JsonObject)) if (typeof v === "string") out[k] = v;
  return out;
}

/** The `env` block of the machine's managed settings: managed-settings.json,
 *  then each *.json in managed-settings.d in sorted order, a later file winning,
 *  as Claude Code 2.1.318 merges them. Dotfiles are skipped, as it does.
 *  Server-managed settings, the macOS plist and the Windows registry are not read. */
export async function managedSettingsEnv(
  managedDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<Env> {
  const P = pathApi(platform);
  const dropIns = P.join(managedDir, "managed-settings.d");
  let names: string[] = [];
  try {
    names = readdirSync(dropIns)
      .filter((n) => n.endsWith(".json") && !n.startsWith("."))
      .sort();
  } catch {}
  const files = [P.join(managedDir, "managed-settings.json"), ...names.map((n) => P.join(dropIns, n))];
  const merged: Env = {};
  for (const file of files) Object.assign(merged, await settingsEnv(file));
  return merged;
}

export type AutoUpdate = { enabled: boolean; by?: string };

/** Whether Claude Code's background updater runs for a config dir, in the
 *  order Claude Code 2.1.311 checks: three variables, then `autoUpdates` in
 *  .claude.json, which a native install ignores once it has set
 *  `autoUpdatesProtectedForNative`. `sources` are labelled environments,
 *  strongest first, and the first one that defines a variable decides it, as
 *  Claude Code copies settings `env` over the shell before it looks. The first
 *  two count when they are 1, true, yes or on; CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
 *  counts when it is set to anything, even 0. */
export function autoUpdateState(sources: readonly [string, Env][], globalJson: JsonObject | undefined): AutoUpdate {
  for (const key of ["DISABLE_UPDATES", "DISABLE_AUTOUPDATER", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]) {
    const hit = sources.find(([, env]) => env[key] !== undefined);
    const v = hit?.[1][key];
    const set = key === "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" ? !!v : /^(1|true|yes|on)$/i.test((v ?? "").trim());
    if (hit && set) return { enabled: false, by: `${key} in ${hit[0]}` };
  }
  const protectedNative = globalJson?.installMethod === "native" && globalJson.autoUpdatesProtectedForNative === true;
  if (globalJson?.autoUpdates === false && !protectedNative)
    return { enabled: false, by: "autoUpdates in .claude.json" };
  return { enabled: true };
}

export type LastUpdate = { from?: string; to?: string; outcome?: string; at?: string; path?: string };

/** What Claude Code recorded about its last update attempt in a config dir. */
export async function lastUpdate(dir: string): Promise<LastUpdate | undefined> {
  const j = await readJson(join(dir, ".last-update-result.json"));
  if (!j) return undefined;
  const str = (k: string) => (typeof j[k] === "string" ? (j[k] as string) : undefined);
  return {
    from: str("version_from"),
    to: str("version_to"),
    outcome: str("outcome"),
    at: str("timestamp"),
    path: str("path"),
  };
}

/** The clause `doctor` adds to a config dir's last-update line when the
 *  running Claude Code is not the version that record leaves behind: the
 *  target of a successful update, or the starting version of a failed one.
 *  `targets` are the versions successful updates in any config dir ended on;
 *  when one is the running version, another config dir did the update,
 *  otherwise something outside Claude Code did (npm, a package manager). */
export function updateNote(
  last: LastUpdate | undefined,
  running: Version | undefined,
  targets: readonly Version[],
): string {
  if (!last || !running) return "";
  const failed = last.outcome === "failed";
  const left = parseVersion((failed ? last.from : last.to) ?? "");
  if (!left) return "";
  const r = running.join(".");
  if (!failed && versionBelow(running, left))
    return `; running ${r} is older (a downgrade, or another claude is first on PATH)`;
  if (!versionBelow(left, running)) return "";
  return targets.some((v) => !versionBelow(v, running) && !versionBelow(running, v))
    ? `; running ${r}, updated since by another config dir`
    : `; running ${r}, updated outside Claude Code since`;
}

/** The versions successful update records end on. */
export function updateTargets(records: readonly (LastUpdate | undefined)[]): Version[] {
  return records.flatMap((rec) => {
    const v = rec?.outcome === "success" && rec.to ? parseVersion(rec.to) : undefined;
    return v ? [v] : [];
  });
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

/** Every `claude` on PATH, in PATH order, one per directory. */
export function findAllClaude(deps: FindDeps = defaultFindDeps()): string[] {
  const P = pathApi(deps.platform);
  const names = deps.platform === "win32" ? ["claude.exe", "claude.cmd", "claude.bat"] : ["claude"];
  const out: string[] = [];
  for (const dir of splitPathVar(deps.pathVar, deps.platform)) {
    const hit = names.map((n) => P.join(dir, n)).find((p) => deps.exists(p));
    if (hit && !out.some((o) => samePath(o, hit, deps.platform))) out.push(hit);
  }
  return out;
}

export type InstallKind = "native" | "npm" | "bun" | "homebrew" | "unknown";

/** How the claude at `bin` was installed, from the path it resolves to. The
 *  native installer keeps versions under .../claude/versions/ and points a
 *  launcher at one; npm and bun install @anthropic-ai/claude-code into a
 *  global node_modules; Homebrew uses a cask. On Windows npm's launcher is a
 *  .cmd shim and the native one is ~/.local/bin/claude.exe. */
export function installKind(bin: string, real: string, platform: NodeJS.Platform = process.platform): InstallKind {
  const r = real.replace(/\\/g, "/");
  if (r.includes("/.bun/")) return "bun";
  if (r.includes("/node_modules/@anthropic-ai/claude-code")) return "npm";
  if (r.includes("/Caskroom/")) return "homebrew";
  if (r.includes("/claude/versions/")) return "native";
  if (platform === "win32") {
    if (/\.(cmd|bat|ps1)$/i.test(bin)) return "npm";
    if (/\/\.local\/bin\/claude\.exe$/i.test(bin.replace(/\\/g, "/"))) return "native";
  }
  return "unknown";
}

/** Claude Code's own update lock, one per config dir: it cannot stop two
 *  profiles from updating the same npm install at once (anthropics/claude-code#93197).
 *  Claude Code treats one older than five minutes as stale. */
export const UPDATE_LOCK = ".update.lock";
export const UPDATE_LOCK_STALE_MS = 300_000;
export const NPM_RACE_ISSUE = "https://github.com/anthropics/claude-code/issues/93197";

export type WaitDeps = {
  find: () => ClaudeLaunch | undefined;
  /** Ages in ms of every update lock that exists. */
  lockAges: () => number[];
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  note: (msg: string) => void;
};

/** `claude`, waiting for it when it is missing. An npm-global update removes
 *  claude while it reinstalls. While a fresh update lock exists in any config
 *  dir, wait up to five minutes; otherwise allow a few seconds, then give up. */
export async function waitForClaude(
  deps: WaitDeps,
  graceMs = 5_000,
  maxMs = UPDATE_LOCK_STALE_MS,
  stepMs = 500,
): Promise<{ launch?: ClaudeLaunch; updating: boolean }> {
  const start = deps.now();
  let told = false;
  for (;;) {
    const launch = deps.find();
    const updating = deps.lockAges().some((age) => age < UPDATE_LOCK_STALE_MS);
    if (launch) return { launch, updating };
    if (deps.now() - start >= (updating ? maxMs : graceMs)) return { updating };
    if (updating && !told) {
      deps.note("claudep: waiting for a Claude Code update to finish");
      told = true;
    }
    await deps.sleep(stepMs);
  }
}

/** The config dirs whose update lock counts: the base and every profile. */
function configDirs(L: Layout): string[] {
  return [L.base, ...listProfileNames(L).map((n) => profileDir(L, n))];
}

function updateLockAges(L: Layout, now: number): number[] {
  const ages: number[] = [];
  for (const dir of configDirs(L)) {
    try {
      ages.push(now - statSync(join(dir, UPDATE_LOCK)).mtimeMs);
    } catch {}
  }
  return ages;
}

async function claudeLaunch(L: Layout): Promise<ClaudeLaunch> {
  const { launch, updating } = await waitForClaude({
    find: () => findClaude(),
    lockAges: () => updateLockAges(L, Date.now()),
    now: Date.now,
    sleep: (ms) => Bun.sleep(ms),
    note: (msg) => console.error(msg),
  });
  if (!launch)
    die(
      updating
        ? "`claude` is still missing after a Claude Code update ran for five minutes. Check the install: claude doctor"
        : "`claude` not found on PATH. Install Claude Code first: https://code.claude.com/docs/en/setup",
      EXIT.noClaude,
    );
  if (launch.kind === "ps1")
    die(
      `only ${launch.bin} was found. Install Claude Code with the native installer or npm so claude.exe or claude.cmd exists: https://code.claude.com/docs/en/setup`,
      EXIT.noClaude,
    );
  return launch;
}

async function spawnClaude(
  L: Layout,
  dir: string | undefined,
  args: string[],
  io: "inherit" | "pipe",
  env: Env = claudeEnv(L, dir),
) {
  const { cmd, verbatim } = claudeSpawn(await claudeLaunch(L), args);
  return Bun.spawn(cmd, {
    env,
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
  if (L.emptyConfigDir) deleteEnv(out, "CLAUDE_CONFIG_DIR", L.platform);
  // Variables a profile's claudep.env put in this shell are not the base's.
  for (const k of exportedEnvKeys(env)) deleteEnv(out, k, L.platform);
  deleteEnv(out, ENV_KEYS_VAR, L.platform);
  return out;
}

/** Marks a session claudep started, for `claudep current` and the StopFailure hook.
 *  CLAUDEP_RUN names the profile dir (removed for the base) and CLAUDEP_RUN_ID
 *  is this launch's nonce. An inherited CLAUDEP_AUTO goes, so a hook-pinned
 *  parent shell does not make the session look hook-pinned. */
export function runMarkers(
  env: Env,
  dir: string | undefined,
  runId: string,
  platform: NodeJS.Platform = process.platform,
): Env {
  const out: Env = { ...env };
  for (const k of ["CLAUDEP_AUTO", "CLAUDEP_RUN", "CLAUDEP_RUN_ID"]) deleteEnv(out, k, platform);
  if (dir !== undefined) out.CLAUDEP_RUN = dir;
  out.CLAUDEP_RUN_ID = runId;
  return out;
}

function claudeEnv(L: Layout, dir: string | undefined): Env {
  if (dir === undefined) return baseEnv(L);
  return withProfileVars(readProfileEnv(dir).vars, envFor(dir, process.env, L.platform), L.platform);
}

/** Runs claude in the foreground and exits with its code. With `name`, the
 *  run carries claudep's StopFailure hook: a clean exit clears the profile's
 *  marker, and a failure this run recorded in print mode exits 77 or 75. */
async function execClaude(L: Layout, dir: string | undefined, args: string[], name?: string): Promise<never> {
  const runId = crypto.randomUUID();
  const proc = await spawnClaude(L, dir, args, "inherit", runMarkers(claudeEnv(L, dir), dir, runId, L.platform));
  // Ctrl+C reaches the child through the terminal; keep the wrapper alive so
  // it can report the child's real exit code.
  const signals = wrapperSignals(L.platform);
  for (const s of signals.ignore) process.on(s, () => {});
  for (const s of signals.forward) process.on(s, () => proc.kill(s));
  await proc.exited;
  const code = proc.exitCode ?? 1;
  if (name === undefined) process.exit(code);
  const after = exitAfterRun(readFailure(L, name), runId, code, printMode(args));
  if (after.clear) rmSync(failurePath(L, name), { force: true });
  if (after.failure)
    console.error(`claudep: ${failureNote(name, after.failure, loginCommand(name, dir ? readLoginFlags(dir) : []))}`);
  process.exit(after.code);
}

/** Seconds a child `claude` gets in list, status, usage and doctor. */
export const DEFAULT_TIMEOUT_S = 30;
/** How long a child has between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 3_000;

/** The deadline from CLAUDEP_TIMEOUT, in ms: seconds, where 0 means none.
 *  Anything that is not a number of seconds keeps the default and is named in `bad`. */
export function claudeTimeoutMs(env: Env = process.env): { ms: number | undefined; bad?: string } {
  const raw = env.CLAUDEP_TIMEOUT;
  if (raw === undefined || raw.trim() === "") return { ms: DEFAULT_TIMEOUT_S * 1000 };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return { ms: DEFAULT_TIMEOUT_S * 1000, bad: raw };
  return { ms: n === 0 ? undefined : n * 1000 };
}

export type DeadlineDeps = {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
  kill: (signal: NodeJS.Signals) => void;
};

/** Waits for a child to exit. After `ms` it sends SIGTERM, then SIGKILL
 *  `graceMs` later. The grace lets a token refresh already in flight finish
 *  writing, because a hard kill there signs the profile out
 *  (anthropics/claude-code#95822). No `ms` means no deadline. */
export async function awaitWithDeadline(
  exited: Promise<number>,
  ms: number | undefined,
  graceMs: number,
  deps: DeadlineDeps,
): Promise<{ code: number; timedOut: boolean }> {
  if (ms === undefined) return { code: await exited, timedOut: false };
  let timedOut = false;
  let hard: unknown;
  const soft = deps.setTimer(() => {
    timedOut = true;
    deps.kill("SIGTERM");
    hard = deps.setTimer(() => deps.kill("SIGKILL"), graceMs);
  }, ms);
  try {
    return { code: await exited, timedOut };
  } finally {
    deps.clearTimer(soft);
    if (hard !== undefined) deps.clearTimer(hard);
  }
}

let timeoutWarned = false;

/** CLAUDEP_TIMEOUT for this process, warning once about a value it cannot use. */
function childTimeoutMs(): number | undefined {
  const { ms, bad } = claudeTimeoutMs();
  if (bad !== undefined && !timeoutWarned) {
    timeoutWarned = true;
    console.error(`claudep: CLAUDEP_TIMEOUT="${bad}" is not a number of seconds; using ${DEFAULT_TIMEOUT_S}`);
  }
  return ms;
}

/** Runs a short `claude` command and returns its stdout. stderr is read and
 *  dropped, so a chatty child never blocks on a full pipe. Past the
 *  CLAUDEP_TIMEOUT deadline the child is stopped and `out` is empty. */
async function captureClaude(
  L: Layout,
  dir: string | undefined,
  args: string[],
): Promise<{ code: number; out: string; timedOut: boolean }> {
  const proc = await spawnClaude(L, dir, args, "pipe");
  const out = new Response(proc.stdout).text().catch(() => "");
  void new Response(proc.stderr).text().catch(() => "");
  const { code, timedOut } = await awaitWithDeadline(proc.exited, childTimeoutMs(), KILL_GRACE_MS, {
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    kill: (signal) => proc.kill(signal),
  });
  return { code, out: timedOut ? "" : await out, timedOut };
}

export type AuthStatus = {
  loggedIn: boolean;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
  authMethod?: string;
  /** firstParty, bedrock, vertex, foundry. */
  apiProvider?: string;
  /** Where an API key came from, e.g. ANTHROPIC_API_KEY or apiKeyHelper. Absent without one. */
  apiKeySource?: string;
  /** The config dir Claude Code resolved (2.1.268+). */
  configDirectory?: string;
  /** Read from the profile's .claude.json instead of asking Claude Code. */
  cached?: boolean;
  /** Claude Code did not answer before the CLAUDEP_TIMEOUT deadline, so this is the .claude.json record. */
  timedOut?: boolean;
};

/** Before this Claude Code, a short command such as `claude auth status`
 *  could start an OAuth token refresh and exit before saving it, spending the
 *  refresh token and signing the profile out (anthropics/claude-code#95822,
 *  fixed in 2.1.301). claudep does not ask older versions. */
export const SAFE_AUTH_STATUS_FROM = "2.1.301";
export const AUTH_STATUS_ISSUE = "https://github.com/anthropics/claude-code/issues/95822";

/** True when `claude auth status` cannot sign a profile out. An unknown version is not trusted. */
export function authStatusSafe(v: Version | undefined): boolean {
  const from = parseVersion(SAFE_AUTH_STATUS_FROM);
  return v !== undefined && from !== undefined && !versionBelow(v, from);
}

/** The last account Claude Code recorded in a .claude.json: its name and
 *  organisation, never a credential. Says nothing about whether the login
 *  still works. */
export function cachedAuthStatus(globalJson: JsonObject | undefined): AuthStatus {
  const o = globalJson?.oauthAccount;
  if (!o || typeof o !== "object" || Array.isArray(o)) return { loggedIn: false, cached: true };
  const a = o as JsonObject;
  const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : undefined);
  return { loggedIn: true, email: str("emailAddress"), orgName: str("organizationName"), cached: true };
}

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
      apiProvider: str("apiProvider"),
      apiKeySource: str("apiKeySource"),
      configDirectory: str("configDirectory"),
    };
  } catch {
    return { loggedIn: false };
  }
}

async function claudeVersion(L: Layout): Promise<Version | undefined> {
  return parseVersion((await captureClaude(L, undefined, ["--version"])).out);
}

/** `claude auth status` when it is safe or `live` asks for it, otherwise
 *  the .claude.json record. A live call past the deadline falls back to the record. */
async function loginOf(L: Layout, dir: string | undefined, live: boolean): Promise<AuthStatus> {
  const cached = async () =>
    cachedAuthStatus(await readJson(dir === undefined ? L.baseGlobalJson : join(dir, ".claude.json")));
  if (!live) return cached();
  const { out, timedOut } = await captureClaude(L, dir, ["auth", "status", "--json"]);
  if (timedOut) return { ...(await cached()), timedOut: true };
  return parseAuthStatus(out);
}

/** The login flags a profile was created with: `--sso --email you@company.com`
 *  on one line. Flags and an address, never a credential. */
export const LOGIN_FILE = "claudep.login";
const LOGIN_EMAIL_RE = /^[A-Za-z0-9._%+@-]+$/;

/** The `auth login` flags in a claudep.login text. Only flags claudep itself
 *  writes survive, so a hand-edited file cannot put anything else in a printed
 *  command or a login. */
export function parseLoginFlags(text: string): string[] {
  const words = text.trim().split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string;
    if (w === "--sso" || w === "--console") out.push(w);
    else if (w === "--email" && LOGIN_EMAIL_RE.test(words[i + 1] ?? "")) out.push(w, words[++i] as string);
  }
  return out;
}

export function readLoginFlags(dir: string): string[] {
  return parseLoginFlags(readTrimmed(join(dir, LOGIN_FILE)) ?? "");
}

/** The command that logs a profile in with its saved flags. */
export function loginCommand(name: string, flags: readonly string[]): string {
  return ["claudep", name, "auth", "login", ...flags].join(" ");
}

/** Whether a profile already holds a login. Existence checks only (Never 3):
 *  the account recorded in .claude.json, plus the Keychain item on macOS or
 *  .credentials.json on Linux. On Windows the login may live in Credential
 *  Manager, so the account record is enough there. */
export async function hasStoredLogin(
  dir: string,
  platform: NodeJS.Platform = process.platform,
  deps: KeychainDeps = defaultKeychainDeps(),
): Promise<{ email?: string; orgName?: string } | undefined> {
  const account = cachedAuthStatus(await readJson(join(dir, ".claude.json")));
  if (!account.loggedIn) return undefined;
  if (platform === "darwin") return (await keychainHas(keychainService(dir), deps)) ? account : undefined;
  if (platform === "win32") return account;
  return credentialsFileHas(dir) ? account : undefined;
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

/** `strs` holds the last value of each value flag; `lists` every value, in order. */
export type Flags = { bools: Set<string>; strs: Map<string, string>; lists: Map<string, string[]>; rest: string[] };

export function parseFlags(args: string[], boolNames: readonly string[], strNames: readonly string[]): Flags {
  const flags: Flags = { bools: new Set(), strs: new Map(), lists: new Map(), rest: [] };
  const value = (name: string, v: string) => {
    flags.strs.set(name, v);
    flags.lists.set(name, [...(flags.lists.get(name) ?? []), v]);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (boolNames.includes(a)) {
      flags.bools.add(a);
    } else if (strNames.includes(a)) {
      const v = args[i + 1];
      if (v === undefined) die(`${a} requires a value`);
      value(a, v);
      i++;
    } else if (a.startsWith("--") && strNames.some((s) => a.startsWith(`${s}=`))) {
      const eq = a.indexOf("=");
      value(a.slice(0, eq), a.slice(eq + 1));
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
  const f = parseFlags(args, ...flagSpec("init"));
  const name = f.rest[0];
  if (!name)
    die(
      "usage: claudep init <name> [--copy-mcp] [--no-login] [--sso] [--email <e>] [--console] [--alias <cmd>] [--env KEY=VALUE]… [--force]",
    );
  const newVars = parseEnvEntries(f.lists.get("--env") ?? []);
  if (!existsSync(L.base)) die(`base config dir ${L.base} does not exist. Run \`claude\` once first`);
  const dir = profileDir(L, name);
  const fresh = !existsSync(dir);
  mkdirSync(dir, { recursive: true });
  console.log(`${c.bold(fresh ? "Creating" : "Updating")} profile ${c.bold(name)} at ${dir}`);

  let conflicts = 0;
  const accepted = readAccepted(dir);
  for (const item of sharedItems(L.base)) {
    if (accepted.has(item.name) && !f.bools.has("--force")) {
      console.log(`${c.dim("·")} ${item.name} ${c.dim("left as it is; doctor accepts it (--force links it)")}`);
      continue;
    }
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

  if (newVars.length) {
    writeFileSync(join(dir, ENV_FILE), editEnvText(readEnvText(dir), name, newVars, []));
    ok(`${ENV_FILE}: ${newVars.map(([k]) => k).join(", ")}`);
  }

  const alias = f.strs.get("--alias");
  if (alias !== undefined) writeAlias(L, name, alias);

  if (conflicts) warn(`${conflicts} item(s) need attention, see above`);

  const given: string[] = [];
  if (f.bools.has("--sso")) given.push("--sso");
  if (f.bools.has("--console")) given.push("--console");
  const email = f.strs.get("--email");
  if (email !== undefined) given.push("--email", email);
  // Saved even with --no-login, so the login that follows uses the same flags.
  const saved = parseLoginFlags(given.join(" "));
  if (saved.length) writeFileSync(join(dir, LOGIN_FILE), `${saved.join(" ")}\n`);
  const flags = saved.length ? saved : readLoginFlags(dir);

  const account = fresh ? undefined : await hasStoredLogin(dir, L.platform);
  if (account && (f.bools.has("--no-login") || !given.length)) {
    console.log(
      `\n${c.dim("·")} already logged in as ${account.email ?? "?"} (${account.orgName ?? "?"}). To log in again: ${loginCommand(name, flags)}`,
    );
    return;
  }
  if (f.bools.has("--no-login")) {
    console.log(`\nNext: ${c.bold(loginCommand(name, flags))}`);
    return;
  }
  // An address the saved file refuses still goes to this login as it was typed.
  const loginArgs = ["auth", "login", ...(given.length ? given : flags)];
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

export type ShimInfo = { profile: string; target: string };

/** The profile and claudep.ts a generated shim runs, or undefined for any other
 *  file. Both shim kinds carry the marker and `bun "<target>" run <name> -- `. */
export function parseShim(text: string): ShimInfo | undefined {
  if (!text.includes("generated by claudep")) return undefined;
  const m = /bun "([^"]+)" run ([a-z0-9][a-z0-9_-]*) -- /.exec(text);
  return m ? { target: m[1] as string, profile: m[2] as string } : undefined;
}

export type Shim = ShimInfo & { command: string; path: string; dir: string; kind: AliasKind };

/** Shims stay this small; a larger file is not read. Directories on PATH can
 *  hold thousands of binaries. */
const SHIM_MAX_BYTES = 1024;

/** PATH directories, first spelling of each real directory, in order. */
export function uniquePathDirs(dirs: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  const seen: string[] = [];
  const out: string[] = [];
  for (const dir of dirs) {
    let real = dir;
    try {
      real = realpathSync(dir);
    } catch {}
    if (seen.some((s) => samePath(s, real, platform))) continue;
    seen.push(real);
    out.push(dir);
  }
  return out;
}

/** Every claudep shim in `dirs`, in order. */
export function findShims(dirs: readonly string[], platform: NodeJS.Platform = process.platform): Shim[] {
  const P = pathApi(platform);
  const shims: Shim[] = [];
  for (const dir of uniquePathDirs(dirs, platform)) {
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      const isCmd = platform === "win32" && /\.cmd$/i.test(name);
      if (name.includes(".") && !isCmd) continue;
      const path = P.join(dir, name);
      try {
        if (statSync(path).size > SHIM_MAX_BYTES) continue;
        const info = parseShim(readFileSync(path, "utf8"));
        if (info)
          shims.push({
            ...info,
            command: isCmd ? name.slice(0, -4) : name,
            path,
            dir,
            kind: isCmd ? "cmd" : "sh",
          });
      } catch {}
    }
  }
  return shims;
}

export type ShimState = "ok" | "missing-target" | "other-target" | "missing-profile" | "shadowed";

export type ShimDeps = {
  /** The PATH directories, in order. */
  dirs: readonly string[];
  /** The claudep.ts that is running. */
  self: string;
  platform: NodeJS.Platform;
  exists: (p: string) => boolean;
  profileExists: (name: string) => boolean;
  realpath: (p: string) => string;
};

/** What is wrong with a shim, the worst first: a target gone or a profile gone
 *  cannot start claude; another target quietly runs another claudep; a shim
 *  behind an earlier PATH entry never runs at all. */
export function shimState(shim: Shim, deps: ShimDeps): ShimState {
  const P = pathApi(deps.platform);
  if (!deps.exists(shim.target)) return "missing-target";
  if (!deps.profileExists(shim.profile)) return "missing-profile";
  if (!samePath(deps.realpath(shim.target), deps.self, deps.platform)) return "other-target";
  const names =
    deps.platform === "win32"
      ? [shim.command, `${shim.command}.exe`, `${shim.command}.cmd`, `${shim.command}.bat`]
      : [shim.command];
  for (const dir of uniquePathDirs(deps.dirs, deps.platform)) {
    if (samePath(dir, shim.dir, deps.platform)) break;
    if (names.some((n) => deps.exists(P.join(dir, n)))) return "shadowed";
  }
  return "ok";
}

/** The directories `alias` and `rm` look in: PATH, then where a new shim would go. */
function shimDirs(L: Layout): string[] {
  return uniquePathDirs([...splitPathVar(process.env.PATH ?? "", L.platform), aliasDir()], L.platform);
}

function shimDeps(L: Layout): ShimDeps {
  return {
    dirs: shimDirs(L),
    self: realpathSync(Bun.main),
    platform: L.platform,
    exists: existsSync,
    profileExists: (n) => n === "default" || n === "base" || profileExists(L, n),
    realpath: (p) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    },
  };
}

/** Write the shim(s) for `<cmd>`: `claudep run <name> -- "$@"`. Rewrites a
 *  generated shim of that name wherever it sits on PATH, because after an
 *  install switch the stale one is in the old directory and would keep winning.
 *  A new shim goes next to the claudep on PATH. Any other file is left alone. */
function writeAlias(L: Layout, name: string, cmd: string): void {
  if (!NAME_RE.test(cmd)) die(`invalid alias command name "${cmd}"`);
  if (cmd === "claude" || cmd === "claudep") die(`"${cmd}" is the command a shim runs; pick another name`);
  const self = realpathSync(Bun.main);
  const found = findShims(shimDirs(L), L.platform).filter((s) => s.command === cmd);
  const dirs = found.length
    ? uniquePathDirs(
        found.map((s) => s.dir),
        L.platform,
      )
    : [aliasDir()];
  for (const dir of dirs) {
    for (const { path: dest, kind } of aliasFiles(dir, cmd, L.platform)) {
      const text = aliasShim(kind, self, name);
      try {
        let rewrite = false;
        let st: ReturnType<typeof lstatSync> | undefined;
        try {
          st = lstatSync(dest);
        } catch {}
        // A symlink, dangling or not, is someone's command: writing would follow it.
        if (st && !st.isFile()) {
          warn(`${dest} already exists. Not overwriting; remove it first to regenerate`);
          continue;
        }
        if (st && st.size > 0) {
          const current = readFileSync(dest, "utf8");
          if (current === text) {
            console.log(`${c.dim("·")} alias ${cmd} ${c.dim(`already runs profile ${name} (${dest})`)}`);
            continue;
          }
          if (!parseShim(current)) {
            warn(`${dest} already exists. Not overwriting; remove it first to regenerate`);
            continue;
          }
          rewrite = true;
        }
        writeFileSync(dest, text);
        if (kind === "sh") chmodSync(dest, 0o755);
        ok(`alias ${c.bold(cmd)} → profile ${name} (${rewrite ? "rewrote " : ""}${dest})`);
      } catch (e) {
        warn(`could not write ${dest}: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    }
  }
  if (!onPath(aliasDir(), undefined, L.platform)) warn(`${aliasDir()} is not on your PATH`);
}

function printAliases(L: Layout, json: boolean): void {
  const deps = shimDeps(L);
  const rows = findShims(deps.dirs, L.platform).map((s) => ({ ...s, state: shimState(s, deps) }));
  if (json) {
    const out = rows.map(({ command, profile, target, path, kind, state }) => ({
      command,
      profile,
      target,
      path,
      kind,
      state,
    }));
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (!rows.length) {
    console.log(c.dim("No alias shims on PATH. Create one: claudep alias <profile> <command>"));
    return;
  }
  const cols = ["COMMAND", "PROFILE", "STATE", "TARGET", "FILE"];
  const data = rows.map((r) => [
    r.command,
    r.profile,
    r.state,
    shortHome(r.target, L.home, L.platform),
    shortHome(r.path, L.home, L.platform),
  ]);
  const widths = cols.map((h, i) => Math.max(h.length, ...data.map((d) => (d[i] as string).length)));
  const fmt = (cells: string[]) => cells.map((v, i) => v.padEnd(widths[i] as number)).join("  ");
  console.log(c.bold(fmt(cols)));
  for (const d of data) console.log(fmt(d));
}

async function cmdAlias(L: Layout, args: string[]): Promise<void> {
  const f = parseFlags(args, ...flagSpec("alias"));
  const [name, cmd] = f.rest;
  if (!name) return printAliases(L, f.bools.has("--json"));
  if (!cmd)
    die(
      "usage: claudep alias [--json]   or   claudep alias <profile> <command>   e.g. claudep alias enterprise eclaude",
    );
  if (!profileExists(L, name)) die(`profile "${name}" does not exist. Run: claudep init ${name}`);
  writeAlias(L, name, cmd);
}

function warnSecureStorage(L: Layout, dir: string, name: string): void {
  const target = secureStorageOverride(dir, process.env, L.home, L.platform);
  if (target !== undefined)
    console.error(
      `claudep: ${SECURE_STORAGE_ENV} is set, so Claude Code keeps the "${name}" login in ${target}. Unset it to use the profile's own`,
    );
}

function warnSkippedEnv(dir: string): void {
  const { skipped } = readProfileEnv(dir);
  if (skipped.length)
    console.error(
      `claudep: ${join(dir, ENV_FILE)}: lines ${skipped.join(", ")} are not KEY=VALUE with an allowed name and a value; nothing reads them`,
    );
}

async function cmdRun(L: Layout, args: string[]): Promise<never> {
  const name = args[0];
  if (!name) die("usage: claudep run <name> [claude args…]", EXIT.usage);
  const rest = args.slice(1);
  if (rest[0] === "--") rest.shift();
  if (name === "default" || name === "base") {
    if (L.emptyConfigDir) die(EMPTY_CONFIG_DIR_MESSAGE, EXIT.config);
    warnSecureStorage(L, L.base, name);
    if (passesSettings(rest)) return execClaude(L, undefined, rest);
    const settings = runSettings(undefined, {}, stopFailureCommand(process.execPath, import.meta.path, L.platform));
    if (settings) rest.unshift("--settings", JSON.stringify(settings));
    return execClaude(L, undefined, rest, "default");
  }
  const dir = profileDir(L, name);
  if (!existsSync(dir)) die(`profile "${name}" does not exist. Run: claudep init ${name}`, EXIT.noProfile);
  for (const v of authEnvOverrides(process.env, L.platform))
    console.error(`claudep: ${v} is set; Claude Code will use it instead of the "${name}" login`);
  warnSecureStorage(L, dir, name);
  warnSkippedEnv(dir);
  // A base that came from a custom CLAUDE_CONFIG_DIR in this shell is not the
  // one this profile was built on, so it does not get new links from a launch.
  if (L.callerConfigDir === undefined || L.managed)
    for (const item of healLinks(L.base, dir, readAccepted(dir))) console.error(`claudep: linked ${item} into ${name}`);
  const overlay = readProfileSettings(dir);
  if (overlay.error)
    die(
      `${join(dir, SETTINGS_FILE)}: ${overlay.error}. Fix it, or: claudep settings ${name} --unset <key>`,
      EXIT.config,
    );
  if (passesSettings(rest)) {
    if (Object.keys(overlay.settings).length)
      console.error(`claudep: you passed --settings, so ${join(dir, SETTINGS_FILE)} is not applied`);
    return execClaude(L, dir, rest);
  }
  const settings = runSettings(
    memoryDirOverride(dir, process.cwd(), rest, process.env, L.platform),
    overlay.settings,
    stopFailureCommand(process.execPath, import.meta.path, L.platform),
  );
  if (settings) rest.unshift("--settings", JSON.stringify(settings));
  return execClaude(L, dir, rest, name);
}

/** The caller passed its own --settings, which replaces claudep's overlay and hook. */
function passesSettings(args: readonly string[]): boolean {
  return args.some((a) => a === "--settings" || a.startsWith("--settings="));
}

export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The newest session transcript Claude Code keeps for `cwd`, by mtime.
 *  Transcripts live in projects/<slug of the launch directory>/<id>.jsonl,
 *  keyed by the directory itself, not its git root as auto memory is. */
export function latestSession(
  projectsDir: string,
  cwd: string,
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): { id: string; mtimeMs: number; dir: string } | undefined {
  const P = pathApi(platform);
  const dir = P.join(projectsDir, projectSlug(P.resolve(cwd).normalize("NFC"), env));
  let best: { id: string; mtimeMs: number; dir: string } | undefined;
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const f of files) {
    const id = f.replace(/\.jsonl$/, "");
    if (id === f || !SESSION_ID_RE.test(id)) continue;
    const mtimeMs = statSync(P.join(dir, f)).mtimeMs;
    if (!best || mtimeMs > best.mtimeMs) best = { id, mtimeMs, dir };
  }
  return best;
}

/** `claudep handoff <name> [session-id] [-- claude args]`: carry on this
 *  directory's latest session under another profile. projects/ is shared,
 *  so the other profile can read the transcript; --fork-session gives it a
 *  new id so two processes never append to one file. */
async function cmdHandoff(L: Layout, args: string[]): Promise<never> {
  const usage = "usage: claudep handoff <name> [session-id] [-- claude args…]";
  const name = args[0];
  if (!name || name.startsWith("-")) die(usage, EXIT.usage);
  let rest = args.slice(1);
  let id: string | undefined;
  if (rest[0] !== undefined && rest[0] !== "--") {
    id = rest.shift();
    if (!id || !SESSION_ID_RE.test(id)) die(`"${id}" is not a session id. ${usage}`, EXIT.usage);
  }
  if (rest[0] === "--") rest = rest.slice(1);
  const target = name === "default" || name === "base" ? L.base : profileDir(L, name);
  if (target !== L.base && !existsSync(target))
    die(`profile "${name}" does not exist. Run: claudep init ${name}`, EXIT.noProfile);
  const projects = sharedItems(L.base).find((s) => s.name === "projects");
  if (!projects || (target !== L.base && linkState(L.base, target, projects) !== "ok"))
    die(`projects/ is not shared with "${name}", so it cannot read this session. Run: claudep init ${name}`);
  if (!id) {
    const latest = latestSession(join(L.base, "projects"), process.cwd(), process.env, L.platform);
    if (!latest) die(`no session for this directory in ${join(L.base, "projects")}. Pass a session id`);
    id = latest.id;
    const mins = Math.max(0, Math.round((Date.now() - latest.mtimeMs) / 60_000));
    console.error(`claudep: handing session ${id} (last written ${mins} min ago) to "${name}" as a new forked session`);
  }
  return cmdRun(L, [name, "--", "--resume", id, "--fork-session", ...rest]);
}

export type Row = { name: string; dir: string; status: AuthStatus; failure?: Failure };

async function collectRows(L: Layout, names: string[], live: boolean): Promise<{ rows: Row[]; v?: Version }> {
  const v = await claudeVersion(L);
  const ask = live || authStatusSafe(v);
  const rows = await Promise.all(
    names.map(async (name) => {
      const dir = name === "default" ? L.base : profileDir(L, name);
      const failure = readFailure(L, name);
      return {
        name,
        dir,
        status: await loginOf(L, name === "default" ? undefined : dir, ask),
        ...(failure ? { failure } : {}),
      };
    }),
  );
  return { rows, v };
}

/** The footnote under a table built from .claude.json. */
function cachedNote(v: Version | undefined): string {
  return `* from .claude.json, not asked live: Claude Code ${v?.join(".") ?? "of unknown version"} can sign a profile out on a short \`claude auth status\` (${AUTH_STATUS_ISSUE}, fixed in ${SAFE_AUTH_STATUS_FROM}). Update Claude Code, or pass --live`;
}

export function formatTable(rows: Row[], home: string, platform: NodeJS.Platform = process.platform): string[] {
  const cols = ["PROFILE", "LOGIN", "EMAIL", "ORG", "PLAN", "DIR"];
  const data = rows.map((r) => [
    r.name,
    failureKind(r.failure?.error ?? "") === "login"
      ? "needs login"
      : r.status.timedOut
        ? "timeout"
        : `${r.status.loggedIn ? "yes" : "no"}${r.status.cached ? "*" : ""}`,
    r.status.email ?? "-",
    r.status.orgName ?? "-",
    r.status.subscriptionType ?? "-",
    shortHome(r.dir, home, platform),
  ]);
  const widths = cols.map((h, i) => Math.max(h.length, ...data.map((d) => (d[i] as string).length)));
  const fmt = (cells: string[]) => cells.map((v, i) => v.padEnd(widths[i] as number)).join("  ");
  return [fmt(cols), ...data.map((d) => fmt(d))];
}

function printTable(rows: Row[], home: string, platform: NodeJS.Platform, v: Version | undefined): void {
  const [header, ...lines] = formatTable(rows, home, platform);
  console.log(c.bold(header as string));
  lines.forEach((line, i) => {
    console.log(rows[i]?.status.loggedIn ? line : c.dim(line));
  });
  if (rows.some((r) => r.status.cached && !r.status.timedOut)) console.log(c.dim(`\n${cachedNote(v)}`));
  if (rows.some((r) => r.status.timedOut)) console.log(c.dim(`\n${timeoutNote()}`));
  const failed = rows.filter((r) => r.failure);
  if (failed.length) console.log("");
  for (const r of failed)
    if (r.failure)
      console.log(
        c.yellow(
          failureNote(r.name, r.failure, loginCommand(r.name, r.name === "default" ? [] : readLoginFlags(r.dir))),
        ),
      );
}

/** The footnote under a row whose `claude` ran past the deadline. */
function timeoutNote(): string {
  const ms = claudeTimeoutMs().ms;
  const secs = ms === undefined ? "" : ` within ${ms / 1000} s`;
  return `timeout: claude did not answer${secs}, so the row shows the account in .claude.json. Raise the limit with CLAUDEP_TIMEOUT=<seconds>`;
}

/** The flat object `status --json` prints for one row; `list --json` prints an array of them. */
function rowJson(row: Row): JsonObject {
  const failure = row.failure ? { failure: { error: row.failure.error, at: row.failure.at } } : {};
  return { name: row.name, dir: row.dir, ...row.status, ...failure };
}

async function cmdList(L: Layout, args: string[]): Promise<void> {
  const f = parseFlags(args, ...flagSpec("list"));
  const names = ["default", ...listProfileNames(L)];
  const { rows, v } = await collectRows(L, names, f.bools.has("--live"));
  if (f.bools.has("--json")) {
    console.log(JSON.stringify(rows.map(rowJson), null, 2));
    return;
  }
  printTable(rows, L.home, L.platform, v);
  if (names.length === 1) console.log(c.dim("\nNo profiles yet. Create one: claudep init <name>"));
  const cur = currentProfile(L);
  if (cur.kind !== "base") console.log(c.dim(`\nactive in this shell: ${describeCurrent(cur)}`));
}

async function cmdStatus(L: Layout, args: string[]): Promise<void> {
  const f = parseFlags(args, ...flagSpec("status"));
  const name = f.rest[0];
  if (!name) die("usage: claudep status <name> [--json]");
  if (name !== "default" && !profileExists(L, name)) die(`profile "${name}" does not exist`);
  const {
    rows: [row],
    v,
  } = await collectRows(L, [name], f.bools.has("--live"));
  if (!row) return;
  if (f.bools.has("--json")) {
    console.log(JSON.stringify(rowJson(row), null, 2));
    return;
  }
  printTable([row], L.home, L.platform, v);
  if (!row.status.loggedIn && !row.failure && name !== "default")
    console.log(c.dim(`\nLog in: ${loginCommand(name, readLoginFlags(row.dir))}`));
}

function envUsage(syntax: EnvSyntax): string {
  if (syntax === "powershell")
    return "usage: claudep env <name> | Invoke-Expression   or   claudep env --unset | Invoke-Expression";
  if (syntax === "fish") return "usage: claudep env <name> | source   or   claudep env --unset | source";
  return 'usage: eval "$(claudep env <name>)"   or   eval "$(claudep env --unset)"   (add --shell fish|powershell|sh when the shell was not detected)';
}

/** The line that clears a pin, in the syntax of the shell the user is in. */
export function envUnsetHint(syntax: EnvSyntax): string {
  if (syntax === "powershell") return "claudep env --unset | Invoke-Expression";
  if (syntax === "fish") return "claudep env --unset | source";
  return 'eval "$(claudep env --unset)"';
}

function cmdEnv(L: Layout, args: string[]): void {
  const f = parseFlags(args, ...flagSpec("env"));
  const forced = f.strs.get("--shell");
  const syntax =
    forced === undefined ? shellSyntax(process.env, L.platform, parentProcessName(L.platform)) : envSyntaxOf(forced);
  if (!syntax) die(`unsupported shell "${forced}". Use sh, zsh, bash, fish or powershell`);
  if (f.bools.has("--unset")) {
    process.stdout.write(envScript(undefined, syntax, { clear: exportedEnvKeys(process.env), set: [] }));
    return;
  }
  const name = f.rest[0];
  if (!name) die(envUsage(syntax));
  const dir = profileDir(L, name);
  if (!existsSync(dir)) die(`profile "${name}" does not exist`);
  warnSkippedEnv(dir);
  const { vars } = readProfileEnv(dir);
  const plan = envPlan(vars, process.env, L.platform);
  for (const [k] of vars)
    if (!plan.set.some(([s]) => s === k)) console.error(`claudep: ${k} is already set in this shell; leaving it`);
  process.stdout.write(envScript(dir, syntax, plan));
}

/** KEY=VALUE arguments, or exit with every reason one is refused. */
function parseEnvEntries(entries: readonly string[]): EnvVar[] {
  const out: EnvVar[] = [];
  const errors: string[] = [];
  for (const entry of entries) {
    const r = validateEnvEntry(entry);
    if (typeof r === "string") errors.push(r);
    else out.push(r);
  }
  if (errors.length) die(errors.join("\n       "));
  return out;
}

/** A claudep.env text with `set` applied and `unset` removed, edited in place:
 *  comments and lines claudep skips stay, a key keeps its line, a new key goes
 *  last. `undefined` text starts a new file. */
export function editEnvText(
  text: string | undefined,
  name: string,
  set: readonly EnvVar[],
  unset: readonly string[],
): string {
  const lines = (text ?? envFileText(name, [])).split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const pending = new Map(set);
  const placed = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    const eq = t.indexOf("=");
    const key = t.startsWith("#") || eq === -1 ? "" : t.slice(0, eq);
    if (!ENV_KEY_RE.test(key)) out.push(line);
    else if (unset.includes(key) || placed.has(key)) continue;
    else if (pending.has(key)) {
      out.push(`${key}=${pending.get(key)}`);
      placed.add(key);
    } else out.push(line);
  }
  for (const [k, v] of pending) if (!placed.has(k)) out.push(`${k}=${v}`);
  return `${out.join("\n")}\n`;
}

function readEnvText(dir: string): string | undefined {
  try {
    return readFileSync(join(dir, ENV_FILE), "utf8");
  } catch {
    return undefined;
  }
}

function cmdVars(L: Layout, args: string[]): void {
  const f = parseFlags(args, ...flagSpec("vars"));
  const [name, ...rest] = f.rest;
  if (!name) die("usage: claudep vars <name> [KEY=VALUE…] | --unset KEY… | --json");
  const dir = profileDir(L, name);
  if (!existsSync(dir)) die(`profile "${name}" does not exist. Run: claudep init ${name}`);
  const file = join(dir, ENV_FILE);
  const { vars, skipped } = readProfileEnv(dir);
  if (!rest.length) {
    if (f.bools.has("--unset")) die("usage: claudep vars <name> --unset KEY…");
    if (f.bools.has("--json")) console.log(JSON.stringify(Object.fromEntries(vars), null, 2));
    else for (const [k, v] of vars) console.log(`${k}=${v}`);
    if (skipped.length) console.error(`claudep: ${file} has lines it skips: ${skipped.join(", ")}`);
    return;
  }
  let text: string;
  if (f.bools.has("--unset")) {
    const bad = rest.filter((k) => !ENV_KEY_RE.test(k));
    if (bad.length) die(`not variable names: ${bad.join(", ")}`);
    text = editEnvText(readEnvText(dir), name, [], rest);
  } else text = editEnvText(readEnvText(dir), name, parseEnvEntries(rest), []);
  const next = parseEnvFile(text);
  // Nothing left but claudep's own header: drop the file.
  if (next.vars.length || next.skipped.length || text !== envFileText(name, [])) writeFileSync(file, text);
  else rmSync(file, { force: true });
  ok(next.vars.length ? `${name}: ${next.vars.map(([k]) => k).join(", ")}` : `${name}: no variables`);
  if (L.activeProfile === name || exportedEnvKeys(process.env).length)
    console.log(
      `${c.dim("·")} this shell picks the change up on the next cd into a pinned directory, or from: claudep env ${name}`,
    );
}

/** Settings `claudep run` passes a profile through --settings, on top of the
 *  shared settings.json. Flag settings rank above user and project settings
 *  and below managed ones. Plain `claude` in a pinned shell does not see them. */
export const SETTINGS_FILE = "claudep.settings.json";
const SETTING_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Why a settings key is refused, or undefined. `env` belongs in claudep vars,
 *  where the credential and CLAUDE_CONFIG_DIR rules apply. */
export function refusedSettingKey(key: string): string | undefined {
  if (!SETTING_KEY_RE.test(key)) return `"${key}" is not a settings key`;
  if (key === "env") return "env is not allowed here: set variables with claudep vars";
  return undefined;
}

/** `key=value`: the value is JSON when it parses (false, 3, {"a":1}), otherwise a string. */
export function parseSettingEntry(entry: string): [string, unknown] {
  const eq = entry.indexOf("=");
  if (eq < 1) die(`expected key=value, got "${entry}"`);
  const key = entry.slice(0, eq);
  const why = refusedSettingKey(key);
  if (why) die(why);
  const raw = entry.slice(eq + 1);
  try {
    return [key, JSON.parse(raw)];
  } catch {
    return [key, raw];
  }
}

/** A profile's settings overlay: an object, or the reason it cannot be used. */
export function readProfileSettings(dir: string): { settings: JsonObject; error?: string } {
  let text: string;
  try {
    text = readFileSync(join(dir, SETTINGS_FILE), "utf8");
  } catch {
    return { settings: {} };
  }
  try {
    const j: unknown = JSON.parse(text);
    if (!j || typeof j !== "object" || Array.isArray(j)) return { settings: {}, error: "not a JSON object" };
    const bad = Object.keys(j).map(refusedSettingKey).find(Boolean);
    return bad ? { settings: {}, error: bad } : { settings: j as JsonObject };
  } catch {
    return { settings: {}, error: "not valid JSON" };
  }
}

/** The --settings value `run` passes: the auto-memory path, then the profile's
 *  overlay, which wins, then claudep's StopFailure hook added to any the overlay
 *  has. Flag-settings hooks run alongside the user's own (checked on 2.1.322). */
export function runSettings(
  memoryDir: string | undefined,
  overlay: JsonObject,
  stopFailureHook?: string,
): JsonObject | undefined {
  const out: JsonObject = { ...(memoryDir === undefined ? {} : { autoMemoryDirectory: memoryDir }), ...overlay };
  const own = overlay.hooks;
  const ownIsObject = own !== undefined && own !== null && typeof own === "object" && !Array.isArray(own);
  if (stopFailureHook !== undefined && (own === undefined || ownIsObject)) {
    const hooks: JsonObject = ownIsObject ? { ...(own as JsonObject) } : {};
    const prior = Array.isArray(hooks.StopFailure) ? (hooks.StopFailure as unknown[]) : [];
    hooks.StopFailure = [...prior, stopFailureEntry(stopFailureHook)];
    out.hooks = hooks;
  }
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------------------
// StopFailure markers. Claude Code runs StopFailure hooks when a turn ends on
// an API error, with the error's name and no token. claudep's hook writes that
// name to <profiles root>/.health/<name>.json, so list, status and doctor can
// say a profile needs a login, and run can exit 77 or 75 instead of 1.
// ---------------------------------------------------------------------------

/** StopFailure errors that mean the login or the account needs a person (exit 77). */
export const LOGIN_FAILURES = [
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
  "cloud_credential_error",
] as const;
/** StopFailure errors that mean a usage or spend limit (exit 75). */
export const LIMIT_FAILURES = ["rate_limit", "billing_error"] as const;
export const STOP_FAILURE_MATCHER = [...LOGIN_FAILURES, ...LIMIT_FAILURES].join("|");

export type Failure = { error: string; at: number; run?: string };

export function failureKind(error: string): "login" | "limit" | undefined {
  if ((LOGIN_FAILURES as readonly string[]).includes(error)) return "login";
  if ((LIMIT_FAILURES as readonly string[]).includes(error)) return "limit";
  return undefined;
}

/** The hook command: bun and claudep.ts by absolute path, quoted for sh, which
 *  is what Claude Code runs hooks in (Git Bash on Windows, hence the slashes). */
export function stopFailureCommand(bun: string, script: string, platform: NodeJS.Platform = process.platform): string {
  const q = (p: string) => `"${(platform === "win32" ? p.replace(/\\/g, "/") : p).replace(/(["\\$`])/g, "\\$1")}"`;
  return `${q(bun)} ${q(script)} hook stop-failure`;
}

function stopFailureEntry(command: string): JsonObject {
  return { matcher: STOP_FAILURE_MATCHER, hooks: [{ type: "command", command }] };
}

export function failurePath(L: Layout, name: string): string {
  return pathApi(L.platform).join(L.profilesRoot, ".health", `${name}.json`);
}

export function readFailure(L: Layout, name: string): Failure | undefined {
  try {
    const j: unknown = JSON.parse(readFileSync(failurePath(L, name), "utf8"));
    if (!j || typeof j !== "object") return undefined;
    const o = j as JsonObject;
    if (typeof o.error !== "string" || typeof o.at !== "number") return undefined;
    return { error: o.error, at: o.at, ...(typeof o.run === "string" ? { run: o.run } : {}) };
  } catch {
    return undefined;
  }
}

/** The profile a hook call belongs to: the one CLAUDEP_RUN names, else the
 *  active profile, else `default` when no CLAUDE_CONFIG_DIR is set. A custom
 *  config dir outside the profiles root has no name and records nothing. */
export function hookProfile(L: Layout, env: Env = process.env): string | undefined {
  const run = env.CLAUDEP_RUN;
  if (run) {
    const dir = canon(run, L.home, L.platform);
    const P = pathApi(L.platform);
    const name = P.basename(dir);
    if (samePath(P.dirname(dir), L.profilesRoot, L.platform) && NAME_RE.test(name) && !RESERVED.has(name)) return name;
    return undefined;
  }
  if (L.activeProfile !== undefined) return L.activeProfile;
  if (L.callerConfigDir === undefined && !L.emptyConfigDir) return "default";
  return undefined;
}

/** What `run` exits with once claude has: a clean exit clears the marker;
 *  in print mode, a failure this run recorded becomes 77 or 75. */
export function exitAfterRun(
  failure: Failure | undefined,
  runId: string,
  code: number,
  print: boolean,
): { code: number; clear: boolean; failure?: Failure } {
  if (code === 0) return { code, clear: failure !== undefined };
  if (!print || failure === undefined || failure.run !== runId) return { code, clear: false };
  const kind = failureKind(failure.error);
  if (kind === undefined) return { code, clear: false };
  return { code: kind === "login" ? EXIT.login : EXIT.limit, clear: false, failure };
}

/** True when the claude args ask for print mode, which is how scripts run it. */
export function printMode(args: readonly string[]): boolean {
  for (const a of args) {
    if (a === "--") return false;
    if (a === "-p" || a === "--print") return true;
  }
  return false;
}

/** "Nov 12, 9:14 PM" in local time. */
function seenText(at: number): string {
  return new Date(at * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function failureNote(name: string, f: Failure, login: string): string {
  const kind = failureKind(f.error);
  if (kind === "login") return `${name} needs a login: ${f.error}, seen ${seenText(f.at)}. Log in: ${login}`;
  return `${name} hit a limit: ${f.error}, seen ${seenText(f.at)}`;
}

/** `claudep hook stop-failure`: Claude Code's StopFailure hook. Reads the hook
 *  JSON on stdin and writes the error's name. No output, no subprocess, no
 *  network, and it never fails the hook. `--print` shows the settings that
 *  call it, for shells that start plain claude; claudep never writes them. */
async function cmdHook(L: Layout, args: string[]): Promise<void> {
  const f = parseFlags(args, ...flagSpec("hook"));
  const command = stopFailureCommand(process.execPath, import.meta.path, L.platform);
  if (f.bools.has("--print")) {
    console.log(JSON.stringify({ hooks: { StopFailure: [stopFailureEntry(command)] } }, null, 2));
    return;
  }
  if (f.rest[0] !== "stop-failure")
    die("usage: claudep hook stop-failure < hook.json   or   claudep hook --print", EXIT.usage);
  try {
    const input: unknown = JSON.parse(await Bun.stdin.text());
    const error = input && typeof input === "object" ? (input as JsonObject).error : undefined;
    const name = hookProfile(L);
    if (typeof error !== "string" || failureKind(error) === undefined || name === undefined) return;
    const file = failurePath(L, name);
    mkdirSync(pathApi(L.platform).dirname(file), { recursive: true });
    const run = process.env.CLAUDEP_RUN_ID;
    const record: Failure = { error, at: Math.floor(Date.now() / 1000), ...(run ? { run } : {}) };
    writeFileSync(file, `${JSON.stringify(record)}\n`);
  } catch {}
}

function cmdSettings(L: Layout, args: string[]): void {
  const f = parseFlags(args, ...flagSpec("settings"));
  const [name, ...rest] = f.rest;
  if (!name) die("usage: claudep settings <name> [key=value…] | --unset key… | --json");
  if (name === "default" || name === "base")
    die(`the default profile reads ${join(L.base, "settings.json")} directly; edit that file`);
  const dir = profileDir(L, name);
  if (!existsSync(dir)) die(`profile "${name}" does not exist. Run: claudep init ${name}`);
  const file = join(dir, SETTINGS_FILE);
  const { settings, error } = readProfileSettings(dir);
  if (error) die(`${file}: ${error}. Fix or remove it`);
  if (!rest.length) {
    if (f.bools.has("--unset")) die("usage: claudep settings <name> --unset key…");
    if (f.bools.has("--json")) console.log(JSON.stringify(settings, null, 2));
    else for (const [k, v] of Object.entries(settings)) console.log(`${k}=${JSON.stringify(v)}`);
    return;
  }
  const next: JsonObject = { ...settings };
  if (f.bools.has("--unset")) for (const k of rest) delete next[k];
  else for (const [k, v] of rest.map(parseSettingEntry)) next[k] = v;
  if (Object.keys(next).length) writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  else rmSync(file, { force: true });
  ok(Object.keys(next).length ? `${name}: ${Object.keys(next).join(", ")}` : `${name}: no settings`);
}

function describeCurrent(cur: Current): string {
  const label = currentLabel(cur);
  const how =
    cur.setBy === "hook"
      ? "shell hook"
      : cur.setBy === "run"
        ? "claudep run"
        : cur.setBy === "manual"
          ? "manual pin"
          : "nothing pinned";
  return `${label} (${how})`;
}

/** The one-word answer: the profile name, `default` for the base, `custom` otherwise. */
export function currentLabel(cur: Current): string {
  return cur.kind === "profile" ? (cur.name ?? "?") : cur.kind === "custom" ? "custom" : "default";
}

// ---------------------------------------------------------------------------
// Usage limits. Claude Code hands every statusline command a JSON document
// whose rate_limits carry the account's five-hour and weekly windows, so
// claudep can show and remember them without ever touching a token.
// ---------------------------------------------------------------------------

/** `resetsAt` is epoch seconds (the statusline); `resets` is Claude Code's own text (`/usage`). */
export type UsageWindow = { usedPercentage: number; resetsAt?: number; resets?: string };
/** `at` is when the numbers were seen, in epoch seconds; `source` says how.
 *  `models` holds per-model weekly windows, which only `/usage` reports. */
export type Usage = {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  models?: Record<string, UsageWindow>;
  at: number;
  source: "statusline" | "usage";
};

/** One window from the statusline's rate_limits: used_percentage 0 to 100, resets_at in epoch seconds. */
function usageWindow(v: unknown): UsageWindow | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as JsonObject;
  if (typeof o.used_percentage !== "number" || typeof o.resets_at !== "number") return undefined;
  return { usedPercentage: o.used_percentage, resetsAt: o.resets_at };
}

/** The usage in a statusline payload. Absent for API-key, Bedrock and Vertex
 *  sessions and before the first response, and each window can be missing. */
export function statuslineUsage(payload: string, now: number): Usage | undefined {
  let j: unknown;
  try {
    j = JSON.parse(payload);
  } catch {
    return undefined;
  }
  const rl = j && typeof j === "object" ? (j as JsonObject).rate_limits : undefined;
  if (!rl || typeof rl !== "object") return undefined;
  const fiveHour = usageWindow((rl as JsonObject).five_hour);
  const sevenDay = usageWindow((rl as JsonObject).seven_day);
  if (!fiveHour && !sevenDay) return undefined;
  return { fiveHour, sevenDay, at: now, source: "statusline" };
}

/** `work · 5h 23% · 7d 41%`, leaving out what is not known. */
export function usageSegment(name: string, u: Usage | undefined): string {
  const parts = [name];
  if (u?.fiveHour) parts.push(`5h ${Math.round(u.fiveHour.usedPercentage)}%`);
  if (u?.sevenDay) parts.push(`7d ${Math.round(u.sevenDay.usedPercentage)}%`);
  return parts.join(" · ");
}

/** Where a profile's last seen usage is kept: claudep's own root, never ~/.claude. */
export function usageCachePath(L: Layout, name: string): string {
  return pathApi(L.platform).join(L.profilesRoot, ".usage", `${name}.json`);
}

function cachedWindow(v: unknown): UsageWindow | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as JsonObject;
  if (typeof o.usedPercentage !== "number") return undefined;
  const w: UsageWindow = { usedPercentage: o.usedPercentage };
  if (typeof o.resetsAt === "number") w.resetsAt = o.resetsAt;
  if (typeof o.resets === "string") w.resets = o.resets;
  return w;
}

export async function readUsageCache(L: Layout, name: string): Promise<Usage | undefined> {
  const j = await readJson(usageCachePath(L, name));
  if (!j || typeof j.at !== "number") return undefined;
  const u: Usage = {
    fiveHour: cachedWindow(j.fiveHour),
    sevenDay: cachedWindow(j.sevenDay),
    at: j.at,
    source: j.source === "usage" ? "usage" : "statusline",
  };
  if (j.models && typeof j.models === "object") {
    const models: Record<string, UsageWindow> = {};
    for (const [k, v] of Object.entries(j.models as JsonObject)) {
      const w = cachedWindow(v);
      if (w) models[k] = w;
    }
    u.models = models;
  }
  return u;
}

/** The windows in `claude -p /usage`'s text, as 2.1.286 prints them:
 *  "Current session: 2% used · resets Oct 17 at 1:59pm (America/New_York)",
 *  "Current week (all models): …" and one "Current week (<model>): …" per
 *  model. The reset stays Claude Code's text; its format is not stable
 *  enough to turn into a date. */
export function parseUsageText(text: string, now: number): Usage | undefined {
  const re = /^Current (session|week \(([^)]*)\)):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets\s+(.+?))?\s*$/gm;
  const u: Usage = { at: now, source: "usage" };
  for (const m of text.matchAll(re)) {
    const w: UsageWindow = { usedPercentage: Number(m[3]) };
    if (m[4]) w.resets = m[4];
    if (m[1] === "session") u.fiveHour = w;
    else if (m[2] === "all models") u.sevenDay = w;
    else if (m[2]) u.models = { ...u.models, [m[2]]: w };
  }
  return u.fiveHour || u.sevenDay ? u : undefined;
}

/** The usage in `claude -p /usage --output-format json` output, or undefined. */
export function parseUsageOutput(out: string, now: number): Usage | undefined {
  try {
    const j: unknown = JSON.parse(out);
    const result = j && typeof j === "object" ? (j as JsonObject).result : undefined;
    return typeof result === "string" ? parseUsageText(result, now) : undefined;
  } catch {
    return undefined;
  }
}

/** When a window resets, short and in local time. */
function resetsText(w: UsageWindow | undefined): string {
  if (!w) return "-";
  if (w.resets) return w.resets.replace(/\s*\([^)]*\)$/, "");
  if (w.resetsAt === undefined) return "-";
  return new Date(w.resetsAt * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "now", "4 min ago", "3 h ago", "2 d ago". */
export function ageText(at: number, now: number): string {
  const s = Math.max(0, now - at);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

export type UsageRow = { name: string; usage?: Usage; live: boolean; timedOut?: boolean };

export function formatUsageTable(rows: UsageRow[], now: number): string[] {
  const cols = ["PROFILE", "5H", "RESETS", "7D", "RESETS", "SEEN"];
  const pct = (w?: UsageWindow) => (w ? `${Math.round(w.usedPercentage)}%` : "-");
  const data = rows.map((r) => [
    r.name,
    pct(r.usage?.fiveHour),
    resetsText(r.usage?.fiveHour),
    pct(r.usage?.sevenDay),
    resetsText(r.usage?.sevenDay),
    (r.timedOut ? "timeout, " : "") +
      (r.usage ? (r.live ? "now" : `${ageText(r.usage.at, now)} (${r.usage.source})`) : "never"),
  ]);
  const widths = cols.map((h, i) => Math.max(h.length, ...data.map((d) => (d[i] as string).length)));
  const fmt = (cells: string[]) =>
    cells
      .map((v, i) => v.padEnd(widths[i] as number))
      .join("  ")
      .trimEnd();
  return [fmt(cols), ...data.map((d) => fmt(d))];
}

/** `claudep usage [name…]`: each profile's five-hour and weekly usage. Live
 *  from `claude -p /usage` when that is safe (see SAFE_AUTH_STATUS_FROM),
 *  otherwise the numbers last seen by the statusline or an earlier run. */
async function cmdUsage(L: Layout, args: string[]): Promise<void> {
  const f = parseFlags(args, ...flagSpec("usage"));
  const names = f.rest.length ? f.rest : ["default", ...listProfileNames(L)];
  for (const n of names) if (n !== "default" && !profileExists(L, n)) die(`profile "${n}" does not exist`);
  const v = f.bools.has("--cached") ? undefined : await claudeVersion(L);
  const live = !f.bools.has("--cached") && (f.bools.has("--live") || authStatusSafe(v));
  const now = Math.floor(Date.now() / 1000);
  const rows: UsageRow[] = await Promise.all(
    names.map(async (name) => {
      const old = await readUsageCache(L, name);
      if (live) {
        const dir = name === "default" ? undefined : profileDir(L, name);
        const args = ["-p", "/usage", "--output-format", "json", "--no-session-persistence"];
        const { out, timedOut } = await captureClaude(L, dir, args);
        const fresh = parseUsageOutput(out, now);
        if (fresh) {
          try {
            writeUsageCache(L, name, fresh, old);
          } catch {}
          return { name, usage: fresh, live: true };
        }
        if (timedOut) return { name, usage: old, live: false, timedOut: true };
      }
      return { name, usage: old, live: false };
    }),
  );
  if (f.bools.has("--json")) {
    console.log(
      JSON.stringify(
        rows.map((r) => ({ name: r.name, live: r.live, ...(r.timedOut ? { timedOut: true } : {}), ...r.usage })),
        null,
        2,
      ),
    );
    return;
  }
  const [header, ...lines] = formatUsageTable(rows, now);
  console.log(c.bold(header as string));
  for (const line of lines) console.log(line);
  if (!live && !f.bools.has("--cached"))
    console.log(
      c.dim(
        `\nLast seen numbers: Claude Code ${v?.join(".") ?? "of unknown version"} can sign a profile out on a short command (${AUTH_STATUS_ISSUE}, fixed in ${SAFE_AUTH_STATUS_FROM}). Update Claude Code, or pass --live`,
      ),
    );
  if (rows.some((r) => r.timedOut))
    console.log(c.dim(`\n${timeoutNote().replace("the account in .claude.json", "the last numbers seen")}`));
  if (rows.some((r) => !r.usage))
    console.log(
      c.dim(
        "\nNo numbers for a profile until Claude Code reports them: an API-key or Bedrock login has none, and the statusline needs claudep statusline",
      ),
    );
}

/** Writes the cache only when the windows changed, since the statusline runs on every render. */
export function writeUsageCache(L: Layout, name: string, u: Usage, old: Usage | undefined): boolean {
  const same = (a?: UsageWindow, b?: UsageWindow) =>
    a?.usedPercentage === b?.usedPercentage && a?.resetsAt === b?.resetsAt && a?.resets === b?.resets;
  if (old?.source === u.source && same(old.fiveHour, u.fiveHour) && same(old.sevenDay, u.sevenDay)) return false;
  const file = usageCachePath(L, name);
  mkdirSync(pathApi(L.platform).dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(u)}\n`);
  return true;
}

/** `claudep statusline`: reads the statusline JSON on stdin and prints the
 *  profile with its usage. Meant to be piped to from statusline-command.sh. */
async function cmdStatusline(L: Layout): Promise<void> {
  const cur = currentProfile(L);
  const name = currentLabel(cur);
  const payload = process.stdin.isTTY ? "" : await Bun.stdin.text();
  const fresh = statuslineUsage(payload, Math.floor(Date.now() / 1000));
  if (fresh && cur.kind !== "custom") {
    try {
      writeUsageCache(L, name, fresh, await readUsageCache(L, name));
    } catch {}
  }
  console.log(usageSegment(name, fresh));
}

function cmdCurrent(L: Layout, args: string[]): void {
  const f = parseFlags(args, ...flagSpec("current"));
  if (L.emptyConfigDir) die(EMPTY_CONFIG_DIR_MESSAGE);
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
  else if (cur.setBy === "run") console.log("set by: claudep run (this session was started by claudep)");
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
  const f = parseFlags(args, ...flagSpec("resolve"));
  const start = f.rest[0] ?? process.cwd();
  const pin = resolvePin(start);
  if (!pin || pin.name === "") process.exit(1);
  if (!NAME_RE.test(pin.name)) die(`${pin.file} names an invalid profile "${pin.name}"`);
  if (f.bools.has("--json"))
    console.log(JSON.stringify({ ...pin, dir: pin.dir, profileDir: join(L.profilesRoot, pin.name) }, null, 2));
  else console.log(pin.name);
}

function cmdLocal(L: Layout, args: string[]): void {
  const f = parseFlags(args, ...flagSpec("local"));
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
 *  subprocess is allowed here. Logic mirrors resolvePin(). `Shell` and
 *  `SHELLS` live next to the command table. */

/** The shell to name in hints and to default `shell-init` to. */
export function defaultShell(env: Env = process.env, platform: NodeJS.Platform = process.platform): Shell {
  if (platform === "win32") return env.MSYSTEM ? "bash" : "powershell";
  const name = env.SHELL ? posix.basename(env.SHELL) : "";
  if (name === "zsh" || name === "bash" || name === "fish") return name;
  return platform === "darwin" ? "zsh" : "bash";
}

/** The one line that loads the hook in a shell's rc file. */
export function hookHint(shell: Shell): string {
  if (shell === "powershell") return "claudep shell-init powershell | Out-String | Invoke-Expression";
  if (shell === "fish") return "claudep shell-init fish | source";
  return `eval "$(claudep shell-init ${shell})"`;
}

export type EnvSyntax = "sh" | "fish" | "powershell";

/** The executable name of the parent process, which for `claudep env` is
 *  the shell the user typed it in: `eval "$(...)"` forks the shell and a
 *  fish pipeline runs claudep as a child of fish. Read from /proc on Linux
 *  and from `ps` on macOS; undefined elsewhere or when it cannot be read.
 *  This is `claudep env`, not the hook, so one `ps` is fine. */
export function parentProcessName(
  platform: NodeJS.Platform = process.platform,
  ppid: number = process.ppid,
): string | undefined {
  try {
    if (platform === "linux") return readFileSync(`/proc/${ppid}/comm`, "utf8").trim() || undefined;
    if (platform === "darwin") {
      const r = Bun.spawnSync(["ps", "-o", "comm=", "-p", String(ppid)], { stdout: "pipe", stderr: "ignore" });
      const name = r.exitCode === 0 ? r.stdout.toString().trim() : "";
      return name || undefined;
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

/** `fish` from `fish`, `-fish` (a login shell) or `/usr/local/bin/fish`. */
export function shellNameOf(comm: string): string {
  return posix.basename(comm.trim()).replace(/^-/, "");
}

const SH_LIKE = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);

/** What `claudep env` prints. PowerShell on Windows outside Git Bash. Then the
 *  parent process decides when it is a shell claudep knows (fish, pwsh, or an
 *  sh-like shell); otherwise the login shell in $SHELL: fish when that is
 *  fish, sh for anything else. fish exports no marker a child could see,
 *  which is why the parent is consulted at all. `--shell` overrides all of it. */
export function shellSyntax(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  parent: string | undefined = undefined,
): EnvSyntax {
  if (platform === "win32" && !env.MSYSTEM) return "powershell";
  const p = parent !== undefined ? shellNameOf(parent) : "";
  if (p === "fish") return "fish";
  if (p === "pwsh" || p === "powershell") return "powershell";
  if (SH_LIKE.has(p)) return "sh";
  return env.SHELL && posix.basename(env.SHELL) === "fish" ? "fish" : "sh";
}

/** The syntax for a `--shell` value: the shell-init names plus `sh`. */
export function envSyntaxOf(name: string): EnvSyntax | undefined {
  if (name === "sh" || name === "zsh" || name === "bash") return "sh";
  if (name === "fish" || name === "powershell") return name;
  return undefined;
}

/** fish single-quoting: only \ and ' are special inside single quotes. */
export function fishQuote(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export type EnvPlan = { clear: string[]; set: EnvVar[] };

/** The `claudep env` script: pin the shell to `dir`, or clear the pin. `plan`
 *  clears the variables claudep exported before and sets the profile's own,
 *  recording them in CLAUDEP_ENV_KEYS. */
export function envScript(dir: string | undefined, syntax: EnvSyntax, plan: EnvPlan = { clear: [], set: [] }): string {
  const set = dir === undefined ? [] : plan.set;
  const keys = set.map(([k]) => k).join(" ");
  const forget = plan.clear.length > 0 && set.length === 0;
  if (syntax === "powershell") {
    const ps = (v: string) => `'${v.replace(/'/g, "''")}'`;
    const out: string[] = [];
    if (plan.clear.length)
      out.push(`Remove-Item ${plan.clear.map((k) => `Env:${k}`).join(", ")} -ErrorAction SilentlyContinue`);
    if (dir === undefined)
      out.push("Remove-Item Env:CLAUDE_CONFIG_DIR, Env:CLAUDEP_AUTO -ErrorAction SilentlyContinue");
    else {
      // Clearing CLAUDEP_AUTO turns this into a manual pin the shell hook will not touch.
      out.push(`$env:CLAUDE_CONFIG_DIR = ${ps(dir)}`, "Remove-Item Env:CLAUDEP_AUTO -ErrorAction SilentlyContinue");
    }
    for (const [k, v] of set) out.push(`$env:${k} = ${ps(v)}`);
    if (set.length) out.push(`$env:${ENV_KEYS_VAR} = ${ps(keys)}`);
    if (forget) out.push(`Remove-Item Env:${ENV_KEYS_VAR} -ErrorAction SilentlyContinue`);
    return `${out.join("\n")}\n`;
  }
  if (syntax === "fish") {
    // A bare `set -e` on a missing name returns 1 and `source` reports its
    // last status, which prompt themes paint red; the guard keeps it at 0.
    const drop = (k: string) => `not set -q ${k}; or set -e ${k}`;
    const out = plan.clear.map(drop);
    if (dir === undefined) out.push(drop("CLAUDE_CONFIG_DIR"), drop("CLAUDEP_AUTO"));
    else out.push(`set -gx CLAUDE_CONFIG_DIR ${fishQuote(dir)}`, drop("CLAUDEP_AUTO"));
    for (const [k, v] of set) out.push(`set -gx ${k} ${fishQuote(v)}`);
    if (set.length) out.push(`set -gx ${ENV_KEYS_VAR} ${fishQuote(keys)}`);
    if (forget) out.push(drop(ENV_KEYS_VAR));
    return `${out.join("\n")}\n`;
  }
  const sq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  const out: string[] = [];
  if (plan.clear.length) out.push(`unset ${plan.clear.join(" ")}`);
  if (dir === undefined) out.push("unset CLAUDE_CONFIG_DIR CLAUDEP_AUTO");
  else out.push(`export CLAUDE_CONFIG_DIR=${sq(dir)}`, "unset CLAUDEP_AUTO");
  for (const [k, v] of set) out.push(`export ${k}=${sq(v)}`);
  if (set.length) out.push(`export ${ENV_KEYS_VAR}=${sq(keys)}`);
  if (forget) out.push(`unset ${ENV_KEYS_VAR}`);
  return `${out.join("\n")}\n`;
}

export function shellInit(shell: Shell, profilesRoot: string, platform: NodeJS.Platform = process.platform): string {
  if (shell === "powershell") return powershellHook(profilesRoot);
  if (shell === "fish") return fishHook(profilesRoot);
  return shHook(shell, profilesRoot, platform);
}

/** The fish hook. Builtins only (set, test, read, printf, string); every
 *  `(...)` is a `string` builtin, which runs in-process. Needs fish 3.0:
 *  `path dirname` would need 3.5 and `$(...)` 3.4, and Ubuntu 22.04 ships
 *  3.3. fish fires --on-variable on every `set` of PWD, `cd .` included, so
 *  the last-pwd dedupe stays. Not a Windows target; joins with `/`. */
function fishHook(profilesRoot: string): string {
  return `# claudep shell hook. Load it from ~/.config/fish/config.fish:  ${hookHint("fish")}
set -g _claudep_root ${fishQuote(profilesRoot)}
# Clear the variables a ${ENV_FILE} put in this shell.
function _claudep_env_clear
  for k in (string split ' ' -- "$${ENV_KEYS_VAR}")
    string match -qr '^[A-Za-z_][A-Za-z0-9_]*$' -- $k; or continue
    string match -qir '${refusedEnvRegex()}' -- $k; and continue
    set -e $k
  end
  not set -q ${ENV_KEYS_VAR}; or set -e ${ENV_KEYS_VAR}
end
# Export a profile's ${ENV_FILE}: data read line by line, never sourced. A
# variable the user set wins and is left alone.
function _claudep_env_load -a file
  test -f "$file"; or return 0
  set -l keys
  while read -l line
    set line (string trim -- $line)
    test -n "$line"; or continue
    string match -q -- '#*' $line; and continue
    set -l kv (string split -m1 = -- $line)
    set -q kv[2]; and test -n "$kv[2]"; or continue
    string match -qr '^[A-Za-z_][A-Za-z0-9_]*$' -- $kv[1]; or continue
    string match -qir '${refusedEnvRegex()}' -- $kv[1]; and continue
    set -q $kv[1]; and continue
    set -gx $kv[1] $kv[2]
    set -a keys $kv[1]
  end < "$file"
  set -q keys[1]; and set -gx ${ENV_KEYS_VAR} (string join ' ' -- $keys)
  return 0
end
function _claudep_auto --on-variable PWD
  test "$PWD" = "$_claudep_last_pwd"; and return 0
  set -g _claudep_last_pwd $PWD
  # Only manage a CLAUDE_CONFIG_DIR this hook set itself. A manual pin wins.
  if test -n "$CLAUDE_CONFIG_DIR"; and test "$CLAUDE_CONFIG_DIR" != "$CLAUDEP_AUTO"
    return 0
  end
  set -l dir $PWD
  set -l name ''
  set -l found ''
  while true
    if test -f "$dir/${PIN_FILE}"
      set found $dir
      test -n "$found"; or set found /
      while read -l line
        set line (string trim -- $line)
        if test -z "$line"; or string match -q -- '#*' $line
          continue
        end
        set name $line
        break
      end < "$dir/${PIN_FILE}"
      break
    end
    if test -z "$dir"; or test "$dir" = /
      break
    end
    set dir (string replace -r -- '/[^/]*$' '' $dir)
  end
  if test -z "$name"
    # No pin here: hand the shell back to the base account.
    if test -n "$CLAUDEP_AUTO"
      set -e CLAUDE_CONFIG_DIR
      set -e CLAUDEP_AUTO
      _claudep_env_clear
    end
    return 0
  end
  if not test -d "$_claudep_root/$name"
    if test -n "$CLAUDEP_AUTO"
      set -e CLAUDE_CONFIG_DIR
      set -e CLAUDEP_AUTO
      _claudep_env_clear
    end
    printf 'claudep: %s/${PIN_FILE} names profile "%s", which does not exist. Run: claudep init %s\\n' "$found" "$name" "$name" >&2
    return 0
  end
  set -gx CLAUDE_CONFIG_DIR "$_claudep_root/$name"
  set -gx CLAUDEP_AUTO "$_claudep_root/$name"
  _claudep_env_clear
  _claudep_env_load "$_claudep_root/$name/${ENV_FILE}"
end
_claudep_auto
`;
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
# Clear the variables a ${ENV_FILE} put in this shell.
function global:_claudep_env_clear {
  foreach ($k in @(([string]$env:${ENV_KEYS_VAR}).Split(' '))) {
    if ($k -cnotmatch '^[A-Za-z_][A-Za-z0-9_]*$' -or $k -match '${refusedEnvRegex()}') { continue }
    Remove-Item -LiteralPath "Env:$k" -ErrorAction SilentlyContinue
  }
  Remove-Item Env:${ENV_KEYS_VAR} -ErrorAction SilentlyContinue
}
# Export a profile's ${ENV_FILE}: data read line by line, never sourced. A
# variable the user set wins and is left alone.
function global:_claudep_env_load([string]$file) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return }
  $keys = @()
  foreach ($line in @(Get-Content -LiteralPath $file)) {
    $t = ([string]$line).Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    $i = $t.IndexOf('=')
    if ($i -lt 1 -or $i -eq $t.Length - 1) { continue }
    $k = $t.Substring(0, $i)
    if ($k -cnotmatch '^[A-Za-z_][A-Za-z0-9_]*$' -or $k -match '${refusedEnvRegex()}') { continue }
    if (Test-Path -LiteralPath "Env:$k") { continue }
    Set-Item -LiteralPath "Env:$k" -Value $t.Substring($i + 1)
    $keys += $k
  }
  if ($keys.Count) { $env:${ENV_KEYS_VAR} = $keys -join ' ' }
}
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
    if ($env:CLAUDEP_AUTO) { Remove-Item Env:CLAUDE_CONFIG_DIR, Env:CLAUDEP_AUTO -ErrorAction SilentlyContinue; _claudep_env_clear }
    return
  }
  $target = Join-Path $global:_claudep_root $name
  if (-not (Test-Path -LiteralPath $target -PathType Container)) {
    if ($env:CLAUDEP_AUTO) { Remove-Item Env:CLAUDE_CONFIG_DIR, Env:CLAUDEP_AUTO -ErrorAction SilentlyContinue; _claudep_env_clear }
    [Console]::Error.WriteLine('claudep: ' + (Join-Path $found '${PIN_FILE}') + ' names profile "' + $name + '", which does not exist. Run: claudep init ' + $name)
    return
  }
  $env:CLAUDE_CONFIG_DIR = $target
  $env:CLAUDEP_AUTO = $target
  _claudep_env_clear
  _claudep_env_load (Join-Path $target '${ENV_FILE}')
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
  // Whether the variable named by $_claudep_k is set, without eval or a subshell.
  const isSet = shell === "zsh" ? `\${(P)_claudep_k+x}` : `\${!_claudep_k+x}`;
  const core = `# claudep shell hook. Load it from your rc file:  eval "$(claudep shell-init ${shell})"
_claudep_root='${q}'
_claudep_sep='${sep}'
# Clear the variables a ${ENV_FILE} put in this shell.
_claudep_env_clear() {
  _claudep_rest="\${${ENV_KEYS_VAR}:-}"
  while [ -n "$_claudep_rest" ]; do
    _claudep_k="\${_claudep_rest%% *}"
    case "$_claudep_rest" in *" "*) _claudep_rest="\${_claudep_rest#* }" ;; *) _claudep_rest="" ;; esac
    case "$_claudep_k" in "" | [0-9]* | *[!A-Za-z0-9_]* | ${refusedEnvCase()}) ;; *) unset "$_claudep_k" ;; esac
  done
  unset ${ENV_KEYS_VAR}
}
# Export a profile's ${ENV_FILE}: data read line by line, never sourced. A
# variable the user set wins and is left alone.
_claudep_env_load() {
  _claudep_keys=""
  [ -f "$1" ] || return 0
  while read -r _claudep_line || [ -n "$_claudep_line" ]; do
    _claudep_line="\${_claudep_line%$'\\r'}"
    case "$_claudep_line" in "" | "#"* | "="* | *=) continue ;; *=*) ;; *) continue ;; esac
    _claudep_k="\${_claudep_line%%=*}"
    case "$_claudep_k" in [0-9]* | *[!A-Za-z0-9_]* | ${refusedEnvCase()}) continue ;; esac
    [ -n "${isSet}" ] && continue
    export "$_claudep_k=\${_claudep_line#*=}"
    _claudep_keys="\${_claudep_keys:+$_claudep_keys }$_claudep_k"
  done < "$1"
  [ -n "$_claudep_keys" ] && export ${ENV_KEYS_VAR}="$_claudep_keys"
  return 0
}
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
    if [ -n "\${CLAUDEP_AUTO:-}" ]; then unset CLAUDE_CONFIG_DIR CLAUDEP_AUTO; _claudep_env_clear; fi
    return 0
  fi
  if [ ! -d "$_claudep_root$_claudep_sep$_claudep_name" ]; then
    if [ -n "\${CLAUDEP_AUTO:-}" ]; then unset CLAUDE_CONFIG_DIR CLAUDEP_AUTO; _claudep_env_clear; fi
    printf 'claudep: %s/${PIN_FILE} names profile "%s", which does not exist. Run: claudep init %s\\n' "$_claudep_found" "$_claudep_name" "$_claudep_name" >&2
    return 0
  fi
  export CLAUDE_CONFIG_DIR="$_claudep_root$_claudep_sep$_claudep_name" CLAUDEP_AUTO="$_claudep_root$_claudep_sep$_claudep_name"
  _claudep_env_clear
  _claudep_env_load "$_claudep_root$_claudep_sep$_claudep_name\${_claudep_sep}${ENV_FILE}"
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
  if (!SHELLS.includes(shell as Shell)) die(`unsupported shell "${shell}". Use ${SHELLS.join(", ")}`);
  process.stdout.write(shellInit(shell as Shell, L.profilesRoot, L.platform));
}

// ---------------------------------------------------------------------------
// Tab completions, generated from COMMANDS. Profile names come from a glob
// over the profiles root at completion time; no script ever runs claudep.
// ---------------------------------------------------------------------------

/** The one rc-file line that loads the completions. */
export function completionHint(shell: CompletionShell): string {
  if (shell === "powershell") return "claudep completion powershell | Out-String | Invoke-Expression";
  return shell === "fish" ? "claudep completion fish | source" : `eval "$(claudep completion ${shell})"`;
}

const visibleCommands = () => COMMANDS.filter((c) => !c.hidden);
const isList = (arg: Command["arg"]): arg is readonly string[] => arg !== undefined && typeof arg !== "string";

export function completionScript(shell: CompletionShell, profilesRoot: string): string {
  if (shell === "zsh") return zshCompletion(profilesRoot);
  if (shell === "bash") return bashCompletion(profilesRoot);
  if (shell === "powershell") return powershellCompletion(profilesRoot);
  return fishCompletion(profilesRoot);
}

/** Dual-mode: `eval "$(claudep completion zsh)"` after compinit registers it
 *  with compdef; saved as `_claudep` on fpath, the #compdef line and the
 *  funcstack check make it autoload. Names come from a glob with (N/:t):
 *  nothing on an empty root, directories only, basename. */
function zshCompletion(profilesRoot: string): string {
  const q = `'${profilesRoot.replace(/'/g, `'\\''`)}'`;
  const zshDesc = (s: string) => s.replace(/:/g, "\\:").replace(/'/g, `'\\''`);
  const cmds = visibleCommands().flatMap((c) => commandWords(c).map((w) => `    '${w}:${zshDesc(c.desc)}'`));
  const cases = COMMANDS.filter((c) => c.arg || c.flags || c.valueFlags).map((c) => {
    const specs: string[] = [];
    if (c.arg === "profile") specs.push("'1:profile:_claudep_profiles'");
    else if (c.arg === "dir") specs.push("'1:directory:_files -/'");
    else if (isList(c.arg)) specs.push(`'1:shell:(${c.arg.join(" ")})'`);
    if (c.name === "run") specs.push("'*:claude arguments:'");
    for (const f of c.flags ?? []) specs.push(`'${f}'`);
    for (const v of c.valueFlags ?? [])
      specs.push(`'${v.name}=-:${v.name.slice(2)}:${v.values ? `(${v.values.join(" ")})` : ""}'`);
    return `        ${commandWords(c).join("|")}) _arguments ${specs.join(" ")} ;;`;
  });
  return `#compdef claudep
# claudep completions. Load them after compinit in ~/.zshrc:  ${completionHint("zsh")}
_claudep_profiles() {
  local -a names
  names=(default ${q}/*(N/:t))
  _describe -t profiles 'profile' names
}
_claudep() {
  local -a cmds
  cmds=(
${cmds.join("\n")}
  )
  _arguments -C '1:command:->cmd' '*::arg:->args'
  case $state in
    cmd)
      _describe -t commands 'claudep command' cmds
      _claudep_profiles
      ;;
    args)
      case $words[1] in
${cases.join("\n")}
      esac
      ;;
  esac
}
if [ "\${funcstack[1]}" = "_claudep" ]; then _claudep "$@"; else compdef _claudep claudep; fi
`;
}

/** bash 3.2 safe: no mapfile, no compopt. The root's backslashes become
 *  slashes so a Git Bash user with a C:\\ root still globs. */
function bashCompletion(profilesRoot: string): string {
  const q = `'${profilesRoot.replace(/'/g, `'\\''`)}'`;
  const top = [...visibleCommands().flatMap(commandWords), "default"].join(" ");
  const flagCases = COMMANDS.filter((c) => c.flags || c.valueFlags).map(
    (c) =>
      `        ${commandWords(c).join("|")}) words="${[...(c.flags ?? []), ...(c.valueFlags ?? []).map((v) => v.name)].join(" ")}" ;;`,
  );
  const valued = COMMANDS.flatMap((c) => (c.valueFlags ?? []).filter((v) => v.values));
  const valueBranches = valued.map(
    (v, i) => `      ${i === 0 ? "if" : "elif"} [ "$prev" = "${v.name}" ]; then words="${(v.values ?? []).join(" ")}"`,
  );
  const argCases = COMMANDS.filter((c) => c.arg).map((c) => {
    const names = commandWords(c).join("|");
    if (c.arg === "profile") return `          ${names}) words="default $(_claudep_profiles)" ;;`;
    if (c.arg === "dir") return `          ${names}) COMPREPLY=($(compgen -d -- "$cur")); return 0 ;;`;
    return `          ${names}) words="${isList(c.arg) ? c.arg.join(" ") : ""}" ;;`;
  });
  return `# claudep completions. Load them from ~/.bashrc:  ${completionHint("bash")}
_claudep_profiles() {
  local root=${q} d
  root=\${root//\\\\//}
  for d in "$root"/*/; do
    d=\${d%/}
    [ -d "$d" ] && printf '%s\\n' "\${d##*/}"
  done
}
_claudep() {
  local cur prev cmd words=""
  cur=\${COMP_WORDS[COMP_CWORD]}
  prev=\${COMP_WORDS[COMP_CWORD-1]}
  cmd=\${COMP_WORDS[1]}
  COMPREPLY=()
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "${top} $(_claudep_profiles)" -- "$cur"))
    return 0
  fi
  case $cur in
    -*)
      case $cmd in
${flagCases.join("\n")}
      esac
      ;;
    *)
${valueBranches.join("\n")}
      ${valueBranches.length ? "elif" : "if"} [ "$COMP_CWORD" -eq 2 ]; then
        case $cmd in
${argCases.join("\n")}
        esac
      fi
      ;;
  esac
  COMPREPLY=($(compgen -W "$words" -- "$cur"))
}
complete -F _claudep claudep
`;
}

/** The two conditions are written out over `commandline -opc` instead of
 *  fish's __fish_use_subcommand and __fish_seen_subcommand_from, whose
 *  names moved between versions. `for` over an unmatched glob runs zero
 *  times, so an empty root offers only `default`. */
function fishCompletion(profilesRoot: string): string {
  const lines: string[] = [];
  for (const c of visibleCommands())
    for (const w of commandWords(c))
      lines.push(`complete -c claudep -n '__claudep_at 1' -a ${w} -d ${fishQuote(c.desc)}`);
  lines.push("complete -c claudep -n '__claudep_at 1' -a '(__claudep_profiles)' -d profile");
  const profileCmds = COMMANDS.filter((c) => c.arg === "profile")
    .flatMap(commandWords)
    .join(" ");
  lines.push(
    `complete -c claudep -n '__claudep_cmd ${profileCmds}; and __claudep_at 2' -a '(__claudep_profiles)' -d profile`,
  );
  for (const c of COMMANDS) {
    const ws = commandWords(c).join(" ");
    if (isList(c.arg))
      lines.push(`complete -c claudep -n '__claudep_cmd ${ws}; and __claudep_at 2' -a '${c.arg.join(" ")}'`);
    if (c.arg === "dir")
      lines.push(`complete -c claudep -n '__claudep_cmd ${ws}; and __claudep_at 2' -a '(__fish_complete_directories)'`);
    for (const f of c.flags ?? []) lines.push(`complete -c claudep -n '__claudep_cmd ${ws}' -l ${f.slice(2)}`);
    for (const v of c.valueFlags ?? [])
      lines.push(
        `complete -c claudep -n '__claudep_cmd ${ws}' -l ${v.name.slice(2)} -x${v.values ? ` -a '${v.values.join(" ")}'` : ""}`,
      );
  }
  return `# claudep completions. Load them from ~/.config/fish/config.fish:  ${completionHint("fish")}
function __claudep_profiles
  echo default
  for d in ${fishQuote(profilesRoot)}/*/
    string replace -r -- '^.*/([^/]+)/$' '$1' $d
  end
end
function __claudep_at -a n
  test (count (commandline -opc)) -eq $n
end
function __claudep_cmd
  set -l t (commandline -opc)
  test (count $t) -ge 2; and contains -- $t[2] $argv
end
complete -c claudep -f
${lines.join("\n")}
`;
}

/** A native completer, so it works on Windows PowerShell 5.1 and pwsh alike.
 *  The words before the cursor are the command elements that end before it;
 *  the first is claudep itself. Names come from Get-ChildItem over the root
 *  when Tab is pressed. Returning nothing, as for `resolve <dir>`, hands the
 *  word to PowerShell's own path completion. Windows PowerShell 5.1 never
 *  calls a native completer for a bare `-` or `--` word, so there a flag
 *  completes from its first letter: `--e<Tab>`. */
function powershellCompletion(profilesRoot: string): string {
  const ps = (v: string) => `'${v.replace(/'/g, "''")}'`;
  const list = (vs: readonly string[]) => `@(${vs.map(ps).join(", ")})`;
  const commands = visibleCommands().flatMap((c) => commandWords(c).map((w) => `    ${ps(w)} = ${ps(c.desc)}`));
  const flags = COMMANDS.filter((c) => c.flags || c.valueFlags).flatMap((c) =>
    commandWords(c).map(
      (w) => `    ${ps(w)} = ${list([...(c.flags ?? []), ...(c.valueFlags ?? []).map((v) => v.name)])}`,
    ),
  );
  const values = COMMANDS.flatMap((c) =>
    (c.valueFlags ?? [])
      .filter((v) => v.values)
      .flatMap((v) => commandWords(c).map((w) => `    ${ps(`${w} ${v.name}`)} = ${list(v.values ?? [])}`)),
  );
  const profileArg = COMMANDS.filter((c) => c.arg === "profile").flatMap(commandWords);
  const listArg = COMMANDS.flatMap((c) => {
    const arg = c.arg;
    return isList(arg) ? commandWords(c).map((w) => `    ${ps(w)} = ${list(arg)}`) : [];
  });
  return `# claudep completions. Load them from your $PROFILE:  ${completionHint("powershell")}
Register-ArgumentCompleter -Native -CommandName claudep -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $root = ${ps(profilesRoot)}
  $commands = [ordered]@{
${commands.join("\n")}
  }
  $flags = @{
${flags.join("\n")}
  }
  $values = @{
${values.join("\n")}
  }
  $listArg = @{
${listArg.join("\n")}
  }
  $profileArg = ${list(profileArg)}
  $before = @($commandAst.CommandElements | Where-Object { $_.Extent.EndOffset -lt $cursorPosition })
  $cmd = if ($before.Count -ge 2) { $before[1].Extent.Text } else { '' }
  $prev = $before[$before.Count - 1].Extent.Text
  $type = 'ParameterValue'
  $words = @()
  $profiles = $false
  if ($before.Count -le 1) {
    foreach ($k in $commands.Keys) { $words += ,@($k, $commands[$k]) }
    $profiles = $true
  } elseif ($wordToComplete.StartsWith('-')) {
    if ($flags.ContainsKey($cmd)) { foreach ($f in $flags[$cmd]) { $words += ,@($f, $f) } }
    $type = 'ParameterName'
  } elseif ($values.ContainsKey("$cmd $prev")) {
    foreach ($v in $values["$cmd $prev"]) { $words += ,@($v, $v) }
  } elseif ($before.Count -eq 2 -and $profileArg -contains $cmd) {
    $profiles = $true
  } elseif ($before.Count -eq 2 -and $listArg.ContainsKey($cmd)) {
    foreach ($v in $listArg[$cmd]) { $words += ,@($v, $v) }
  } else {
    return
  }
  if ($profiles) {
    $words += ,@('default', 'profile')
    foreach ($d in @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
      $words += ,@($d.Name, 'profile')
    }
  }
  foreach ($w in $words) {
    if ($w[0].StartsWith($wordToComplete, [System.StringComparison]::OrdinalIgnoreCase)) {
      [System.Management.Automation.CompletionResult]::new($w[0], $w[0], $type, $w[1])
    }
  }
}
`;
}

function cmdCompletion(L: Layout, args: string[]): void {
  const shell = args[0] ?? defaultShell(process.env, L.platform);
  if (!COMPLETION_SHELLS.includes(shell as CompletionShell))
    die(`no completions for "${shell}". Use ${COMPLETION_SHELLS.join(", ")}`);
  process.stdout.write(completionScript(shell as CompletionShell, L.profilesRoot));
}

/** A POSIX-style CLAUDE_CONFIG_DIR on Windows is one claude.exe cannot read. */
function msysConfigDirWarning(L: Layout, env: Env = process.env): string | undefined {
  const cfg = env.CLAUDE_CONFIG_DIR;
  if (L.platform !== "win32" || !cfg || !isMsysPath(cfg)) return undefined;
  return `CLAUDE_CONFIG_DIR is a POSIX-style path (${cfg}); claude.exe will not read it. Set it with: eval "$(claudep env <name>)"`;
}

export type CheckLevel = "ok" | "info" | "warn" | "fail";

/** One line of `claudep doctor`. `problem` is what the count and the exit code
 *  read; a warning does not always count, and neither does an accepted item. */
export type Check = {
  item: string;
  state: string;
  level: CheckLevel;
  message: string;
  fix?: string;
  problem: boolean;
};

/** Collects every check, and in text mode prints it the moment it is known, so
 *  a slow `claude auth status` does not hold back the lines before it. */
class DoctorReport {
  problems = 0;
  private list: Check[] = [];
  constructor(private text: boolean) {}

  /** Later checks go to `list` until the next call. */
  section(list: Check[]): void {
    this.list = list;
  }

  /** Text only: a blank line and a heading, or a line that is not a check. */
  say(line: string): void {
    if (this.text) console.log(line);
  }

  add(
    item: string,
    state: string,
    level: CheckLevel,
    message: string,
    opts: { problem?: boolean; fix?: string; lead?: string } = {},
  ): void {
    const problem = opts.problem ?? false;
    if (problem) this.problems++;
    this.list.push({ item, state, level, message, ...(opts.fix ? { fix: opts.fix } : {}), problem });
    if (!this.text) return;
    if (opts.lead !== undefined) console.log(opts.lead);
    if (level === "ok") ok(message);
    else if (level === "info") console.log(`${c.dim("·")} ${message}`);
    else if (level === "warn") warn(message);
    else bad(message);
  }
}

/** Reports whether Claude Code's updater runs for a config dir (undefined is
 *  the base) and its last update next to the running version; true when the
 *  updater is on. `targets` is what updateTargets() found across every dir. */
async function reportUpdates(
  L: Layout,
  report: DoctorReport,
  dir: string | undefined,
  running: Version | undefined,
  targets: readonly Version[],
): Promise<boolean> {
  const d = dir ?? L.base;
  const globalJson = await readJson(dir === undefined ? L.baseGlobalJson : join(dir, ".claude.json"));
  const sources: [string, Env][] = [
    ["managed settings env", await managedSettingsEnv(L.managedDir, L.platform)],
    ["settings.json env", await settingsEnv(join(d, "settings.json"))],
    [".claude.json env", stringValues(globalJson?.env)],
    ["this shell", baseEnv(L)],
  ];
  if (dir !== undefined) sources.push([ENV_FILE, Object.fromEntries(readProfileEnv(dir).vars)]);
  const state = autoUpdateState(sources, globalJson);
  const who = dir === undefined ? "default: " : "";
  report.add(
    "auto-update",
    state.enabled ? "on" : "off",
    "info",
    `${who}auto-update ${state.enabled ? "on" : `off (${state.by})`}`,
  );
  const last = await lastUpdate(d);
  if (last?.to || last?.outcome === "failed")
    report.add(
      "last-update",
      last.outcome ?? "unknown",
      "info",
      `${who}last update ${last.from ?? "?"} → ${last.to ?? "?"} (${last.outcome ?? "?"}, ${last.path ?? "?"}, ${(last.at ?? "").slice(0, 10)})${updateNote(last, running, targets)}`,
    );
  return state.enabled;
}

/** The commands that move a real item aside and link the shared one. PowerShell
 *  5.1 has no `&&`, and a path can hold a space. */
export function shareFixCommand(path: string, name: string, powershell: boolean): string {
  if (powershell) {
    const q = (p: string) => `'${p.replace(/'/g, "''")}'`;
    return `Move-Item ${q(path)} ${q(`${path}.old`)}; claudep init ${name} --no-login`;
  }
  const q = (p: string) => (/^[\w@%+=:,./~-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`);
  return `mv ${q(path)} ${q(`${path}.old`)} && claudep init ${name} --no-login`;
}

/** One shared item that is not the plain symlink it should be. */
function reportLink(
  report: DoctorReport,
  L: Layout,
  name: string,
  dir: string,
  item: SharedItem,
  state: Exclude<LinkState, "ok">,
  accepted: boolean,
): void {
  const P = pathApi(L.platform);
  const here = P.join(dir, item.name);
  if (state === "shadowed") {
    const what = `${item.name}: real ${item.kind} shadows the shared one`;
    if (accepted) {
      report.add(item.name, "accepted", "info", `${what} (accepted)`);
      return;
    }
    const detail = shadowDetail(L.base, dir, item, name, L.platform);
    const fix = shareFixCommand(here, name, L.platform === "win32" && !process.env.MSYSTEM);
    report.add(
      item.name,
      state,
      "warn",
      `${what}${detail ? `; ${detail}` : ""}. A launch never replaces it. To share it: ${fix}. To keep it: claudep doctor --accept ${name} ${item.name}`,
      { problem: true, fix },
    );
    return;
  }
  if (state === "missing") {
    const heals =
      isLaunchLinked(item.name) && (L.callerConfigDir === undefined || L.managed) && !builtOnOtherBase(L.base, dir);
    const what = heals
      ? `${item.name}: not linked yet; the next claudep run links it`
      : `${item.name}: not linked (run: claudep init ${name})`;
    if (accepted) report.add(item.name, "accepted", "info", `${item.name}: not linked (accepted)`);
    else report.add(item.name, state, "warn", what, { problem: true, fix: `claudep init ${name}` });
    return;
  }
  const what =
    state === "wrong-target"
      ? `${item.name}: symlink points elsewhere (${readlinkSync(here)})`
      : `${item.name}: broken symlink`;
  if (accepted) report.add(item.name, "accepted", "info", `${what} (accepted)`);
  else report.add(item.name, state, "fail", what, { problem: true });
}

/** `doctor --accept <name> <item>` and `--unaccept`: record one intended difference. */
function acceptItem(L: Layout, rest: readonly string[], on: boolean): void {
  const flag = on ? "--accept" : "--unaccept";
  const [name, item] = rest;
  if (!name || !item || rest.length > 2) die(`usage: claudep doctor ${flag} <name> <item>`);
  const dir = profileDir(L, name);
  if (!existsSync(dir)) die(`profile "${name}" does not exist. Run: claudep init ${name}`);
  const accepted = readAccepted(dir);
  if (on) {
    const known = new Set<string>([...SHARED_FILES, ...SHARED_DIRS, ...sharedItems(L.base).map((s) => s.name)]);
    if (!known.has(item)) die(`"${item}" is not a shared item; doctor only accepts those`);
    accepted.add(item);
  } else accepted.delete(item);
  const file = join(dir, ACCEPT_FILE);
  if (accepted.size) writeFileSync(file, acceptedText(name, accepted));
  else rmSync(file, { force: true });
  ok(on ? `${name}: doctor accepts ${item} as it is` : `${name}: doctor reports ${item} again`);
}

async function cmdDoctor(L: Layout, args: string[]): Promise<void> {
  const f = parseFlags(args, ...flagSpec("doctor"));
  const accept = f.bools.has("--accept");
  if (accept && f.bools.has("--unaccept")) die("use --accept or --unaccept, not both");
  if (accept || f.bools.has("--unaccept")) return acceptItem(L, f.rest, accept);
  const only = f.rest[0];
  const names = only ? [only] : listProfileNames(L);
  const json = f.bools.has("--json");
  const report = new DoctorReport(!json);
  const baseChecks: Check[] = [];
  const profiles: { name: string; dir: string; checks: Check[] }[] = [];
  const aliases: Check[] = [];
  report.section(baseChecks);
  const claude: { bin?: string; version?: string; install?: string } = {};
  let v: Version | undefined;
  let kind: InstallKind | undefined;
  const launch = findClaude();
  if (launch && launch.kind !== "ps1") {
    const { out } = await captureClaude(L, undefined, ["--version"]);
    report.add("claude", "found", "ok", `claude: ${launch.bin} (${out.trim() || "version unknown"})`);
    let real = launch.bin;
    try {
      real = realpathSync(launch.bin);
    } catch {}
    kind = installKind(launch.bin, real, L.platform);
    claude.bin = launch.bin;
    claude.install = kind;
    if (launch.kind === "cmd")
      report.add(
        "claude",
        "cmd-shim",
        "info",
        "claude is the npm cmd shim and runs through cmd.exe; the native installer's claude.exe avoids that hop",
      );
    v = parseVersion(out);
    if (v) claude.version = v.join(".");
    const floor = parseVersion(MIN_CLAUDE_VERSION);
    if (L.platform === "darwin" && v && floor && versionBelow(v, floor))
      report.add(
        "claude",
        "too-old",
        "fail",
        `Claude Code ${v.join(".")} is older than ${MIN_CLAUDE_VERSION}; every config dir shares one Keychain item there, so profiles cannot hold separate logins. Update Claude Code`,
        { problem: true },
      );
  } else if (launch)
    report.add("claude", "ps1-only", "fail", `only ${launch.bin} found; claudep needs claude.exe or claude.cmd`);
  else report.add("claude", "missing", "fail", "claude binary not found on PATH");
  if (kind === "npm" || kind === "bun")
    report.add(
      "install",
      kind,
      "warn",
      `claude is ${kind === "npm" ? "an" : "a"} ${kind}-global install. Every profile runs its own auto-updater against it, and a reinstall removes claude while it runs, so a launch can find nothing (${NPM_RACE_ISSUE}). claudep run waits for an update it can see; the native installer swaps versions in one step: claude install`,
      { fix: "claude install" },
    );
  else if (kind) report.add("install", kind, "info", `install: ${kind}`);
  const all = findAllClaude();
  if (all.length > 1)
    report.add(
      "path",
      "several-claude",
      "warn",
      `more than one claude on PATH; the first one runs, and a later one starts if it goes missing: ${all.join(", ")}`,
    );
  report.add(
    "base",
    "found",
    "ok",
    `base: ${L.base}${L.callerConfigDir && !L.managed ? "  (from CLAUDE_CONFIG_DIR in your shell)" : ""}`,
  );
  if (L.emptyConfigDir)
    report.add("CLAUDE_CONFIG_DIR", "empty", "fail", EMPTY_CONFIG_DIR_MESSAGE, {
      problem: true,
      fix: "unset CLAUDE_CONFIG_DIR",
    });
  const msysWarning = msysConfigDirWarning(L);
  if (msysWarning) report.add("CLAUDE_CONFIG_DIR", "posix-path", "warn", msysWarning);
  const settingsFile = join(L.base, "settings.json");
  const pinnedInSettings = await settingsEnvConfigDir(settingsFile);
  if (pinnedInSettings !== undefined)
    report.add(
      "settings.json",
      "pins-config-dir",
      "fail",
      `${settingsFile} sets env.CLAUDE_CONFIG_DIR (${pinnedInSettings}). Claude Code disables features when that differs from the active dir, which it does in every profile. Remove it; pin shells with claudep env or a ${PIN_FILE} file instead`,
      { problem: true },
    );
  for (const name of authEnvOverrides(process.env, L.platform))
    report.add(
      name,
      "set",
      "warn",
      `${name} is set in this shell; Claude Code uses it instead of the profile login, always in -p mode`,
    );
  report.add("profiles-root", "found", "ok", `profiles root: ${L.profilesRoot}`);
  const ask = authStatusSafe(v);
  if (launch && !ask)
    report.add(
      "claude",
      "unsafe-auth-status",
      "warn",
      `Claude Code ${v?.join(".") ?? "of unknown version"} can sign a profile out on a short \`claude auth status\` (${AUTH_STATUS_ISSUE}). claudep reads logins from .claude.json instead until Claude Code is ${SAFE_AUTH_STATUS_FROM} or newer: claude update`,
    );
  let updaters: string[] = [];
  const targets = updateTargets(await Promise.all(configDirs(L).map((d) => lastUpdate(d))));
  if (await reportUpdates(L, report, undefined, v, targets)) updaters.push("default");

  const shared = sharedItems(L.base);
  const sharedNames = new Set(shared.map((s) => s.name));
  const unclassified = existsSync(L.base)
    ? readdirSync(L.base)
        .filter((n) => !sharedNames.has(n) && !isKnownPrivate(n) && !n.endsWith(".md"))
        .sort()
    : [];
  if (unclassified.length)
    report.add(
      "base",
      "unclassified",
      "warn",
      `base items neither shared nor known-private (they stay per-profile): ${unclassified.join(", ")}`,
    );
  if (memoryWritesPrompt(v, shared))
    report.add(
      "auto-memory",
      "prompts",
      "warn",
      `Claude Code ${v?.join(".")} asks for approval on every auto-memory write in a profile, because projects/ is shared through a symlink; auto mode cannot approve it. claudep run and alias commands pass the real memory path and avoid it; plain claude in a hooked shell still asks. Known upstream bug: ${MEMORY_SYMLINK_ISSUE}`,
    );

  for (const name of names) {
    const dir = profileDir(L, name);
    const checks: Check[] = [];
    profiles.push({ name, dir, checks });
    report.section(checks);
    report.say(`\n${c.bold(name)}  ${c.dim(dir)}`);
    if (!existsSync(dir)) {
      report.add("profile", "missing", "fail", "profile dir missing", { problem: true });
      continue;
    }
    const accepted = readAccepted(dir);
    let missing = 0;
    for (const item of shared) {
      const state = linkState(L.base, dir, item);
      if (state === "ok") continue;
      if (state === "missing" && !accepted.has(item.name)) missing++;
      reportLink(report, L, name, dir, item, state, accepted.has(item.name));
    }
    if (missing && L.platform === "win32")
      report.add(
        "symlinks",
        "windows",
        "info",
        `Windows creates symlinks only with Developer Mode on; claudep init ${name} says so when it is off`,
      );
    report.add("shared", "checked", "ok", `${shared.length} shared item(s) checked`);
    const strays = readdirSync(dir).filter((n) => !sharedNames.has(n) && !isKnownPrivate(n) && !n.endsWith(".md"));
    if (strays.length) report.add("private", "unexpected", "warn", `unexpected private items: ${strays.join(", ")}`);
    for (const n of staleSharedLinks(L.base, dir, L.platform))
      report.add(
        n,
        "stale-link",
        "fail",
        `${n}: linked to the base by an older claudep, but it is per-profile state now. Remove the symlink: ${join(dir, n)}`,
        { problem: true },
      );
    const s = await loginOf(L, dir, ask);
    const login = loginCommand(name, readLoginFlags(dir));
    const failure = readFailure(L, name);
    if (failure && failureKind(failure.error) === "login")
      report.add("stop-failure", failure.error, "fail", failureNote(name, failure, login), {
        problem: true,
        fix: login,
      });
    else if (failure) report.add("stop-failure", failure.error, "info", failureNote(name, failure, login));
    if (L.platform === "darwin") {
      const svc = keychainService(dir);
      if (await keychainHas(svc)) report.add("keychain", "present", "ok", `keychain item "${svc}" present`);
      else
        report.add("keychain", "absent", "warn", `no keychain item "${svc}". Not logged in yet (${login})`, {
          fix: login,
        });
    } else if (credentialsFileHas(dir)) report.add("credentials", "present", "ok", ".credentials.json present");
    else if (s.loggedIn)
      report.add(
        "credentials",
        "elsewhere",
        "info",
        "no .credentials.json in the profile; Claude Code keeps this login elsewhere (on Windows, possibly Credential Manager)",
      );
    else
      report.add("credentials", "absent", "warn", `no .credentials.json in the profile. Not logged in yet (${login})`, {
        fix: login,
      });
    if (s.timedOut)
      report.add(
        "login",
        "timeout",
        "warn",
        `claude auth status did not answer in time; last known account: ${s.email ?? "none"}, from .claude.json. CLAUDEP_TIMEOUT=<seconds> waits longer`,
      );
    else if (s.cached && s.loggedIn)
      report.add(
        "login",
        "cached",
        "ok",
        `last known account: ${s.email ?? "?"} (${s.orgName ?? "?"}), from .claude.json`,
      );
    else if (s.cached)
      report.add("login", "cached-none", "warn", "no account recorded in .claude.json", { fix: login });
    else if (s.loggedIn)
      report.add(
        "login",
        "logged-in",
        "ok",
        `logged in as ${s.email ?? "?"} (${s.orgName ?? "?"}, ${s.subscriptionType ?? "?"})`,
      );
    else report.add("login", "logged-out", "warn", `not logged in (${login})`, { fix: login });
    if (s.configDirectory !== undefined) {
      if (samePath(canon(s.configDirectory, L.home, L.platform), dir, L.platform))
        report.add("config-dir", "matches", "ok", "Claude Code reports this config dir");
      else
        report.add("config-dir", "differs", "fail", `Claude Code reports config dir ${s.configDirectory}, not ${dir}`, {
          problem: true,
        });
    }
    const secure = secureStorageOverride(dir, process.env, L.home, L.platform);
    if (secure !== undefined)
      report.add(
        SECURE_STORAGE_ENV,
        "elsewhere",
        "warn",
        `${SECURE_STORAGE_ENV} is set in this shell, so Claude Code keeps this profile's login in ${secure}. Unset it`,
        { fix: `unset ${SECURE_STORAGE_ENV}` },
      );
    if (s.apiKeySource)
      report.add(
        "login",
        "api-key",
        "warn",
        `Claude Code uses an API key from ${s.apiKeySource} instead of the profile login`,
      );
    if (await reportUpdates(L, report, dir, v, targets)) updaters.push(name);
    const env = readProfileEnv(dir);
    if (env.vars.length) report.add(ENV_FILE, "read", "ok", `${ENV_FILE}: ${env.vars.map(([k]) => k).join(", ")}`);
    const overlay = readProfileSettings(dir);
    if (overlay.error)
      report.add(
        SETTINGS_FILE,
        "broken",
        "fail",
        `${join(dir, SETTINGS_FILE)}: ${overlay.error}; claudep run refuses to start this profile until it is fixed`,
        { problem: true },
      );
    else if (Object.keys(overlay.settings).length)
      report.add(
        SETTINGS_FILE,
        "read",
        "ok",
        `${SETTINGS_FILE}: ${Object.keys(overlay.settings).join(", ")} (claudep run and alias commands only)`,
      );
    if (env.skipped.length)
      report.add(
        ENV_FILE,
        "skipped-lines",
        "fail",
        `${join(dir, ENV_FILE)}: lines ${env.skipped.join(", ")} are not KEY=VALUE with an allowed name and a value; nothing reads them`,
        { problem: true },
      );
  }
  if (!names.length) report.say(c.dim("\nNo profiles to check."));

  report.section(aliases);
  const deps = shimDeps(L);
  const reported = new Set<string>();
  for (const shim of findShims(deps.dirs, L.platform)) {
    if (only && shim.profile !== only) continue;
    const state = shimState(shim, deps);
    // On Windows one alias is two files, x.cmd and x. Same finding, one check.
    const finding = [shim.dir, shim.command, shim.profile, shim.target, state].join("|");
    if (reported.has(finding)) continue;
    reported.add(finding);
    const rewrite = `claudep alias ${shim.profile} ${shim.command}`;
    const lead = aliases.length ? undefined : "";
    if (state === "missing-target")
      report.add(
        shim.command,
        state,
        "fail",
        `alias ${shim.command} (${shim.path}) runs ${shim.target}, which is gone. Rewrite it: ${rewrite}`,
        { problem: true, fix: rewrite, lead },
      );
    else if (state === "missing-profile")
      report.add(
        shim.command,
        state,
        "fail",
        `alias ${shim.command} (${shim.path}) runs the profile "${shim.profile}", which does not exist. Create it (claudep init ${shim.profile}) or delete the file`,
        { problem: true, fix: `claudep init ${shim.profile}`, lead },
      );
    else if (state === "other-target")
      report.add(
        shim.command,
        state,
        "warn",
        `alias ${shim.command} (${shim.path}) runs another claudep: ${shim.target}. Point it at this one: ${rewrite}`,
        { fix: rewrite, lead },
      );
    else if (state === "shadowed")
      report.add(
        shim.command,
        state,
        "warn",
        `alias ${shim.command} (${shim.path}) never runs: an earlier PATH entry has the same name. Delete the file or fix PATH`,
        { lead },
      );
  }

  report.section(baseChecks);
  if (only) updaters = [];
  if ((kind === "npm" || kind === "bun") && updaters.length > 1)
    report.add(
      "auto-update",
      "several-updaters",
      "warn",
      `${updaters.length} config dirs run the auto-updater against one ${kind} install (${updaters.join(", ")}). Leave it on in one: claudep vars <name> DISABLE_AUTOUPDATER=1 for each of the others`,
      { lead: "" },
    );
  if (json)
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          claude,
          base: { dir: L.base, checks: baseChecks },
          profiles,
          aliases,
          problems: report.problems,
        },
        null,
        2,
      ),
    );
  else if (report.problems) console.log(`\n${c.red(`${report.problems} problem(s)`)}`);
  if (report.problems) process.exit(1);
}

async function cmdRm(L: Layout, args: string[]): Promise<void> {
  const f = parseFlags(args, ...flagSpec("rm"));
  const name = f.rest[0];
  if (!name) die("usage: claudep rm <name> [--keep-login] [--yes] [--force]");
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
    const unset = envUnsetHint(shellSyntax(process.env, L.platform, parentProcessName(L.platform)));
    warn(
      `this shell is on ${name} (${cur.setBy === "hook" ? "shell hook" : "manual pin"}). After removal run: ${unset}`,
    );
  }
  const pin = resolvePin(process.cwd());
  if (pin && pin.name === name)
    warn(
      `${shortHome(pin.file, L.home, L.platform)} pins this directory tree to ${name}. Remove it with: claudep local --remove`,
    );
  const live = liveSessions(L, [name]);
  if (live.length && !f.bools.has("--force"))
    die(
      `"${name}" has ${live.length} live session(s), pid ${live.map((r) => r.pid).join(", ")}. Logging out would revoke the token under them. Stop them first, or pass --force`,
    );
  if (!f.bools.has("--yes")) {
    const yes = confirm(`Remove profile "${name}" (${dir})? Shared items are only unlinked; ${L.base} is untouched.`);
    if (!yes) {
      console.log("aborted");
      return;
    }
  }
  if (!f.bools.has("--keep-login")) {
    const proc = await spawnClaude(L, dir, ["auth", "logout"], "inherit");
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
  for (const shim of findShims(shimDirs(L), L.platform))
    if (shim.profile === name) warn(`alias shim ${shim.path} still points at this profile. Remove it if unused`);
}

// ---------------------------------------------------------------------------
// Live sessions. Claude Code writes sessions/<pid>.json in its config dir for
// every running session. claudep reads only those files, keeps a fixed set of
// fields and checks the pid is still the process that wrote the record. The
// sessions dir also holds <pid>.<hash>.key files with a peer token; they are
// never opened (Never 3).
// ---------------------------------------------------------------------------

export const SESSION_FILE_RE = /^[0-9]+\.json$/;
const SESSION_MAX_BYTES = 262_144;

export type Session = {
  profile: string;
  pid: number;
  name?: string;
  status?: string;
  kind?: string;
  entrypoint?: string;
  cwd?: string;
  version?: string;
  startedAt?: number;
  /** ms since epoch when the status last changed, or the record was last written. */
  statusSince?: number;
};

export type SessionDeps = {
  list: (dir: string) => string[];
  read: (file: string) => string | undefined;
  /** True while a process with this pid exists. */
  alive: (pid: number) => boolean;
  /** The process's start time as Claude Code records it (field 22 of /proc/<pid>/stat), when known. */
  procStart: (pid: number) => string | undefined;
  /** This host's pid domain as Claude Code writes it, when known. */
  domain: string | undefined;
};

/** Field 22 of a /proc/<pid>/stat line: start time in clock ticks. The command
 *  name in field 2 can hold spaces and parentheses, so count from the last ")". */
export function procStartOf(stat: string): string | undefined {
  const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return tail[19];
}

const str = (o: JsonObject, k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);
const num = (o: JsonObject, k: string) =>
  typeof o[k] === "number" && Number.isFinite(o[k]) ? (o[k] as number) : undefined;

/** The live sessions in one config dir. A record whose pid is gone, was reused
 *  by another process, or belongs to another host or pid namespace is skipped. */
export function readSessions(
  profile: string,
  configDir: string,
  deps: SessionDeps,
  platform: NodeJS.Platform = process.platform,
): Session[] {
  const P = pathApi(platform);
  const dir = P.join(configDir, "sessions");
  const out: Session[] = [];
  let names: string[];
  try {
    names = deps.list(dir);
  } catch {
    return out;
  }
  for (const f of names) {
    if (!SESSION_FILE_RE.test(f)) continue;
    const pid = Number(f.slice(0, -5));
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    const text = deps.read(P.join(dir, f));
    if (text === undefined) continue;
    let o: JsonObject;
    try {
      const j: unknown = JSON.parse(text);
      if (!j || typeof j !== "object" || Array.isArray(j)) continue;
      o = j as JsonObject;
    } catch {
      continue;
    }
    const domain = str(o, "pidDomain");
    if (domain !== undefined && deps.domain !== undefined && domain !== deps.domain) continue;
    if (!deps.alive(pid)) continue;
    const recorded = str(o, "procStart");
    const actual = recorded === undefined ? undefined : deps.procStart(pid);
    if (recorded !== undefined && actual !== undefined && recorded !== actual) continue;
    out.push({
      profile,
      pid,
      name: str(o, "name"),
      status: str(o, "status"),
      kind: str(o, "kind"),
      entrypoint: str(o, "entrypoint"),
      cwd: str(o, "cwd"),
      version: str(o, "version"),
      startedAt: num(o, "startedAt"),
      statusSince: num(o, "statusUpdatedAt") ?? num(o, "updatedAt"),
    });
  }
  return out.sort((a, b) => a.pid - b.pid);
}

function hostSessionDeps(platform: NodeJS.Platform): SessionDeps {
  const linux = platform === "linux";
  let domain: string | undefined;
  if (linux) {
    try {
      const id = readFileSync("/etc/machine-id", "utf8").trim();
      let ns = "";
      try {
        ns = readlinkSync("/proc/self/ns/pid");
      } catch {}
      domain = `linux:${id}:${ns}`;
    } catch {}
  }
  return {
    list: (dir) => readdirSync(dir),
    read: (file) => {
      try {
        if (statSync(file).size > SESSION_MAX_BYTES) return undefined;
        return readFileSync(file, "utf8");
      } catch {
        return undefined;
      }
    },
    alive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    procStart: (pid) => {
      if (!linux) return undefined;
      try {
        return procStartOf(readFileSync(`/proc/${pid}/stat`, "utf8"));
      } catch {
        return undefined;
      }
    },
    domain,
  };
}

/** Live sessions for each named profile (`default` is the base). */
function liveSessions(L: Layout, names: readonly string[]): Session[] {
  const deps = hostSessionDeps(L.platform);
  return names.flatMap((n) => readSessions(n, n === "default" ? L.base : profileDir(L, n), deps, L.platform));
}

export function formatSessions(
  rows: readonly Session[],
  installed: Version | undefined,
  now: number,
  home: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const cols = ["PROFILE", "PID", "NAME", "STATUS", "KIND", "VERSION", "CWD"];
  const data = rows.map((r) => [
    r.profile,
    String(r.pid),
    r.name ?? "-",
    r.status
      ? `${r.status}${r.statusSince ? ` ${ageText(Math.floor(r.statusSince / 1000), now).replace(/ ago$/, "")}` : ""}`
      : "-",
    r.kind ?? "-",
    r.version ? `${r.version}${sessionStale(r, installed) ? " (old)" : ""}` : "-",
    r.cwd ? shortHome(r.cwd, home, platform) : "-",
  ]);
  const widths = cols.map((h, i) => Math.max(h.length, ...data.map((d) => (d[i] as string).length)));
  const fmt = (cells: string[]) =>
    cells
      .map((v, i) => v.padEnd(widths[i] as number))
      .join("  ")
      .trimEnd();
  return [fmt(cols), ...data.map((d) => fmt(d))];
}

/** True when the session runs a Claude Code older than the one installed now. */
export function sessionStale(r: Session, installed: Version | undefined): boolean {
  const v = r.version === undefined ? undefined : parseVersion(r.version);
  return v !== undefined && installed !== undefined && versionBelow(v, installed);
}

/** `claudep ps [name…] [--json] [--stale]`: live sessions in the base and every profile. */
async function cmdPs(L: Layout, args: string[]): Promise<void> {
  const f = parseFlags(args, ...flagSpec("ps"));
  const names = f.rest.length ? f.rest : ["default", ...listProfileNames(L)];
  for (const n of names) if (n !== "default" && !profileExists(L, n)) die(`profile "${n}" does not exist`);
  const installed = findClaude() ? await claudeVersion(L) : undefined;
  let rows = liveSessions(L, names);
  if (f.bools.has("--stale")) rows = rows.filter((r) => sessionStale(r, installed));
  const now = Math.floor(Date.now() / 1000);
  if (f.bools.has("--json")) {
    console.log(
      JSON.stringify(
        rows.map((r) => ({ ...r, stale: sessionStale(r, installed) })),
        null,
        2,
      ),
    );
    return;
  }
  if (!rows.length) {
    console.log(f.bools.has("--stale") ? "No session runs an older Claude Code." : "No live Claude Code sessions.");
    return;
  }
  const [header, ...lines] = formatSessions(rows, installed, now, L.home, L.platform);
  console.log(c.bold(header as string));
  for (const line of lines) console.log(line);
  if (rows.some((r) => sessionStale(r, installed)))
    console.log(
      c.dim(
        `\n(old): started before Claude Code ${installed?.join(".")} was installed; it picks up the update when restarted`,
      ),
    );
}

function help(L: Layout): void {
  console.log(helpText(L));
}

/** Hand-written on purpose: the layout says more than the table can. A test
 *  checks that every command in COMMANDS appears in it. */
export function helpText(L: Layout): string {
  const root = shortHome(L.profilesRoot, L.home, L.platform);
  return `${c.bold("claudep")} ${c.dim(version())}: run Claude Code under separate accounts on one machine

${c.bold("USAGE")}
  claudep <name> [claude args…]        run claude with profile <name>  (alias for "run")
  claudep init <name> [options]        create/update a profile; logs in when it has no login yet
  claudep list [--json] [--live]       show every profile and who it is logged in as
  claudep status <name> [--json] [--live]   login state for one profile ("default" = ~/.claude);
                                       before Claude Code 2.1.301 both read .claude.json unless --live
  claudep current [--json|--name]      which profile this shell is on, and why; --name prints only the name
  claudep env <name> | --unset         print the CLAUDE_CONFIG_DIR pin (or the unset) for eval, source or Invoke-Expression;
                                       --shell sh|fish|powershell picks the syntax when the shell was not detected
  claudep vars <name> [KEY=VALUE…]     list or set the variables the profile exports; --unset KEY… removes,
                                       --json lists as JSON
  claudep alias <name> <command>       write a shim so "<command>" == "claudep <name>"; rewrites one claudep wrote
  claudep alias [--json]               list every shim on PATH and its state
  claudep settings <name> [key=value…] settings claudep run gives <name> on top of the shared settings.json
                                       (values are JSON or a string); --unset key…, --json
  claudep handoff <name> [session-id]  resume this directory's latest session under <name>, as a fork;
                                       arguments after -- go to claude
  claudep hook --print                 the StopFailure settings block for shells that start plain claude;
                                       claudep run adds it on its own and exits 77 (login) or 75 (limit) in -p mode
  claudep usage [name…] [--json]       five-hour and weekly usage per profile; live from claude -p /usage on
                                       Claude Code 2.1.301+, else last seen (--live asks, --cached never does)
  claudep statusline                   pipe the statusline JSON in: prints "work · 5h 23% · 7d 41%" and
                                       remembers the numbers for claudep usage
  claudep doctor [name] [--json]       verify symlinks, keychain entry, unclassified files, shims, Claude Code version
  claudep doctor --accept <name> <item>   stop counting one shared item as a problem; --unaccept undoes it
  claudep ps [name…] [--json] [--stale]   live Claude Code sessions in every profile; --stale only older versions
  claudep rm <name> [--keep-login]     log out and delete a profile (base is never touched); refuses
                                       one with live sessions unless --force
  claudep help                         show this text
  claudep --version                    print the version

${c.bold("DIRECTORY PINS")}
  claudep local <name> [--force]       write ./${PIN_FILE} so this tree uses <name>; --remove deletes it
  claudep local                        show the pin that applies to the current directory
  claudep resolve [dir] [--json]       print the profile pinned for a directory (exit 1 when none)
  claudep shell-init [${SHELLS.join("|")}]   print the hook that applies pins on cd; load it from your rc file

${c.bold("TAB COMPLETION")}
  claudep completion [${COMPLETION_SHELLS.join("|")}]   print completions for commands, flags and profile names;
                                       load them from your rc file (after compinit in zsh) or $PROFILE

${c.bold("INIT OPTIONS")}
  --sso               force the SSO login flow (Enterprise orgs)
  --email <addr>      pre-fill the login page
  --console           log in with an Anthropic Console (API billing) account instead of a subscription
  --copy-mcp          copy user-scope MCP servers from the base .claude.json
  --alias <command>   also create a shim command, e.g. --alias eclaude
  --env KEY=VALUE     a variable the profile exports, as with claudep vars; repeat for more
  --no-login          set up files only; log in later with the command it prints
  A signed-in profile skips the login unless you pass --sso, --console or --email. Login flags are
  remembered in <profile>/claudep.login, so the next login uses them.
  --force             relink shared items whose symlinks point elsewhere

${c.bold("EXAMPLES")}
  claudep init enterprise --sso --email you@company.com --alias eclaude
  eclaude                                       # Claude Code as the enterprise account
  claude                                        # Claude Code as whatever ~/.claude is logged in as
  claudep enterprise -p "summarize this repo"
  eval "$(claudep env enterprise)"              # pin the whole shell to a profile
  claudep env enterprise | source               # the same from fish
  claudep env enterprise | Invoke-Expression    # the same from PowerShell
  claudep vars enterprise ANTHROPIC_PROFILE=work # this profile also picks a Console sign-in
  claudep local enterprise                      # pin this repo; commit the ${PIN_FILE} file for the team
  eval "$(claudep shell-init zsh)"              # in .zshrc: shells follow ${PIN_FILE} pins on cd
  ${hookHint("fish")}              # the same line for config.fish
  ${hookHint("powershell")}   # the same line for $PROFILE
  ${completionHint("zsh")}             # in .zshrc after compinit: tab completion

${c.bold("HOW IT WORKS")}
  ~/.claude stays exactly as it is and remains the "default" profile. Each named profile is a
  thin directory under ${root}/<name> that Claude Code is pointed at via
  CLAUDE_CONFIG_DIR. Inside it, shared config is a symlink back into ~/.claude:
    ${[...SHARED_FILES, "*.md", ...SHARED_DIRS].join("  ")}
  Everything account-specific is real and per profile: .claude.json (login identity, MCP
  servers, folder trust), org-pushed remote-settings.json, history, todos, caches.
  "claudep <name>" links any of the listed files and directories the profile is missing before it
  starts claude, except a *.md outside that list, which waits for claudep init.
  On macOS credentials never touch the profile dir: Claude Code stores them in the Keychain under
  "Claude Code-credentials-<sha256(CLAUDE_CONFIG_DIR)[0:8]>", so every profile has its own
  login and refresh token and they cannot clobber each other. On Linux and Windows the login is
  <profile>/.credentials.json, a real file inside the profile that is never shared.

${c.bold("PIN RULES")}
  The nearest ${PIN_FILE} file upward from the current directory wins; an empty one cancels a
  parent pin. The hook only changes a CLAUDE_CONFIG_DIR it set itself (tracked in CLAUDEP_AUTO),
  so a manual pin from "claudep env" stays put. Leaving every pinned tree returns the shell to
  ~/.claude.

${c.bold("PROFILE VARIABLES")}
  <profile>/${ENV_FILE} holds KEY=VALUE lines that "claudep <name>", "claudep env" and the hook
  export with the profile, e.g. CLAUDE_CODE_USE_BEDROCK=1 or ANTHROPIC_PROFILE=work. It is read as
  data, never run. A variable you set yourself always wins. CLAUDE_CONFIG_DIR,
  CLAUDE_SECURESTORAGE_CONFIG_DIR, CLAUDEP_* and credential variables are refused.

${c.bold("ENVIRONMENT")}
  CLAUDE_PROFILES_DIR   where profiles live (default ~/.claudep; keep it out of iCloud/Dropbox)
  CLAUDEP_AUTO          set by the hook next to CLAUDE_CONFIG_DIR; marks the pin as hook-managed
  CLAUDEP_RUN           set by claudep <name>, run, handoff and alias commands in claude's environment: the profile dir
  CLAUDEP_MANAGED_DIR   where doctor reads managed settings (default ${managedSettingsDir(L.platform)})
  CLAUDEP_TIMEOUT       seconds list, status, usage and doctor wait for each claude (default ${DEFAULT_TIMEOUT_S}; 0 waits forever)
  ${ENV_KEYS_VAR}      the variables a ${ENV_FILE} put in this shell, cleared again on leaving

${c.dim("claudep is an independent, unofficial tool. It is not affiliated with, endorsed by or supported by Anthropic.")}
`;
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
    case "completion":
      return cmdCompletion(L, args);
    case "version":
    case "--version":
    case "-v":
      console.log(version());
      return;
    case "vars":
      return cmdVars(L, args);
    case "alias":
      return cmdAlias(L, args);
    case "handoff":
      return cmdHandoff(L, args);
    case "ps":
      return cmdPs(L, args);
    case "hook":
      return cmdHook(L, args);
    case "statusline":
      return cmdStatusline(L);
    case "usage":
      return cmdUsage(L, args);
    case "settings":
      return cmdSettings(L, args);
    case "doctor":
      return cmdDoctor(L, args);
    case "rm":
    case "remove":
      return cmdRm(L, args);
    default:
      if (cmd === "default" || cmd === "base" || profileExists(L, cmd)) return cmdRun(L, [cmd, ...args]);
      if (NAME_RE.test(cmd)) die(`no profile "${cmd}". Create it with: claudep init ${cmd}`, EXIT.noProfile);
      die(`unknown command "${cmd}". Try: claudep help`, EXIT.usage);
  }
}

if (import.meta.main) await main(Bun.argv.slice(2));
