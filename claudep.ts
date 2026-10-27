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

/** Per-profile state. First block is Claude Code's own runtime-state list as of
 *  2.1.263, then observed extras, then what 2.1.280 added to that list. Never
 *  shared, and a name here is never shared by the top-level *.md rule either. */
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
  // claudep's own per-profile files.
  "claudep.env",
  "claudep.settings.json",
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
    desc: "create or update a profile and log in",
    arg: "profile",
    flags: ["--sso", "--console", "--copy-mcp", "--no-login", "--force"],
    valueFlags: [{ name: "--email" }, { name: "--alias" }, { name: "--env" }],
  },
  { name: "run", desc: "run claude with a profile", arg: "profile", hidden: true },
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
  { name: "alias", desc: "write a shim command that runs claudep with a profile", arg: "profile" },
  { name: "handoff", desc: "resume this directory's latest session under another profile", arg: "profile" },
  { name: "statusline", desc: "print the profile and its usage from the statusline JSON on stdin" },
  {
    name: "usage",
    desc: "five-hour and weekly usage for every profile",
    arg: "profile",
    flags: ["--json", "--live", "--cached"],
  },
  { name: "doctor", desc: "verify symlinks, keychain entry, unclassified files, Claude Code version", arg: "profile" },
  {
    name: "rm",
    desc: "log out and delete a profile",
    aliases: ["remove"],
    arg: "profile",
    flags: ["--keep-login", "--yes"],
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
  if (k.startsWith("CLAUDEP_")) return "CLAUDEP_ variables belong to claudep";
  if ((AUTH_ENV as readonly string[]).includes(k)) return "claudep never stores credentials";
  return undefined;
}

const REFUSED_ENV = ["CLAUDE_CONFIG_DIR", "CLAUDEP_*", ...AUTH_ENV];

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
  const env = (await readJson(settingsPath))?.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return {};
  const out: Env = {};
  for (const [k, v] of Object.entries(env as JsonObject)) if (typeof v === "string") out[k] = v;
  return out;
}

export type AutoUpdate = { enabled: boolean; by?: string };

/** Whether Claude Code's background updater runs for a config dir, in the
 *  order Claude Code 2.1.286 checks: three variables, then `autoUpdates` in
 *  .claude.json, which a native install ignores once it has set
 *  `autoUpdatesProtectedForNative`. `sources` are labelled environments,
 *  strongest first. */
