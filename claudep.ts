#!/usr/bin/env bun
/**
 * claudep — run Claude Code under separate accounts on one machine.
 *
 * Keeps ~/.claude as the untouched "default" profile and creates thin overlay
 * profiles under ~/.claude-profiles/<name>. Shared config (CLAUDE.md, settings,
 * skills, plugins, hooks, agents, sessions/memory) is symlinked back into the
 * base; credentials, .claude.json and runtime state are per profile.
 *
 * Claude Code namespaces its macOS Keychain entry by CLAUDE_CONFIG_DIR
 * ("Claude Code-credentials-<sha256(dir)[0:8]>"), so each profile is a fully
 * separate login. Run `claudep help` for usage.
 *
 * Zero dependencies. Requires bun >= 1.1 and a `claude` binary on PATH.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  chmodSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const HOME = homedir();

/** Canonical form of a config dir: absolute, no trailing slash, NFC.
 *  Claude Code hashes the *literal* CLAUDE_CONFIG_DIR string for the keychain
 *  service name, so the same profile must always produce the same string. */
function canon(p: string): string {
  const expanded = p.startsWith("~/") ? join(HOME, p.slice(2)) : p;
  return resolve(expanded).replace(/\/+$/, "").normalize("NFC");
}

const CALLER_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
const BASE = canon(CALLER_CONFIG_DIR ?? join(HOME, ".claude"));
/** Global state file for the base profile. Without CLAUDE_CONFIG_DIR it lives
 *  at ~/.claude.json; with it, inside the config dir. */
const BASE_GLOBAL_JSON = CALLER_CONFIG_DIR ? join(BASE, ".claude.json") : join(HOME, ".claude.json");
const PROFILES_ROOT = canon(process.env.CLAUDE_PROFILES_DIR ?? join(HOME, ".claude-profiles"));

/** Top-level base items symlinked into every profile (only if they exist). */
const SHARED_FILES = ["CLAUDE.md", "settings.json", "keybindings.json", "statusline-command.sh"] as const;
const SHARED_DIRS = ["hooks", "skills", "commands", "agents", "plugins", "plans", "projects"] as const;

/** Per-profile state. First block is Claude Code's own runtime-state list;
 *  the rest are observed extras. Never shared. */
const KNOWN_PRIVATE = new Set<string>([
  ".claude.json", ".claude.json.backup", ".credentials.json", "sessions", "todos",
  "shell-snapshots", "statsig", "file-history", "history.jsonl", "ide", "logs", "backups",
  ".session_ingress_token",
  "remote-settings.json", "policy-limits.json", "stats-cache.json", "mcp-needs-auth-cache.json",
  "telemetry", "debug", "cache", "daemon", "daemon.log", "tasks", "jobs", "session-env",
  "paste-cache", "scheduled-tasks", "chrome", "feedback", "local", "settings.local.json",
  ".DS_Store", ".config.json", ".last-cleanup", ".last-update-result.json", "daemon-auth-cooldown", "daemon-auth-status.json",
]);

/** Keys copied from the base .claude.json into a fresh profile so first-run
 *  onboarding does not repeat. Account identity is deliberately excluded. */
const SEED_KEYS = [
  "hasCompletedOnboarding", "lastOnboardingVersion", "theme", "editorMode",
  "preferredNotifChannel", "shiftEnterKeyBindingInstalled", "autoUpdates", "installMethod",
] as const;

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const RESERVED = new Set(["default", "base", "init", "run", "list", "ls", "status", "env", "doctor", "rm", "remove", "alias", "help"]);

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const tty = Boolean(process.stdout.isTTY);
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