export function autoUpdateState(sources: readonly [string, Env][], globalJson: JsonObject | undefined): AutoUpdate {
  for (const key of ["DISABLE_UPDATES", "DISABLE_AUTOUPDATER", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]) {
    const hit = sources.find(([, env]) => /^(1|true|yes|on)$/i.test((env[key] ?? "").trim()));
    if (hit) return { enabled: false, by: `${key} in ${hit[0]}` };
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

/** True when the running Claude Code is newer than the version a config dir's
 *  last update record ends on, so something other than its own updater (npm,
 *  a package manager, another config dir) moved it since. */
export function updatedOutside(last: LastUpdate | undefined, running: Version | undefined): boolean {
  const to = last?.to ? parseVersion(last.to) : undefined;
  return !!to && !!running && versionBelow(to, running);
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
    );
  if (launch.kind === "ps1")
    die(
      `only ${launch.bin} was found. Install Claude Code with the native installer or npm so claude.exe or claude.cmd exists: https://code.claude.com/docs/en/setup`,
    );
  return launch;
}

async function spawnClaude(L: Layout, dir: string | undefined, args: string[], io: "inherit" | "pipe") {
  const { cmd, verbatim } = claudeSpawn(await claudeLaunch(L), args);
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
  // Variables a profile's claudep.env put in this shell are not the base's.
  for (const k of exportedEnvKeys(env)) deleteEnv(out, k, L.platform);
  deleteEnv(out, ENV_KEYS_VAR, L.platform);
  return out;
}

function claudeEnv(L: Layout, dir: string | undefined): Env {
  if (dir === undefined) return baseEnv(L);
  return withProfileVars(readProfileEnv(dir).vars, envFor(dir, process.env, L.platform), L.platform);
}

async function execClaude(L: Layout, dir: string | undefined, args: string[]): Promise<never> {
  const proc = await spawnClaude(L, dir, args, "inherit");
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
  const proc = await spawnClaude(L, dir, args, "pipe");
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
  /** firstParty, bedrock, vertex, foundry. */
  apiProvider?: string;
  /** Where an API key came from, e.g. ANTHROPIC_API_KEY or apiKeyHelper. Absent without one. */
  apiKeySource?: string;
  /** The config dir Claude Code resolved (2.1.268+). */
  configDirectory?: string;
  /** Read from the profile's .claude.json instead of asking Claude Code. */
  cached?: boolean;
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

async function authStatus(L: Layout, dir: string | undefined): Promise<AuthStatus> {
  const { out } = await captureClaude(L, dir, ["auth", "status", "--json"]);
  return parseAuthStatus(out);
}

async function claudeVersion(L: Layout): Promise<Version | undefined> {
  return parseVersion((await captureClaude(L, undefined, ["--version"])).out);
}

/** `claude auth status` when it is safe or `live` asks for it, otherwise the .claude.json record. */
async function loginOf(L: Layout, dir: string | undefined, live: boolean): Promise<AuthStatus> {
  if (live) return authStatus(L, dir);
  return cachedAuthStatus(await readJson(dir === undefined ? L.baseGlobalJson : join(dir, ".claude.json")));
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

  if (newVars.length) {
    writeFileSync(join(dir, ENV_FILE), editEnvText(readEnvText(dir), name, newVars, []));
    ok(`${ENV_FILE}: ${newVars.map(([k]) => k).join(", ")}`);
  }

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
  const overlay = readProfileSettings(dir);
  if (overlay.error)
    die(`${join(dir, SETTINGS_FILE)}: ${overlay.error}. Fix it, or: claudep settings ${name} --unset <key>`);
  if (rest.some((a) => a === "--settings" || a.startsWith("--settings="))) {
    if (Object.keys(overlay.settings).length)
      console.error(`claudep: you passed --settings, so ${join(dir, SETTINGS_FILE)} is not applied`);
    return execClaude(L, dir, rest);
  }
  const settings = runSettings(memoryDirOverride(dir, process.cwd(), rest, process.env, L.platform), overlay.settings);
  if (settings) rest.unshift("--settings", JSON.stringify(settings));
  return execClaude(L, dir, rest);
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
  if (!name || name.startsWith("-")) die(usage);
  let rest = args.slice(1);
  let id: string | undefined;
  if (rest[0] !== undefined && rest[0] !== "--") {
    id = rest.shift();
    if (!id || !SESSION_ID_RE.test(id)) die(`"${id}" is not a session id. ${usage}`);
  }
  if (rest[0] === "--") rest = rest.slice(1);
  const target = name === "default" || name === "base" ? L.base : profileDir(L, name);
  if (target !== L.base && !existsSync(target)) die(`profile "${name}" does not exist. Run: claudep init ${name}`);
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

export type Row = { name: string; dir: string; status: AuthStatus };

async function collectRows(L: Layout, names: string[], live: boolean): Promise<{ rows: Row[]; v?: Version }> {
  const v = await claudeVersion(L);
  const ask = live || authStatusSafe(v);
  const rows = await Promise.all(
    names.map(async (name) => {
      const dir = name === "default" ? L.base : profileDir(L, name);
      return { name, dir, status: await loginOf(L, name === "default" ? undefined : dir, ask) };
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
    `${r.status.loggedIn ? "yes" : "no"}${r.status.cached ? "*" : ""}`,
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
  if (rows.some((r) => r.status.cached)) console.log(c.dim(`\n${cachedNote(v)}`));
}

/** The flat object `status --json` prints for one row; `list --json` prints an array of them. */
function rowJson(row: Row): JsonObject {
  return { name: row.name, dir: row.dir, ...row.status };
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
  if (f.bools.has("--json")) console.log(JSON.stringify(rowJson(row), null, 2));
  else printTable([row], L.home, L.platform, v);
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

/** The --settings value `run` passes: the auto-memory path, then the profile's overlay, which wins. */
export function runSettings(memoryDir: string | undefined, overlay: JsonObject): JsonObject | undefined {
  const out: JsonObject = { ...(memoryDir === undefined ? {} : { autoMemoryDirectory: memoryDir }), ...overlay };
  return Object.keys(out).length ? out : undefined;
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
  const how = cur.setBy === "hook" ? "shell hook" : cur.setBy === "manual" ? "manual pin" : "nothing pinned";
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

export type UsageRow = { name: string; usage?: Usage; live: boolean };

export function formatUsageTable(rows: UsageRow[], now: number): string[] {
  const cols = ["PROFILE", "5H", "RESETS", "7D", "RESETS", "SEEN"];
  const pct = (w?: UsageWindow) => (w ? `${Math.round(w.usedPercentage)}%` : "-");
  const data = rows.map((r) => [
    r.name,
    pct(r.usage?.fiveHour),
    resetsText(r.usage?.fiveHour),
    pct(r.usage?.sevenDay),
    resetsText(r.usage?.sevenDay),
    r.usage ? (r.live ? "now" : `${ageText(r.usage.at, now)} (${r.usage.source})`) : "never",
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
        const fresh = parseUsageOutput((await captureClaude(L, dir, args)).out, now);
        if (fresh) {
          try {
            writeUsageCache(L, name, fresh, old);
          } catch {}
          return { name, usage: fresh, live: true };
        }
      }
      return { name, usage: old, live: false };
    }),
  );
  if (f.bools.has("--json")) {
    console.log(
      JSON.stringify(
        rows.map((r) => ({ name: r.name, live: r.live, ...r.usage })),
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

/** Prints whether Claude Code's updater runs for a config dir (undefined is
 *  the base) and its last update; true when the updater is on. */
async function reportUpdates(L: Layout, dir: string | undefined, running: Version | undefined): Promise<boolean> {
  const d = dir ?? L.base;
  const sources: [string, Env][] = [
    ["settings.json env", await settingsEnv(join(d, "settings.json"))],
    ["this shell", baseEnv(L)],
  ];
  if (dir !== undefined) sources.push([ENV_FILE, Object.fromEntries(readProfileEnv(dir).vars)]);
  const state = autoUpdateState(
    sources,
    await readJson(dir === undefined ? L.baseGlobalJson : join(dir, ".claude.json")),
  );
  const who = dir === undefined ? "default: " : "";
  console.log(`${c.dim("·")} ${who}auto-update ${state.enabled ? "on" : `off (${state.by})`}`);
  const last = await lastUpdate(d);
  if (last?.to)
    console.log(
      `${c.dim("·")} ${who}last update ${last.from ?? "?"} → ${last.to} (${last.outcome ?? "?"}, ${last.path ?? "?"}, ${(last.at ?? "").slice(0, 10)})${updatedOutside(last, running) ? `; running ${running?.join(".")}, updated outside Claude Code since` : ""}`,
    );
  return state.enabled;
}

async function cmdDoctor(L: Layout, args: string[]): Promise<void> {
  const names = args[0] ? [args[0]] : listProfileNames(L);
  let problems = 0;
  let v: Version | undefined;
  let kind: InstallKind | undefined;
  const launch = findClaude();
  if (launch && launch.kind !== "ps1") {
    const { out } = await captureClaude(L, undefined, ["--version"]);
    ok(`claude: ${launch.bin} (${out.trim() || "version unknown"})`);
    let real = launch.bin;
    try {
      real = realpathSync(launch.bin);
    } catch {}
    kind = installKind(launch.bin, real, L.platform);
    if (launch.kind === "cmd")
      console.log(
        `${c.dim("·")} claude is the npm cmd shim and runs through cmd.exe; the native installer's claude.exe avoids that hop`,
      );
    v = parseVersion(out);
    const floor = parseVersion(MIN_CLAUDE_VERSION);
    if (L.platform === "darwin" && v && floor && versionBelow(v, floor)) {
      bad(
        `Claude Code ${v.join(".")} is older than ${MIN_CLAUDE_VERSION}; every config dir shares one Keychain item there, so profiles cannot hold separate logins. Update Claude Code`,
      );
      problems++;
    }
  } else if (launch) bad(`only ${launch.bin} found; claudep needs claude.exe or claude.cmd`);
  else bad("claude binary not found on PATH");
  if (kind === "npm" || kind === "bun")
    warn(
      `claude is ${kind === "npm" ? "an" : "a"} ${kind}-global install. Every profile runs its own auto-updater against it, and a reinstall removes claude while it runs, so a launch can find nothing (${NPM_RACE_ISSUE}). claudep run waits for an update it can see; the native installer swaps versions in one step: claude install`,
    );
  else if (kind) console.log(`${c.dim("·")} install: ${kind}`);
  const all = findAllClaude();
  if (all.length > 1)
    warn(
      `more than one claude on PATH; the first one runs, and a later one starts if it goes missing: ${all.join(", ")}`,
    );
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
  const ask = authStatusSafe(v);
  if (launch && !ask)
    warn(
      `Claude Code ${v?.join(".") ?? "of unknown version"} can sign a profile out on a short \`claude auth status\` (${AUTH_STATUS_ISSUE}). claudep reads logins from .claude.json instead until Claude Code is ${SAFE_AUTH_STATUS_FROM} or newer: claude update`,
    );
  let updaters: string[] = [];
  if (await reportUpdates(L, undefined, v)) updaters.push("default");

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
  if (memoryWritesPrompt(v, shared))
    warn(
      `Claude Code ${v?.join(".")} asks for approval on every auto-memory write in a profile, because projects/ is shared through a symlink; auto mode cannot approve it. claudep run and alias commands pass the real memory path and avoid it; plain claude in a hooked shell still asks. Known upstream bug: ${MEMORY_SYMLINK_ISSUE}`,
    );

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
    for (const n of staleSharedLinks(L.base, dir, L.platform)) {
      bad(
        `${n}: linked to the base by an older claudep, but it is per-profile state now. Remove the symlink: ${join(dir, n)}`,
      );
      problems++;
    }
    const s = await loginOf(L, dir, ask);
    if (L.platform === "darwin") {
      const svc = keychainService(dir);
      if (await keychainHas(svc)) ok(`keychain item "${svc}" present`);
      else warn(`no keychain item "${svc}". Not logged in yet (claudep ${name} auth login)`);
    } else if (credentialsFileHas(dir)) ok(".credentials.json present");
    else if (s.loggedIn)
      console.log(
        `${c.dim("·")} no .credentials.json in the profile; Claude Code keeps this login elsewhere (on Windows, possibly Credential Manager)`,
      );
    else warn(`no .credentials.json in the profile. Not logged in yet (claudep ${name} auth login)`);
    if (s.cached && s.loggedIn) ok(`last known account: ${s.email ?? "?"} (${s.orgName ?? "?"}), from .claude.json`);
    else if (s.cached) warn("no account recorded in .claude.json");
    else if (s.loggedIn) ok(`logged in as ${s.email ?? "?"} (${s.orgName ?? "?"}, ${s.subscriptionType ?? "?"})`);
    else warn("not logged in");
    if (s.configDirectory !== undefined) {
      if (samePath(canon(s.configDirectory, L.home, L.platform), dir, L.platform))
        ok(`Claude Code reports this config dir`);
      else {
        bad(`Claude Code reports config dir ${s.configDirectory}, not ${dir}`);
        problems++;
      }
    }
    if (s.apiKeySource) warn(`Claude Code uses an API key from ${s.apiKeySource} instead of the profile login`);
    if (await reportUpdates(L, dir, v)) updaters.push(name);
    const env = readProfileEnv(dir);
    if (env.vars.length) ok(`${ENV_FILE}: ${env.vars.map(([k]) => k).join(", ")}`);
    const overlay = readProfileSettings(dir);
    if (overlay.error) {
      bad(`${join(dir, SETTINGS_FILE)}: ${overlay.error}; claudep run refuses to start this profile until it is fixed`);
      problems++;
    } else if (Object.keys(overlay.settings).length)
      ok(`${SETTINGS_FILE}: ${Object.keys(overlay.settings).join(", ")} (claudep run and alias commands only)`);
    if (env.skipped.length) {
      bad(
        `${join(dir, ENV_FILE)}: lines ${env.skipped.join(", ")} are not KEY=VALUE with an allowed name and a value; nothing reads them`,
      );
      problems++;
    }
  }
  if (!names.length) console.log(c.dim("\nNo profiles to check."));
  if (args[0]) updaters = [];
  if ((kind === "npm" || kind === "bun") && updaters.length > 1)
    warn(
      `\n${updaters.length} config dirs run the auto-updater against one ${kind} install (${updaters.join(", ")}). Leave it on in one: claudep vars <name> DISABLE_AUTOUPDATER=1 for each of the others`,
    );
  if (problems) {
    console.log(`\n${c.red(`${problems} problem(s)`)}`);
    process.exit(1);
  }
}

async function cmdRm(L: Layout, args: string[]): Promise<void> {
  const f = parseFlags(args, ...flagSpec("rm"));
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
  console.log(helpText(L));
}

/** Hand-written on purpose: the layout says more than the table can. A test
 *  checks that every command in COMMANDS appears in it. */
export function helpText(L: Layout): string {
  const root = shortHome(L.profilesRoot, L.home, L.platform);
  return `${c.bold("claudep")} ${c.dim(version())}: run Claude Code under separate accounts on one machine

${c.bold("USAGE")}
  claudep <name> [claude args…]        run claude with profile <name>  (alias for "run")
  claudep init <name> [options]        create/update a profile and log in
  claudep list [--json] [--live]       show every profile and who it is logged in as
  claudep status <name> [--json] [--live]   login state for one profile ("default" = ~/.claude);
                                       before Claude Code 2.1.301 both read .claude.json unless --live
  claudep current [--json|--name]      which profile this shell is on, and why; --name prints only the name
  claudep env <name> | --unset         print the CLAUDE_CONFIG_DIR pin (or the unset) for eval, source or Invoke-Expression;
                                       --shell sh|fish|powershell picks the syntax when the shell was not detected
  claudep vars <name> [KEY=VALUE…]     list or set the variables the profile exports; --unset KEY… removes,
                                       --json lists as JSON
  claudep alias <name> <command>       write a shim so "<command>" == "claudep <name>"
  claudep settings <name> [key=value…] settings claudep run gives <name> on top of the shared settings.json
                                       (values are JSON or a string); --unset key…, --json
  claudep handoff <name> [session-id]  resume this directory's latest session under <name>, as a fork;
                                       arguments after -- go to claude
  claudep usage [name…] [--json]       five-hour and weekly usage per profile; live from claude -p /usage on
                                       Claude Code 2.1.301+, else last seen (--live asks, --cached never does)
  claudep statusline                   pipe the statusline JSON in: prints "work · 5h 23% · 7d 41%" and
                                       remembers the numbers for claudep usage
  claudep doctor [name]                verify symlinks, keychain entry, unclassified files, Claude Code version
  claudep rm <name> [--keep-login]     log out and delete a profile (base is never touched)
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
  --no-login          set up files only; log in later with: claudep <name> auth login
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
  data, never run. A variable you set yourself always wins. CLAUDE_CONFIG_DIR, CLAUDEP_* and
  credential variables are refused.

${c.bold("ENVIRONMENT")}
  CLAUDE_PROFILES_DIR   where profiles live (default ~/.claudep; keep it out of iCloud/Dropbox)
  CLAUDEP_AUTO          set by the hook next to CLAUDE_CONFIG_DIR; marks the pin as hook-managed
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
      if (NAME_RE.test(cmd)) die(`no profile "${cmd}". Create it with: claudep init ${cmd}`);
      die(`unknown command "${cmd}". Try: claudep help`);
  }
}

if (import.meta.main) await main(Bun.argv.slice(2));