function die(msg: string, code = 1): never {
  console.error(`${c.red("error:")} ${msg}`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Profile helpers
// ---------------------------------------------------------------------------

function profileDir(name: string): string {
  if (!NAME_RE.test(name)) die(`invalid profile name "${name}" (use [a-z0-9_-], starting with a letter or digit)`);
  if (RESERVED.has(name)) die(`"${name}" is a reserved word and cannot be a profile name`);
  return canon(join(PROFILES_ROOT, name));
}

function profileExists(name: string): boolean {
  return NAME_RE.test(name) && !RESERVED.has(name) && existsSync(join(PROFILES_ROOT, name));
}

function listProfileNames(): string[] {
  if (!existsSync(PROFILES_ROOT)) return [];
  return readdirSync(PROFILES_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && NAME_RE.test(d.name) && !RESERVED.has(d.name))
    .map((d) => d.name)
    .sort();
}

function keychainService(dir: string): string {
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

type SharedItem = { name: string; kind: "file" | "dir" };

/** Shared items that actually exist in the base right now. */
function sharedItems(): SharedItem[] {
  const items: SharedItem[] = [];
  const seen = new Set<string>();
  const push = (name: string, kind: SharedItem["kind"]) => {
    if (seen.has(name)) return;
    if (!existsSync(join(BASE, name))) return;
    seen.add(name);
    items.push({ name, kind });
  };
  for (const f of SHARED_FILES) push(f, "file");
  if (existsSync(BASE)) {
    for (const entry of readdirSync(BASE, { withFileTypes: true })) {
      if (entry.name.endsWith(".md") && !entry.isDirectory()) push(entry.name, "file");
    }
  }
  for (const d of SHARED_DIRS) push(d, "dir");
  return items;
}

type LinkResult = "linked" | "ok" | "wrong-target" | "conflict";

/** Idempotent symlink profile/<name> -> base/<name>. Never overwrites real files. */
function link(dir: string, name: string, force: boolean): LinkResult {
  const target = join(BASE, name);
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

type JsonObject = Record<string, unknown>;

async function readJson(path: string): Promise<JsonObject | undefined> {
  try {
    const parsed: unknown = JSON.parse(await Bun.file(path).text());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : undefined;
  } catch {
    return undefined;
  }
}

async function seedGlobalJson(dir: string, copyMcp: boolean): Promise<"seeded" | "exists" | "no-base"> {
  const dest = join(dir, ".claude.json");
  if (existsSync(dest)) return "exists";
  const base = await readJson(BASE_GLOBAL_JSON);
  if (!base) return "no-base";
  const seed: JsonObject = {};
  for (const k of SEED_KEYS) if (k in base) seed[k] = base[k];
  if (copyMcp && base.mcpServers && typeof base.mcpServers === "object") seed.mcpServers = base.mcpServers;
  await Bun.write(dest, JSON.stringify(seed, null, 2) + "\n");
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

type ProfileEnv = Record<string, string | undefined>;

/** Environment for a profile. `undefined` dir means "the base", i.e. leave the
 *  caller's CLAUDE_CONFIG_DIR exactly as it is (set or unset). */
function envFor(dir: string | undefined): ProfileEnv {
  const env: ProfileEnv = { ...process.env };
  if (dir !== undefined) env.CLAUDE_CONFIG_DIR = dir;
  return env;
}

async function execClaude(dir: string | undefined, args: string[]): Promise<never> {
  const proc = Bun.spawn([claudeBin(), ...args], {
    env: envFor(dir),
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

async function captureClaude(dir: string | undefined, args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([claudeBin(), ...args], {
    env: envFor(dir),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, out };
}

type AuthStatus = {
  loggedIn: boolean;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
  authMethod?: string;
};

async function authStatus(dir: string | undefined): Promise<AuthStatus> {
  const { out } = await captureClaude(dir, ["auth", "status", "--json"]);
  try {
    const j: unknown = JSON.parse(out);
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

async function keychainHas(service: string): Promise<boolean | undefined> {
  if (process.platform !== "darwin") return undefined;
  const proc = Bun.spawn(["security", "find-generic-password", "-s", service, "-a", userInfo().username], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
}

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

type Flags = { bools: Set<string>; strs: Map<string, string>; rest: string[] };

function parseFlags(args: string[], boolNames: readonly string[], strNames: readonly string[]): Flags {
  const flags: Flags = { bools: new Set(), strs: new Map(), rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (boolNames.includes(a)) {
      flags.bools.add(a);
    } else if (strNames.includes(a)) {
      const v = args[i + 1];
      if (v === undefined) die(`${a} requires a value`);
      flags.strs.set(a, v);
      i++;
    } else if (a.startsWith("--") && [...strNames].some((s) => a.startsWith(`${s}=`))) {
      const [k, ...v] = a.split("=");
      flags.strs.set(k!, v.join("="));
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

async function cmdInit(args: string[]): Promise<void> {
  const f = parseFlags(args, ["--copy-mcp", "--no-login", "--sso", "--console", "--force"], ["--email", "--alias"]);
  const name = f.rest[0];
  if (!name) die("usage: claudep init <name> [--copy-mcp] [--no-login] [--sso] [--email <e>] [--console] [--alias <cmd>] [--force]");
  if (!existsSync(BASE)) die(`base config dir ${BASE} does not exist — run \`claude\` once first`);
  const dir = profileDir(name);
  const fresh = !existsSync(dir);
  mkdirSync(dir, { recursive: true });
  console.log(`${c.bold(fresh ? "Creating" : "Updating")} profile ${c.bold(name)} at ${dir}`);

  let conflicts = 0;
  for (const item of sharedItems()) {
    const r = link(dir, item.name, f.bools.has("--force"));
    if (r === "linked") ok(`${item.name} → shared`);
    else if (r === "ok") console.log(`${c.dim("·")} ${item.name} ${c.dim("already shared")}`);
    else if (r === "wrong-target") { warn(`${item.name} is a symlink to somewhere else (re-run with --force to relink)`); conflicts++; }
    else { warn(`${item.name} is a real file/dir inside the profile — left alone (move it away to share)`); conflicts++; }
  }

  const seeded = await seedGlobalJson(dir, f.bools.has("--copy-mcp"));
  if (seeded === "seeded") ok(`.claude.json seeded${f.bools.has("--copy-mcp") ? " (with user-scope MCP servers)" : ""}`);
  else if (seeded === "exists") console.log(`${c.dim("·")} .claude.json ${c.dim("already present")}`);
  else warn(`could not read ${BASE_GLOBAL_JSON}; Claude Code will run its first-time onboarding`);

  if (f.strs.has("--alias")) writeAlias(name, f.strs.get("--alias")!);

  if (conflicts) warn(`${conflicts} item(s) need attention — see above`);

  if (f.bools.has("--no-login")) {
    console.log(`\nNext: ${c.bold(`claudep ${name} auth login`)}`);
    return;
  }
  const loginArgs = ["auth", "login"];
  if (f.bools.has("--sso")) loginArgs.push("--sso");
  if (f.bools.has("--console")) loginArgs.push("--console");
  if (f.strs.has("--email")) loginArgs.push("--email", f.strs.get("--email")!);
  console.log(`\n${c.bold("Logging in")} to profile ${name} …`);
  await execClaude(dir, loginArgs);
}

function scriptDir(): string {
  return dirname(realpathSync(Bun.main));
}

/** Directory where alias shims are written: next to the `claudep` command on
 *  PATH (usually a symlink into the repo), falling back to the script dir. */
function aliasDir(): string {
  const onPathBin = Bun.which("claudep");
  return onPathBin ? dirname(onPathBin) : scriptDir();
}

/** True when some PATH entry resolves (through symlinks) to `dir`. */
function onPath(dir: string): boolean {
  const want = realpathSync(dir);
  return (process.env.PATH ?? "").split(":").some((p) => {
    try { return realpathSync(canon(p)) === want; } catch { return false; }
  });
}

/** Write a tiny shim `<cmd>` next to this script: `exec claudep <name> "$@"`. */
function writeAlias(name: string, cmd: string): void {
  if (!NAME_RE.test(cmd)) die(`invalid alias command name "${cmd}"`);
  const dest = join(aliasDir(), cmd);
  const self = realpathSync(Bun.main);
  if (existsSync(dest)) {
    const current = Bun.file(dest);
    if (!lstatSync(dest).isSymbolicLink() && current.size > 0) {
      warn(`${dest} already exists — not overwriting (remove it first to regenerate)`);
      return;
    }
  }
  const shim = `#!/bin/sh\n# generated by claudep — runs Claude Code under the "${name}" profile\nexec bun "${self}" run ${name} -- "$@"\n`;
  writeFileSync(dest, shim);
  chmodSync(dest, 0o755);
  ok(`alias ${c.bold(cmd)} → profile ${name} (${dest})`);
  if (!onPath(aliasDir())) warn(`${aliasDir()} is not on your PATH`);
}

async function cmdAlias(args: string[]): Promise<void> {
  const [name, cmd] = args;
  if (!name || !cmd) die("usage: claudep alias <profile> <command>   e.g. claudep alias enterprise eclaude");
  if (!profileExists(name)) die(`profile "${name}" does not exist — run: claudep init ${name}`);
  writeAlias(name, cmd);
}

async function cmdRun(args: string[]): Promise<never> {
  const name = args[0];
  if (!name) die("usage: claudep run <name> [claude args…]");
  const rest = args.slice(1);
  if (rest[0] === "--") rest.shift();
  if (name === "default" || name === "base") return execClaude(undefined, rest);
  const dir = profileDir(name);
  if (!existsSync(dir)) die(`profile "${name}" does not exist — run: claudep init ${name}`);
  return execClaude(dir, rest);
}

type Row = { name: string; dir: string; status: AuthStatus };

async function collectRows(names: string[]): Promise<Row[]> {
  return Promise.all(
    names.map(async (name) => {
      const dir = name === "default" ? BASE : profileDir(name);
      return { name, dir, status: await authStatus(name === "default" ? undefined : dir) };
    }),
  );
}

function printTable(rows: Row[]): void {
  const cols = ["PROFILE", "LOGIN", "EMAIL", "ORG", "PLAN", "DIR"];
  const data = rows.map((r) => [
    r.name,
    r.status.loggedIn ? "yes" : "no",
    r.status.email ?? "-",
    r.status.orgName ?? "-",
    r.status.subscriptionType ?? "-",
    r.dir.replace(HOME, "~"),
  ]);
  const widths = cols.map((h, i) => Math.max(h.length, ...data.map((d) => d[i]!.length)));
  const fmt = (cells: string[]) => cells.map((v, i) => v.padEnd(widths[i]!)).join("  ");
  console.log(c.bold(fmt(cols)));
  for (const d of data) {
    const line = fmt(d);
    console.log(d[1] === "yes" ? line : c.dim(line));
  }
}

async function cmdList(): Promise<void> {
  const names = ["default", ...listProfileNames()];
  printTable(await collectRows(names));
  if (names.length === 1) console.log(c.dim(`\nNo profiles yet. Create one: claudep init <name>`));
}

async function cmdStatus(args: string[]): Promise<void> {
  const f = parseFlags(args, ["--json"], []);
  const name = f.rest[0];
  if (!name) die("usage: claudep status <name> [--json]");
  if (name !== "default" && !profileExists(name)) die(`profile "${name}" does not exist`);
  const [row] = await collectRows([name]);
  if (f.bools.has("--json")) console.log(JSON.stringify({ name: row!.name, dir: row!.dir, ...row!.status }, null, 2));
  else printTable([row!]);
}

function cmdEnv(args: string[]): void {
  const name = args[0];
  if (!name) die("usage: eval \"$(claudep env <name>)\"");
  const dir = profileDir(name);
  if (!existsSync(dir)) die(`profile "${name}" does not exist`);
  console.log(`export CLAUDE_CONFIG_DIR='${dir.replace(/'/g, `'\\''`)}'`);
}

async function cmdDoctor(args: string[]): Promise<void> {
  const names = args[0] ? [args[0]] : listProfileNames();
  const bin = Bun.which("claude");
  if (bin) {
    const { out } = await captureClaude(undefined, ["--version"]);
    ok(`claude: ${bin} (${out.trim() || "version unknown"})`);
  } else bad("claude binary not found on PATH");
  ok(`base: ${BASE}${CALLER_CONFIG_DIR ? c.yellow("  (from CLAUDE_CONFIG_DIR in your shell)") : ""}`);
  ok(`profiles root: ${PROFILES_ROOT}`);

  const shared = sharedItems();
  const sharedNames = new Set(shared.map((s) => s.name));
  const unclassified = existsSync(BASE)
    ? readdirSync(BASE).filter((n) => !sharedNames.has(n) && !KNOWN_PRIVATE.has(n) && !n.endsWith(".md")).sort()
    : [];
  if (unclassified.length) {
    warn(`base items neither shared nor known-private (they stay per-profile): ${unclassified.join(", ")}`);
  }

  let problems = 0;
  for (const name of names) {
    const dir = profileDir(name);
    console.log(`\n${c.bold(name)}  ${c.dim(dir)}`);
    if (!existsSync(dir)) { bad("profile dir missing"); problems++; continue; }
    for (const item of shared) {
      const dest = join(dir, item.name);
      let st: ReturnType<typeof lstatSync> | undefined;
      try { st = lstatSync(dest); } catch { st = undefined; }
      if (!st) { warn(`${item.name}: not linked (run: claudep init ${name})`); problems++; }
      else if (!st.isSymbolicLink()) { warn(`${item.name}: real ${item.kind} shadows the shared one`); problems++; }
      else if (readlinkSync(dest) !== join(BASE, item.name)) { bad(`${item.name}: symlink points elsewhere (${readlinkSync(dest)})`); problems++; }
      else if (!existsSync(dest)) { bad(`${item.name}: broken symlink`); problems++; }
    }
    ok(`${shared.length} shared item(s) checked`);
    const strays = readdirSync(dir).filter((n) => !sharedNames.has(n) && !KNOWN_PRIVATE.has(n) && !n.endsWith(".md"));
    if (strays.length) warn(`unexpected private items: ${strays.join(", ")}`);
    const svc = keychainService(dir);
    const has = await keychainHas(svc);
    if (has === undefined) console.log(`${c.dim("·")} keychain check skipped (not macOS)`);
    else if (has) ok(`keychain item "${svc}" present`);
    else warn(`no keychain item "${svc}" — not logged in yet (claudep ${name} auth login)`);
    const s = await authStatus(dir);
    if (s.loggedIn) ok(`logged in as ${s.email ?? "?"} (${s.orgName ?? "?"}, ${s.subscriptionType ?? "?"})`);
    else warn("not logged in");
  }
  if (!names.length) console.log(c.dim("\nNo profiles to check."));
  if (problems) { console.log(`\n${c.red(`${problems} problem(s)`)}`); process.exit(1); }
}

async function cmdRm(args: string[]): Promise<void> {
  const f = parseFlags(args, ["--keep-login", "--yes"], []);
  const name = f.rest[0];
  if (!name) die("usage: claudep rm <name> [--keep-login] [--yes]");
  const dir = profileDir(name);
  if (!existsSync(dir)) die(`profile "${name}" does not exist`);
  const real = realpathSync(dir);
  if (!real.startsWith(`${realpathSync(PROFILES_ROOT)}/`) || real === realpathSync(BASE) || real === HOME)
    die(`refusing to remove ${real}: not inside ${PROFILES_ROOT}`);
  if (!f.bools.has("--yes")) {
    const yes = confirm(`Remove profile "${name}" (${dir})? Shared items are only unlinked; ${BASE} is untouched.`);
    if (!yes) { console.log("aborted"); return; }
  }
  if (!f.bools.has("--keep-login")) {
    const proc = Bun.spawn([claudeBin(), "auth", "logout"], { env: envFor(dir), stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    if ((await proc.exited) === 0) ok("logged out (token revoked, keychain item removed)");
    else warn("logout failed or was not logged in — continuing");
  }
  rmSync(dir, { recursive: true, force: true });
  ok(`removed ${dir}`);
  for (const entry of readdirSync(aliasDir())) {
    const p = join(aliasDir(), entry);
    try {
      const txt = lstatSync(p).isFile() ? Bun.file(p) : undefined;
      if (txt && (await txt.text()).includes(`generated by claudep`) && (await txt.text()).includes(` run ${name} -- `))
        warn(`alias shim ${p} still points at this profile — remove it if unused`);
    } catch { /* ignore unreadable entries */ }
  }
}

function help(): void {
  console.log(`${c.bold("claudep")} — run Claude Code under separate accounts on one machine

${c.bold("USAGE")}
  claudep <name> [claude args…]        run claude with profile <name>  (alias for "run")
  claudep init <name> [options]        create/update a profile and log in
  claudep list                         show every profile and who it is logged in as
  claudep status <name> [--json]       login state for one profile ("default" = ~/.claude)
  claudep env <name>                   print "export CLAUDE_CONFIG_DIR=…" for eval
  claudep alias <name> <command>       write a shim so "<command>" == "claudep <name>"
  claudep doctor [name]                verify symlinks, keychain entry, unclassified files
  claudep rm <name> [--keep-login]     log out and delete a profile (base is never touched)

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
  eval "$(claudep env enterprise)"       # pin the whole shell to a profile

${c.bold("HOW IT WORKS")}
  ~/.claude stays exactly as it is and remains the "default" profile. Each named profile is a
  thin directory under ${PROFILES_ROOT.replace(HOME, "~")}/<name> that Claude Code is pointed at via
  CLAUDE_CONFIG_DIR. Inside it, shared config is a symlink back into ~/.claude:
    ${[...SHARED_FILES, "*.md", ...SHARED_DIRS].join("  ")}
  Everything account-specific is real and per profile: .claude.json (login identity, MCP
  servers, folder trust), org-pushed remote-settings.json, history, todos, caches.
  Credentials never touch the profile dir: Claude Code stores them in the macOS Keychain under
  "Claude Code-credentials-<sha256(CLAUDE_CONFIG_DIR)[0:8]>", so every profile has its own
  login and refresh token and they cannot clobber each other.

${c.bold("ENVIRONMENT")}
  CLAUDE_PROFILES_DIR   where profiles live (default ~/.claude-profiles; keep it out of iCloud/Dropbox)
`);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [cmd, ...args] = Bun.argv.slice(2);
  switch (cmd) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      help();
      return;
    case "init":
      return cmdInit(args);
    case "run":
      return cmdRun(args);
    case "list":
    case "ls":
      return cmdList();
    case "status":
      return cmdStatus(args);
    case "env":
      return cmdEnv(args);
    case "alias":
      return cmdAlias(args);
    case "doctor":
      return cmdDoctor(args);
    case "rm":
    case "remove":
      return cmdRm(args);
    default:
      if (cmd === "default" || cmd === "base" || profileExists(cmd)) return cmdRun([cmd, ...args]);
      if (NAME_RE.test(cmd)) die(`no profile "${cmd}" — create it with: claudep init ${cmd}`);
      die(`unknown command "${cmd}" — try: claudep help`);
  }
}

await main();
