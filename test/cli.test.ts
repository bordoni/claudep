import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import {
  aliasFiles,
  aliasShim,
  envScript,
  fishQuote,
  keychainService,
  projectSlug,
  SHELLS,
  shareFixCommand,
} from "../claudep.ts";
import { fakeBin, REPO, runCli, SCRIPT } from "./lib/cli.ts";
import { BASE_DIRS, BASE_FILES, fakeHome, PRIVATE_DIRS, PRIVATE_FILES, writeLogin } from "./lib/home.ts";
import { norm, rx, tilde } from "./lib/paths.ts";

const SHARED = [...BASE_FILES, ...BASE_DIRS] as readonly string[];
const WIN = process.platform === "win32";

/** The arguments `run` puts first in a profile whose projects/ is shared:
 *  the real auto-memory dir for a session started in `root`. */
function memoryArgs(base: string, root: string): string[] {
  const dir = join(realpathSync.native(join(base, "projects")), projectSlug(root, {}), "memory");
  return ["--settings", JSON.stringify({ autoMemoryDirectory: dir })];
}

describe("help and dispatch", () => {
  test("no args prints usage and exits 0", async () => {
    using h = fakeHome();
    const r = await runCli([], { home: h.home });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("USAGE");
    expect(r.stdout).toContain("HOW IT WORKS");
  });

  test("--help equals help", async () => {
    using h = fakeHome();
    const a = await runCli(["--help"], { home: h.home });
    const b = await runCli(["help"], { home: h.home });
    expect(a.stdout).toBe(b.stdout);
  });

  test("an unknown profile name explains how to create it", async () => {
    using h = fakeHome();
    const r = await runCli(["nope"], { home: h.home });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('no profile "nope"');
    expect(r.stderr).toContain("claudep init nope");
  });

  test("an unknown command is rejected", async () => {
    using h = fakeHome();
    const r = await runCli(["Frobnicate"], { home: h.home });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("unknown command");
  });
});

describe("init", () => {
  test("creates only symlinks plus a seeded .claude.json", async () => {
    using h = fakeHome();
    const r = await runCli(["init", "smoke", "--no-login"], { home: h.home });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Creating profile smoke");
    expect(r.stdout).toContain("claudep smoke auth login");

    const dir = join(h.profilesRoot, "smoke");
    const entries = readdirSync(dir).sort();
    expect(entries).toEqual([".claude.json", ...SHARED].sort());
    for (const name of SHARED) {
      expect(lstatSync(join(dir, name)).isSymbolicLink()).toBe(true);
      expect(norm(readlinkSync(join(dir, name)))).toBe(norm(join(h.base, name)));
      expect(existsSync(join(dir, name))).toBe(true);
    }
    for (const p of [...PRIVATE_FILES, ...PRIVATE_DIRS]) expect(existsSync(join(dir, p))).toBe(false);
    const seeded = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8"));
    expect(seeded.hasCompletedOnboarding).toBe(true);
    expect(seeded).not.toHaveProperty("oauthAccount");
    expect(seeded).not.toHaveProperty("mcpServers");
  });

  test("--copy-mcp brings user-scope MCP servers along", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login", "--copy-mcp"], { home: h.home });
    const seeded = JSON.parse(readFileSync(join(h.profilesRoot, "smoke", ".claude.json"), "utf8"));
    expect(Object.keys(seeded.mcpServers)).toEqual(["linear"]);
  });

  test("is idempotent", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const r = await runCli(["init", "smoke", "--no-login"], { home: h.home });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Updating profile smoke");
    expect(r.stdout).toContain("already shared");
    expect(r.stdout).toContain("already present");
  });

  test("logs in through claude with the flags passed along", async () => {
    using h = fakeHome();
    const r = await runCli(["init", "work", "--sso", "--email", "me@corp.com"], { home: h.home });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Logged in as me@corp.com");
    const login = JSON.parse(readFileSync(join(h.profilesRoot, "work", ".fake-login.json"), "utf8"));
    expect(login.sso).toBe(true);
    expect(existsSync(join(h.base, ".fake-login.json"))).toBe(false);
  });

  test("refuses reserved and malformed names", async () => {
    using h = fakeHome();
    const a = await runCli(["init", "default", "--no-login"], { home: h.home });
    expect(a.exitCode).toBe(1);
    expect(a.stderr).toContain("reserved");
    const b = await runCli(["init", "Bad Name", "--no-login"], { home: h.home });
    expect(b.exitCode).toBe(1);
    expect(b.stderr).toContain("invalid profile name");
    expect(existsSync(h.profilesRoot)).toBe(false);
  });

  test("refuses to run when the base does not exist", async () => {
    using h = fakeHome({ withoutBase: true });
    const r = await runCli(["init", "smoke", "--no-login"], { home: h.home });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("does not exist");
  });

  test("leaves a real file in the profile alone and says so", async () => {
    using h = fakeHome();
    mkdirSync(join(h.profilesRoot, "smoke"), { recursive: true });
    writeFileSync(join(h.profilesRoot, "smoke", "settings.json"), "{}");
    const r = await runCli(["init", "smoke", "--no-login"], { home: h.home });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("settings.json is a real file");
    expect(r.stdout).toContain("1 item(s) need attention");
    expect(readFileSync(join(h.profilesRoot, "smoke", "settings.json"), "utf8")).toBe("{}");
  });
});

describe("list and status", () => {
  test("shows the base and every profile with its login state", async () => {
    using h = fakeHome({ loggedIn: true });
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    await runCli(["init", "work", "--email", "w@corp.com"], { home: h.home });
    const r = await runCli(["list"], { home: h.home });
    expect(r.exitCode).toBe(0);
    const lines = r.stdout
      .trim()
      .split("\n")
      .map((l) => l.trimEnd());
    expect(lines[0]).toMatch(/^PROFILE\s+LOGIN\s+EMAIL\s+ORG\s+PLAN\s+DIR/);
    expect(lines[1]).toMatch(
      new RegExp(
        `^default\\s+yes\\s+base@example\\.com\\s+base@example\\.com's Org\\s+max\\s+${rx(tilde(".claude"))}$`,
      ),
    );
    expect(lines[2]).toMatch(new RegExp(`^smoke\\s+no\\s+-\\s+-\\s+-\\s+${rx(tilde(".claudep", "smoke"))}$`));
    expect(lines[3]).toMatch(/^work\s+yes\s+w@corp\.com\s+/);
  });

  test("hints when there are no profiles yet", async () => {
    using h = fakeHome();
    const r = await runCli(["list"], { home: h.home });
    expect(r.stdout).toContain("No profiles yet");
  });

  test("status --json returns a flat object", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    writeLogin(join(h.profilesRoot, "smoke"), "s@x.io");
    const r = await runCli(["status", "smoke", "--json"], { home: h.home });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      name: "smoke",
      dir: join(h.profilesRoot, "smoke"),
      loggedIn: true,
      email: "s@x.io",
      orgName: "s@x.io's Org",
      subscriptionType: "max",
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      configDirectory: join(h.profilesRoot, "smoke"),
    });
  });

  test("below Claude Code 2.1.301 list reads .claude.json instead of asking, unless --live", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    writeLogin(join(h.profilesRoot, "smoke"), "live@x.io");
    const env = { FAKE_CLAUDE_VERSION: "2.1.300 (Claude Code)" };
    const r = await runCli(["list"], { home: h.home, env });
    expect(r.exitCode).toBe(0);
    // The base .claude.json records an account; the new profile's records none.
    expect(r.stdout).toMatch(/^default\s+yes\*\s+base@example\.com\s+Base Org/m);
    expect(r.stdout).toMatch(/^smoke\s+no\*/m);
    expect(r.stdout).not.toContain("live@x.io");
    expect(r.stdout).toContain("anthropics/claude-code/issues/95822");
    const json = await runCli(["status", "smoke", "--json"], { home: h.home, env });
    expect(JSON.parse(json.stdout)).toMatchObject({ loggedIn: false, cached: true });
    const live = await runCli(["list", "--live"], { home: h.home, env });
    expect(live.stdout).toMatch(/^smoke\s+yes\s+live@x\.io/m);
    expect(live.stdout).not.toContain("95822");
    const fixed = await runCli(["list"], { home: h.home, env: { FAKE_CLAUDE_VERSION: "2.1.301 (Claude Code)" } });
    expect(fixed.stdout).toMatch(/^smoke\s+yes\s+live@x\.io/m);
  });

  test("status of an unknown profile fails", async () => {
    using h = fakeHome();
    const r = await runCli(["status", "ghost"], { home: h.home });
    expect(r.exitCode).toBe(1);
  });

  test("list --json prints one flat object per row, the base first", async () => {
    using h = fakeHome({ loggedIn: true });
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const r = await runCli(["list", "--json"], { home: h.home });
    expect(r.exitCode).toBe(0);
    const rows = JSON.parse(r.stdout);
    expect(rows.map((x: { name: string }) => x.name)).toEqual(["default", "smoke"]);
    expect(rows[0]).toEqual({
      name: "default",
      dir: h.base,
      loggedIn: true,
      email: "base@example.com",
      orgName: "base@example.com's Org",
      subscriptionType: "max",
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      configDirectory: h.base,
    });
    const smoke = join(h.profilesRoot, "smoke");
    expect(rows[1]).toEqual({
      name: "smoke",
      dir: smoke,
      loggedIn: false,
      authMethod: "none",
      apiProvider: "firstParty",
      configDirectory: smoke,
    });
    expect(r.stdout).not.toContain("active in this shell");
  });
});

describe("env", () => {
  test("prints the pin in the syntax of the shell it runs from", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const dir = join(h.profilesRoot, "smoke");
    const native = await runCli(["env", "smoke"], { home: h.home, env: { MSYSTEM: undefined, SHELL: "/bin/zsh" } });
    expect(native.exitCode).toBe(0);
    expect(native.stdout).toBe(envScript(dir, WIN ? "powershell" : "sh"));
    const gitBash = await runCli(["env", "smoke"], { home: h.home, env: { MSYSTEM: "MINGW64", SHELL: "/bin/zsh" } });
    expect(gitBash.stdout).toBe(`export CLAUDE_CONFIG_DIR='${dir}'\nunset CLAUDEP_AUTO\n`);
  });
});

describe("run", () => {
  test("forwards arguments and sets CLAUDE_CONFIG_DIR for the profile", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const log = join(h.home, "claude.log");
    const r = await runCli(["smoke", "-p", "say hi", "--model", "x"], { home: h.home, env: { FAKE_CLAUDE_LOG: log } });
    expect(r.exitCode).toBe(0);
    const entry = JSON.parse(readFileSync(log, "utf8").trim());
    expect(entry).toEqual({
      argv: [...memoryArgs(h.base, h.home), "-p", "say hi", "--model", "x"],
      configDir: join(h.profilesRoot, "smoke"),
    });
  });

  test("`run <name> -- args` strips the separator", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const log = join(h.home, "claude.log");
    await runCli(["run", "smoke", "--", "--version-ish"], { home: h.home, env: { FAKE_CLAUDE_LOG: log } });
    expect(JSON.parse(readFileSync(log, "utf8")).argv).toEqual([...memoryArgs(h.base, h.home), "--version-ish"]);
  });

  test("names the memory dir of the repo root when started in a subdirectory", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const repo = join(h.home, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "src", "deep"), { recursive: true });
    const log = join(h.home, "claude.log");
    await runCli(["smoke", "x"], { home: h.home, cwd: join(repo, "src", "deep"), env: { FAKE_CLAUDE_LOG: log } });
    expect(JSON.parse(readFileSync(log, "utf8")).argv).toEqual([...memoryArgs(h.base, repo), "x"]);
  });

  test("leaves the arguments alone when the caller passes --settings", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const log = join(h.home, "claude.log");
    await runCli(["smoke", "--settings", "{}", "x"], { home: h.home, env: { FAKE_CLAUDE_LOG: log } });
    expect(JSON.parse(readFileSync(log, "utf8")).argv).toEqual(["--settings", "{}", "x"]);
  });

  test("`default` runs claude with the caller's environment untouched", async () => {
    using h = fakeHome();
    const log = join(h.home, "claude.log");
    await runCli(["default", "x"], { home: h.home, env: { FAKE_CLAUDE_LOG: log } });
    expect(JSON.parse(readFileSync(log, "utf8"))).toEqual({ argv: ["x"], configDir: null });
  });

  test("propagates claude's exit code", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const r = await runCli(["smoke"], { home: h.home, env: { FAKE_CLAUDE_EXIT: "3" } });
    expect(r.exitCode).toBe(3);
  });

  test("warns when a credential variable overrides the profile login, and still runs", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const log = join(h.home, "claude.log");
    // The preload strips these from the ambient environment; set one on purpose.
    const r = await runCli(["smoke", "x"], {
      home: h.home,
      env: { FAKE_CLAUDE_LOG: log, ANTHROPIC_API_KEY: "sk-test" },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr.trim()).toBe(
      'claudep: ANTHROPIC_API_KEY is set; Claude Code will use it instead of the "smoke" login',
    );
    expect(JSON.parse(readFileSync(log, "utf8")).configDir).toBe(join(h.profilesRoot, "smoke"));
    const quiet = await runCli(["smoke", "x"], { home: h.home, env: { FAKE_CLAUDE_LOG: log } });
    expect(quiet.stderr).toBe("");
  });
});

describe("doctor", () => {
  test("passes on a fresh profile and names the exact keychain service", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const r = await runCli(["doctor", "smoke"], { home: h.home });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`${SHARED.length} shared item(s) checked`);
    expect(r.stdout).toContain("9.9.9 (fake claude)");
    if (process.platform === "darwin") {
      expect(r.stdout).toContain(`no keychain item "${keychainService(join(h.profilesRoot, "smoke"))}"`);
    } else {
      expect(r.stdout).toContain("no .credentials.json in the profile");
      expect(r.stdout).not.toContain("keychain");
    }
    expect(r.stdout).toContain("not logged in");
  });

  test.if(process.platform === "darwin")("sees a keychain item when security says it exists", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const svc = keychainService(join(h.profilesRoot, "smoke"));
    const r = await runCli(["doctor", "smoke"], { home: h.home, env: { FAKE_KEYCHAIN: svc } });
    expect(r.stdout).toContain(`keychain item "${svc}" present`);
  });

  test.if(process.platform !== "darwin")("sees the credentials file where there is no keychain", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    writeFileSync(join(h.profilesRoot, "smoke", ".credentials.json"), "{}\n");
    const r = await runCli(["doctor", "smoke"], { home: h.home });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(".credentials.json present");
    expect(r.stdout).not.toContain("unexpected private items");
  });

  test("flags a shadowing real file, a foreign symlink and a stray, and exits 1", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const dir = join(h.profilesRoot, "smoke");
    const { rmSync } = await import("node:fs");
    rmSync(join(dir, "CLAUDE.md"));
    writeFileSync(join(dir, "CLAUDE.md"), "mine");
    rmSync(join(dir, "skills"));
    symlinkSync(join(h.home, "elsewhere"), join(dir, "skills"), "dir");
    writeFileSync(join(dir, "stray.txt"), "");
    const r = await runCli(["doctor", "smoke"], { home: h.home });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("CLAUDE.md: real file shadows the shared one");
    expect(r.stdout).toContain("skills: symlink points elsewhere");
    expect(r.stdout).toContain("unexpected private items: stray.txt");
    expect(r.stdout).toContain("2 problem(s)");
  });

  test("reports base files that are neither shared nor known-private", async () => {
    using h = fakeHome();
    writeFileSync(join(h.base, "mystery.json"), "{}");
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const r = await runCli(["doctor"], { home: h.home });
    expect(r.stdout).toContain("neither shared nor known-private");
    expect(r.stdout).toContain("mystery.json");
    // Known runtime state from Claude Code 2.1.263 is classified, never reported.
    expect(r.stdout).not.toContain("teams");
    expect(existsSync(join(h.profilesRoot, "smoke", "mystery.json"))).toBe(false);
  });

  test("classifies what Claude Code 2.1.280 writes into the base", async () => {
    using h = fakeHome();
    mkdirSync(join(h.base, "state"));
    writeFileSync(join(h.base, "policy-limits.json.stamp.json"), "{}");
    writeFileSync(join(h.base, "loop.md"), "# loop\n");
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const r = await runCli(["doctor"], { home: h.home });
    expect(r.stdout).not.toContain("neither shared nor known-private");
    expect(existsSync(join(h.profilesRoot, "smoke", "loop.md"))).toBe(false);
    expect(existsSync(join(h.profilesRoot, "smoke", "state"))).toBe(false);
  });

  test("classifies what Claude Code 2.1.311 writes, and lock files, in the base and a profile", async () => {
    using h = fakeHome();
    const write = (dir: string) => {
      writeFileSync(join(dir, "remote-settings.json.synced-at"), "1");
      writeFileSync(join(dir, "ccr-home-seed.json"), "{}");
      mkdirSync(join(dir, "remote-control"));
      mkdirSync(join(dir, "remote-settings.json.signature-iat.json.lock"));
      writeFileSync(join(dir, ".update.lock"), "123");
      writeFileSync(join(dir, ".oauth_refresh.lock.owner"), "{}");
    };
    write(h.base);
    writeFileSync(join(h.base, ".device-keys.json"), "{}");
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const dir = join(h.profilesRoot, "smoke");
    write(dir);
    writeFileSync(join(dir, "stray.lockfile"), "");
    const r = await runCli(["doctor", "smoke"], { home: h.home });
    expect(r.stdout).not.toContain("neither shared nor known-private");
    expect(r.stdout).toContain("unexpected private items: stray.lockfile");
    expect(existsSync(join(dir, "remote-control"))).toBe(true);
    expect(lstatSync(join(dir, ".device-keys.json"), { throwIfNoEntry: false })).toBeUndefined();
  });

  test("flags a loop.md an older claudep linked, as a problem", async () => {
    using h = fakeHome();
    writeFileSync(join(h.base, "loop.md"), "# loop\n");
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const dir = join(h.profilesRoot, "smoke");
    symlinkSync(join(h.base, "loop.md"), join(dir, "loop.md"), "file");
    const r = await runCli(["doctor", "smoke"], { home: h.home });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("loop.md: linked to the base by an older claudep");
    expect(r.stdout).toContain("1 problem(s)");
  });

  test("below Claude Code 2.1.301 warns about sign-outs and shows the recorded account", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const r = await runCli(["doctor", "smoke"], {
      home: h.home,
      env: { FAKE_CLAUDE_VERSION: "2.1.300 (Claude Code)" },
    });
    expect(r.stdout).toContain("can sign a profile out on a short `claude auth status`");
    expect(r.stdout).toContain("no account recorded in .claude.json");
    expect(r.stdout).not.toContain("Claude Code reports this config dir");
  });

  test("reports each config dir's auto-update state and last update", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login", "--env", "DISABLE_AUTOUPDATER=1"], { home: h.home });
    writeFileSync(
      join(h.base, ".last-update-result.json"),
      JSON.stringify({
        timestamp: "2026-10-06T12:45:00.000Z",
        path: "native",
        outcome: "success",
        version_from: "2.1.290",
        version_to: "2.1.291",
      }),
    );
    const r = await runCli(["doctor", "smoke"], {
      home: h.home,
      env: { DISABLE_AUTOUPDATER: undefined, DISABLE_UPDATES: undefined },
    });
    // The base .claude.json says autoUpdates: false and does not protect a native install.
    expect(r.stdout).toContain("default: auto-update off (autoUpdates in .claude.json)");
    expect(r.stdout).toContain("default: last update 2.1.290 → 2.1.291 (success, native, 2026-10-06)");
    expect(r.stdout).toContain("auto-update off (DISABLE_AUTOUPDATER in claudep.env)");
    // On Windows the fake claude is a .cmd shim, which is how npm installs it there.
    if (WIN) expect(r.stdout).toContain("claude is an npm-global install");
    else expect(r.stdout).toContain("install: unknown");
  });

  test("says who updated Claude Code past each dir's last update record", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    await runCli(["init", "other", "--no-login"], { home: h.home });
    const record = (dir: string, rec: object) =>
      writeFileSync(
        join(dir, ".last-update-result.json"),
        JSON.stringify({ timestamp: "2026-10-06T12:45:00.000Z", path: "npm-global", ...rec }),
      );
    record(h.base, { outcome: "success", version_from: "2.1.290", version_to: "2.1.291" });
    record(join(h.profilesRoot, "smoke"), { outcome: "failed", version_from: "2.1.300", version_to: null });
    const env = { FAKE_CLAUDE_VERSION: "2.1.311 (Claude Code)" };
    const outside = await runCli(["doctor"], { home: h.home, env });
    expect(outside.stdout).toContain(
      "default: last update 2.1.290 → 2.1.291 (success, npm-global, 2026-10-06); running 2.1.311, updated outside Claude Code since",
    );
    expect(outside.stdout).toContain(
      "last update 2.1.300 → ? (failed, npm-global, 2026-10-06); running 2.1.311, updated outside Claude Code since",
    );
    record(join(h.profilesRoot, "other"), { outcome: "success", version_from: "2.1.291", version_to: "2.1.311" });
    const another = await runCli(["doctor"], { home: h.home, env });
    expect(another.stdout).toContain(
      "2.1.291 (success, npm-global, 2026-10-06); running 2.1.311, updated since by another config dir",
    );
    expect(another.stdout).toContain("last update 2.1.291 → 2.1.311 (success, npm-global, 2026-10-06)\n");
  });

  test("warns about auto-memory prompts from Claude Code 2.1.280 on, without failing", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const hit = await runCli(["doctor", "smoke"], {
      home: h.home,
      env: { FAKE_CLAUDE_VERSION: "2.1.280 (Claude Code)" },
    });
    expect(hit.exitCode).toBe(0);
    expect(hit.stdout).toContain("asks for approval on every auto-memory write");
    expect(hit.stdout).toContain("anthropics/claude-code/issues/98044");
    const before = await runCli(["doctor", "smoke"], {
      home: h.home,
      env: { FAKE_CLAUDE_VERSION: "2.1.279 (Claude Code)" },
    });
    expect(before.stdout).not.toContain("auto-memory");
  });

  test.if(process.platform !== "darwin")(
    "does not call a logged-in profile without .credentials.json logged out",
    async () => {
      using h = fakeHome();
      await runCli(["init", "smoke", "--no-login"], { home: h.home });
      writeLogin(join(h.profilesRoot, "smoke"), "cm@example.com");
      const r = await runCli(["doctor", "smoke"], { home: h.home });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Claude Code keeps this login elsewhere");
      expect(r.stdout).not.toContain("Not logged in yet");
      expect(r.stdout).toContain("logged in as cm@example.com");
    },
  );

  test("flags a Claude Code older than the keychain floor on macOS only", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const old = await runCli(["doctor", "smoke"], {
      home: h.home,
      env: { FAKE_CLAUDE_VERSION: "2.1.100 (Claude Code)" },
    });
    if (process.platform === "darwin") {
      expect(old.exitCode).toBe(1);
      expect(old.stdout).toContain("Claude Code 2.1.100 is older than 2.1.144");
    } else {
      expect(old.stdout).not.toContain("older than");
    }
    const fine = await runCli(["doctor", "smoke"], {
      home: h.home,
      env: { FAKE_CLAUDE_VERSION: "2.1.144 (Claude Code)" },
    });
    expect(fine.stdout).not.toContain("older than");
    expect(fine.exitCode).toBe(0);
  });

  test("flags env.CLAUDE_CONFIG_DIR in the shared settings.json", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    writeFileSync(join(h.base, "settings.json"), JSON.stringify({ env: { CLAUDE_CONFIG_DIR: "/somewhere" } }));
    const r = await runCli(["doctor", "smoke"], { home: h.home });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("sets env.CLAUDE_CONFIG_DIR (/somewhere)");
    expect(r.stdout).toContain("1 problem(s)");
  });

  test("warns about credential variables without counting them as problems", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const r = await runCli(["doctor", "smoke"], { home: h.home, env: { CLAUDE_CODE_OAUTH_TOKEN: "t" } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("CLAUDE_CODE_OAUTH_TOKEN is set in this shell");
  });
});

describe("alias", () => {
  test("writes the shim next to the claudep on PATH, never into the repo", async () => {
    using h = fakeHome();
    const bin = fakeBin(h.home, { withClaudep: true });
    await runCli(["init", "smoke", "--no-login"], { home: h.home, bin });
    const before = readdirSync(REPO);
    const r = await runCli(["alias", "smoke", "esmoke"], { home: h.home, bin });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("alias esmoke → profile smoke");
    const files = aliasFiles(bin, "esmoke");
    expect(files.map((f) => f.kind)).toEqual(WIN ? ["cmd", "sh"] : ["sh"]);
    for (const { path, kind } of files) {
      const shim = readFileSync(path, "utf8");
      expect(shim).toContain("generated by claudep");
      expect(shim).toContain("claudep.ts");
      if (kind === "sh") {
        expect(shim.startsWith("#!/bin/sh\n")).toBe(true);
        expect(shim).toContain(`run smoke -- "$@"`);
        if (!WIN) expect(lstatSync(path).mode & 0o111).not.toBe(0);
      } else {
        expect(shim.startsWith("@echo off\r\n")).toBe(true);
        expect(shim).toContain("run smoke -- %*");
      }
    }
    expect(readdirSync(REPO)).toEqual(before);
  });

  test("init --alias does the same in one step", async () => {
    using h = fakeHome();
    const bin = fakeBin(h.home, { withClaudep: true });
    await runCli(["init", "smoke", "--no-login", "--alias", "esmoke"], { home: h.home, bin });
    for (const { path } of aliasFiles(bin, "esmoke")) expect(existsSync(path)).toBe(true);
  });

  test("refuses to clobber an existing command", async () => {
    using h = fakeHome();
    const bin = fakeBin(h.home, { withClaudep: true });
    await runCli(["init", "smoke", "--no-login"], { home: h.home, bin });
    const [first] = aliasFiles(bin, "taken");
    if (!first) throw new Error("aliasFiles returned nothing");
    writeFileSync(first.path, "#!/bin/sh\necho mine\n");
    const r = await runCli(["alias", "smoke", "taken"], { home: h.home, bin });
    expect(r.stdout).toContain("already exists");
    expect(readFileSync(first.path, "utf8")).toContain("echo mine");
  });

  test("needs an existing profile", async () => {
    using h = fakeHome();
    const r = await runCli(["alias", "ghost", "g"], { home: h.home });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('profile "ghost" does not exist');
  });
});

describe("rm", () => {
  test("logs out, removes the profile and leaves the base untouched", async () => {
    using h = fakeHome({ loggedIn: true });
    await runCli(["init", "smoke", "--email", "s@x.io"], { home: h.home });
    const dir = join(h.profilesRoot, "smoke");
    expect(existsSync(join(dir, ".fake-login.json"))).toBe(true);
    const baseBefore = readdirSync(h.base).sort();

    const r = await runCli(["rm", "smoke", "--yes"], { home: h.home });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("logged out");
    expect(r.stdout).toContain(`removed ${dir}`);
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(h.base).sort()).toEqual(baseBefore);
    expect(existsSync(join(h.base, ".fake-login.json"))).toBe(true);
    expect(readFileSync(join(h.base, "CLAUDE.md"), "utf8")).toBe("# CLAUDE.md\n");
  });

  test("--keep-login skips the logout", async () => {
    using h = fakeHome();
    const log = join(h.home, "claude.log");
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const r = await runCli(["rm", "smoke", "--yes", "--keep-login"], { home: h.home, env: { FAKE_CLAUDE_LOG: log } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("logged out");
    expect(existsSync(log)).toBe(false);
  });

  test("warns about an alias shim that still points at the profile", async () => {
    using h = fakeHome();
    const bin = fakeBin(h.home, { withClaudep: true });
    await runCli(["init", "smoke", "--no-login", "--alias", "esmoke"], { home: h.home, bin });
    const r = await runCli(["rm", "smoke", "--yes", "--keep-login"], { home: h.home, bin });
    expect(r.stdout).toContain("alias shim");
    expect(r.stdout).toContain("esmoke");
  });

  test("refuses a profile that resolves outside the profiles root", async () => {
    using h = fakeHome();
    const outside = join(h.home, "precious");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "x");
    mkdirSync(h.profilesRoot, { recursive: true });
    symlinkSync(outside, join(h.profilesRoot, "evil"), "dir");
    const r = await runCli(["rm", "evil", "--yes", "--keep-login"], { home: h.home });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("refusing to remove");
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  });

  test("fails for a profile that does not exist", async () => {
    using h = fakeHome();
    const r = await runCli(["rm", "ghost", "--yes"], { home: h.home });
    expect(r.exitCode).toBe(1);
  });

  test("warns when the shell is on the profile or the directory pins it, then removes anyway", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const dir = join(h.profilesRoot, "smoke");
    const repo = join(h.home, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, ".claudep"), "smoke\n");
    const r = await runCli(["rm", "smoke", "--yes", "--keep-login"], {
      home: h.home,
      cwd: repo,
      env: { CLAUDE_CONFIG_DIR: dir, CLAUDEP_AUTO: dir },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("this shell is on smoke (shell hook)");
    expect(r.stdout).toContain("claudep env --unset");
    expect(r.stdout).toContain(`${tilde("repo", ".claudep")} pins this directory tree to smoke`);
    expect(r.stdout).toContain("claudep local --remove");
    expect(existsSync(dir)).toBe(false);
  });
});

describe("version", () => {
  test("--version, -v and version print the package version", async () => {
    using h = fakeHome();
    const pkg = (await Bun.file(join(REPO, "package.json")).json()) as { version: string };
    for (const flag of ["--version", "-v", "version"]) {
      const r = await runCli([flag], { home: h.home });
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe(pkg.version);
    }
  });
});

describe("env --unset", () => {
  test("prints the unset for both variables", async () => {
    using h = fakeHome();
    const r = await runCli(["env", "--unset"], { home: h.home, env: { MSYSTEM: undefined, SHELL: "/bin/zsh" } });
    expect(r.stdout).toBe(envScript(undefined, WIN ? "powershell" : "sh"));
    const gitBash = await runCli(["env", "--unset"], { home: h.home, env: { MSYSTEM: "MINGW64", SHELL: "/bin/zsh" } });
    expect(gitBash.stdout).toBe("unset CLAUDE_CONFIG_DIR CLAUDEP_AUTO\n");
  });
});

describe("current", () => {
  test("base when nothing is pinned", async () => {
    using h = fakeHome();
    const r = await runCli(["current"], { home: h.home });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`default  ${tilde(".claude")}`);
    expect(r.stdout).toContain("nothing pinned");
  });

  test("profile set by the hook", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const dir = join(h.profilesRoot, "smoke");
    const r = await runCli(["current"], { home: h.home, env: { CLAUDE_CONFIG_DIR: dir, CLAUDEP_AUTO: dir } });
    expect(r.stdout).toContain(`smoke  ${tilde(".claudep", "smoke")}`);
    expect(r.stdout).toContain("set by: shell hook");
  });

  test("manual pin, and a differing pin in the current directory is called out", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    await runCli(["init", "work", "--no-login"], { home: h.home });
    const repo = join(h.home, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, ".claudep"), "work\n");
    const r = await runCli(["current"], {
      home: h.home,
      cwd: repo,
      env: { CLAUDE_CONFIG_DIR: join(h.profilesRoot, "smoke") },
    });
    expect(r.stdout).toContain("set by: manual pin");
    expect(r.stdout).toContain("pinned here: work");
    expect(r.stdout).toContain("but this shell is on smoke");
  });

  test("--name prints only the label in every state", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const dir = join(h.profilesRoot, "smoke");
    expect((await runCli(["current", "--name"], { home: h.home })).stdout).toBe("default\n");
    expect((await runCli(["current", "--name"], { home: h.home, env: { CLAUDE_CONFIG_DIR: dir } })).stdout).toBe(
      "smoke\n",
    );
    const cfg = join(dirname(h.home), "cfg");
    expect((await runCli(["current", "--name"], { home: h.home, env: { CLAUDE_CONFIG_DIR: cfg } })).stdout).toBe(
      "custom\n",
    );
  });

  test("custom dir outside the root", async () => {
    using h = fakeHome();
    const cfg = join(dirname(h.home), "cfg");
    const r = await runCli(["current", "--json"], { home: h.home, env: { CLAUDE_CONFIG_DIR: cfg } });
    expect(JSON.parse(r.stdout)).toEqual({
      kind: "custom",
      name: undefined,
      dir: cfg,
      setBy: "manual",
      pin: null,
    });
  });

  test("list names the active profile and keeps the default row on the real base", async () => {
    using h = fakeHome({ loggedIn: true });
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const dir = join(h.profilesRoot, "smoke");
    const r = await runCli(["list"], { home: h.home, env: { CLAUDE_CONFIG_DIR: dir, CLAUDEP_AUTO: dir } });
    expect(r.stdout).toContain("active in this shell: smoke (shell hook)");
    expect(r.stdout).toMatch(/^default\s+yes\s+base@example\.com/m);
  });

  test("run default strips an active pin so claude sees the base", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const dir = join(h.profilesRoot, "smoke");
    const log = join(h.home, "claude.log");
    await runCli(["default", "x"], {
      home: h.home,
      env: { CLAUDE_CONFIG_DIR: dir, CLAUDEP_AUTO: dir, FAKE_CLAUDE_LOG: log },
    });
    expect(JSON.parse(readFileSync(log, "utf8")).configDir).toBeNull();
  });
});

describe("local and resolve", () => {
  test("local writes the pin, resolve reads it from a nested dir, --remove deletes it", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const repo = join(h.home, "repo");
    const nested = join(repo, "src", "deep");
    mkdirSync(nested, { recursive: true });

    const w = await runCli(["local", "smoke"], { home: h.home, cwd: repo });
    expect(w.exitCode).toBe(0);
    expect(readFileSync(join(repo, ".claudep"), "utf8")).toBe("smoke\n");
    expect(w.stdout).toContain("pins this directory tree to smoke");

    const r = await runCli(["resolve"], { home: h.home, cwd: nested });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("smoke\n");
    const j = await runCli(["resolve", nested, "--json"], { home: h.home, cwd: h.home });
    expect(JSON.parse(j.stdout)).toEqual({
      name: "smoke",
      file: join(repo, ".claudep"),
      dir: repo,
      profileDir: join(h.profilesRoot, "smoke"),
    });

    const show = await runCli(["local"], { home: h.home, cwd: nested });
    expect(show.stdout).toContain("smoke");
    expect(show.stdout).toContain(tilde("repo", ".claudep"));

    const rm = await runCli(["local", "--remove"], { home: h.home, cwd: repo });
    expect(rm.exitCode).toBe(0);
    expect(existsSync(join(repo, ".claudep"))).toBe(false);
    const none = await runCli(["resolve"], { home: h.home, cwd: nested });
    expect(none.exitCode).toBe(1);
    expect(none.stdout).toBe("");
  });

  test("local refuses an unknown profile unless --force", async () => {
    using h = fakeHome();
    const repo = join(h.home, "repo");
    mkdirSync(repo);
    const a = await runCli(["local", "ghost"], { home: h.home, cwd: repo });
    expect(a.exitCode).toBe(1);
    expect(a.stderr).toContain("does not exist");
    expect(existsSync(join(repo, ".claudep"))).toBe(false);
    const b = await runCli(["local", "ghost", "--force"], { home: h.home, cwd: repo });
    expect(b.exitCode).toBe(0);
    expect(readFileSync(join(repo, ".claudep"), "utf8")).toBe("ghost\n");
  });

  test("resolve rejects a pin file with an invalid name", async () => {
    using h = fakeHome();
    const repo = join(h.home, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, ".claudep"), "Not Valid\n");
    const r = await runCli(["resolve"], { home: h.home, cwd: repo });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("invalid profile");
  });

  test("shell-init rejects unknown shells", async () => {
    using h = fakeHome();
    const r = await runCli(["shell-init", "tcsh"], { home: h.home });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("unsupported shell");
  });

  test("shell-init prints a hook for every supported shell", async () => {
    using h = fakeHome();
    for (const shell of SHELLS) {
      const r = await runCli(["shell-init", shell], { home: h.home });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("_claudep_auto");
      // fish single-quotes the root, which doubles the backslashes of a Windows path.
      expect(r.stdout).toContain(shell === "fish" ? fishQuote(h.profilesRoot) : h.profilesRoot);
    }
    const ps = await runCli(["shell-init", "powershell"], { home: h.home });
    expect(ps.stdout).toContain("function global:prompt");
    const fish = await runCli(["shell-init", "fish"], { home: h.home });
    expect(fish.stdout).toContain("--on-variable PWD");
  });
});

describe("env --shell", () => {
  test("fish syntax from $SHELL, from --shell, and --shell=fish with --unset", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const dir = join(h.profilesRoot, "smoke");
    const forced = await runCli(["env", "smoke", "--shell", "fish"], { home: h.home });
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toBe(envScript(dir, "fish"));
    // MSYSTEM makes this hold on Windows too, where PowerShell would otherwise win.
    const login = await runCli(["env", "smoke"], { home: h.home, env: { SHELL: "/usr/bin/fish", MSYSTEM: "MINGW64" } });
    expect(login.stdout).toBe(envScript(dir, "fish"));
    const unset = await runCli(["env", "--shell=fish", "--unset"], { home: h.home });
    expect(unset.stdout).toBe(envScript(undefined, "fish"));
    const sh = await runCli(["env", "smoke", "--shell", "sh"], { home: h.home, env: { SHELL: "/usr/bin/fish" } });
    expect(sh.stdout).toBe(envScript(dir, "sh"));
  });

  test("rejects an unknown shell and explains the fish form in the usage", async () => {
    using h = fakeHome();
    const bad = await runCli(["env", "smoke", "--shell", "tcsh"], { home: h.home });
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain('unsupported shell "tcsh"');
    const usage = await runCli(["env"], { home: h.home, env: { SHELL: "/usr/bin/fish", MSYSTEM: "MINGW64" } });
    expect(usage.exitCode).toBe(1);
    expect(usage.stderr).toContain("claudep env <name> | source");
  });
});

describe("env detects the shell it runs in", () => {
  /** Runs `claudep env smoke` as a child of a real shell, with $SHELL pointing elsewhere. */
  async function fromShell(h: { home: string }, exe: string, login: string): Promise<string> {
    // PowerShell needs the call operator in front of a quoted command name.
    const amp = exe.endsWith("pwsh") ? "& " : "";
    // bash -c execs a lone command in place of itself; a trailing no-op forces the fork eval "$(...)" does.
    const tail = exe === "bash" ? "; :" : "";
    const cmd = `${amp}${JSON.stringify(process.execPath)} ${JSON.stringify(SCRIPT)} env smoke${tail}`;
    const proc = Bun.spawn([exe, "-c", cmd], {
      env: { PATH: process.env.PATH ?? "", HOME: h.home, USERPROFILE: h.home, SHELL: login, NO_COLOR: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out;
  }

  test.if(!WIN && Bun.which("fish") !== null)("a fish parent gets fish syntax even when $SHELL is zsh", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const out = await fromShell(h, Bun.which("fish") as string, "/bin/zsh");
    expect(out).toBe(envScript(join(h.profilesRoot, "smoke"), "fish"));
  });

  test.if(!WIN)("a bash parent gets sh syntax even when $SHELL is fish", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const out = await fromShell(h, "bash", "/usr/bin/fish");
    expect(out).toBe(envScript(join(h.profilesRoot, "smoke"), "sh"));
  });

  test.if(!WIN && Bun.which("pwsh") !== null)("a pwsh parent gets PowerShell syntax off Windows too", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const out = await fromShell(h, Bun.which("pwsh") as string, "/bin/zsh");
    expect(out).toBe(envScript(join(h.profilesRoot, "smoke"), "powershell"));
  });
});

describe("completion", () => {
  test("prints a script for zsh, bash, fish and PowerShell that embeds the profiles root", async () => {
    using h = fakeHome();
    for (const shell of ["zsh", "bash", "fish", "powershell"] as const) {
      const r = await runCli(["completion", shell], { home: h.home });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(shell === "fish" ? fishQuote(h.profilesRoot) : `'${h.profilesRoot}'`);
    }
    const cmd = await runCli(["completion", "cmd"], { home: h.home });
    expect(cmd.exitCode).toBe(1);
    expect(cmd.stderr).toContain('no completions for "cmd"');
  });

  test("bare completion follows $SHELL; the script never lists profiles itself", async () => {
    using h = fakeHome();
    await runCli(["init", "work", "--no-login"], { home: h.home });
    const r = await runCli(["completion"], { home: h.home, env: { SHELL: "/usr/bin/fish", MSYSTEM: "MINGW64" } });
    // On Windows the shell is Git Bash whenever MSYSTEM is set, whatever $SHELL says.
    expect(r.stdout).toContain(WIN ? "complete -F _claudep claudep" : "complete -c claudep -f");
    expect(r.stdout).not.toMatch(/\bwork\b/);
  });

  test("help mentions completion, and the word is a reserved profile name", async () => {
    using h = fakeHome();
    const help = await runCli(["help"], { home: h.home });
    expect(help.stdout).toContain("claudep completion");
    const r = await runCli(["init", "completion", "--no-login"], { home: h.home });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("reserved");
  });
});

describe("vars", () => {
  test("sets, lists, prints JSON and unsets a profile's variables", async () => {
    using h = fakeHome();
    await runCli(["init", "work", "--no-login"], { home: h.home });
    const set = await runCli(["vars", "work", "ANTHROPIC_PROFILE=team", "AWS_REGION=us-east-1"], { home: h.home });
    expect(set.exitCode).toBe(0);
    expect(set.stdout).toContain("work: ANTHROPIC_PROFILE, AWS_REGION");
    const file = join(h.profilesRoot, "work", "claudep.env");
    expect(readFileSync(file, "utf8")).toEndWith("ANTHROPIC_PROFILE=team\nAWS_REGION=us-east-1\n");

    await runCli(["vars", "work", "AWS_REGION=eu-west-1"], { home: h.home });
    const list = await runCli(["vars", "work"], { home: h.home });
    expect(list.stdout).toBe("ANTHROPIC_PROFILE=team\nAWS_REGION=eu-west-1\n");
    const json = await runCli(["vars", "work", "--json"], { home: h.home });
    expect(JSON.parse(json.stdout)).toEqual({ ANTHROPIC_PROFILE: "team", AWS_REGION: "eu-west-1" });

    await runCli(["vars", "work", "--unset", "AWS_REGION"], { home: h.home });
    expect((await runCli(["vars", "work"], { home: h.home })).stdout).toBe("ANTHROPIC_PROFILE=team\n");
    await runCli(["vars", "work", "--unset", "ANTHROPIC_PROFILE"], { home: h.home });
    expect(existsSync(file)).toBe(false);
  });

  test("refuses credential and claudep variables and writes nothing", async () => {
    using h = fakeHome();
    await runCli(["init", "work", "--no-login"], { home: h.home });
    const r = await runCli(["vars", "work", "OK=1", "ANTHROPIC_API_KEY=sk-x", "CLAUDE_CONFIG_DIR=/x"], {
      home: h.home,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("ANTHROPIC_API_KEY is not allowed: claudep never stores credentials");
    expect(r.stderr).toContain("CLAUDE_CONFIG_DIR is not allowed");
    expect(r.stderr).not.toContain("sk-x");
    expect(existsSync(join(h.profilesRoot, "work", "claudep.env"))).toBe(false);
  });

  test("keeps hand-written comments and reports lines it skips", async () => {
    using h = fakeHome();
    await runCli(["init", "work", "--no-login"], { home: h.home });
    const file = join(h.profilesRoot, "work", "claudep.env");
    writeFileSync(file, "# team settings\nA=1\nnot a var\n");
    await runCli(["vars", "work", "B=2"], { home: h.home });
    expect(readFileSync(file, "utf8")).toBe("# team settings\nA=1\nnot a var\nB=2\n");
    const list = await runCli(["vars", "work"], { home: h.home });
    expect(list.stdout).toBe("A=1\nB=2\n");
    expect(list.stderr).toContain("has lines it skips: 3");
  });

  test("init --env writes the variables, and refuses a bad one before creating the profile", async () => {
    using h = fakeHome();
    const r = await runCli(["init", "work", "--no-login", "--env", "A=1", "--env=B=x y"], { home: h.home });
    expect(r.exitCode).toBe(0);
    expect((await runCli(["vars", "work"], { home: h.home })).stdout).toBe("A=1\nB=x y\n");
    const bad = await runCli(["init", "other", "--no-login", "--env", "CLAUDEP_AUTO=1"], { home: h.home });
    expect(bad.exitCode).toBe(1);
    expect(existsSync(join(h.profilesRoot, "other"))).toBe(false);
  });

  test("vars is a reserved profile name and needs an existing profile", async () => {
    using h = fakeHome();
    expect((await runCli(["init", "vars", "--no-login"], { home: h.home })).stderr).toContain("reserved");
    const r = await runCli(["vars", "ghost", "A=1"], { home: h.home });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('profile "ghost" does not exist');
  });
});

describe("profile variables at run time", () => {
  test("run exports the profile's variables, but a variable you set wins", async () => {
    using h = fakeHome();
    await runCli(["init", "work", "--no-login", "--env", "A=1", "--env", "B=2"], { home: h.home });
    const log = join(h.home, "claude.log");
    await runCli(["work", "x"], { home: h.home, env: { FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_LOG_ENV: "A,B", B: "mine" } });
    expect(JSON.parse(readFileSync(log, "utf8")).env).toEqual({ A: "1", B: "mine" });
  });

  test("run drops the variables another profile's claudep.env put in the shell", async () => {
    using h = fakeHome();
    await runCli(["init", "work", "--no-login", "--env", "A=1"], { home: h.home });
    const log = join(h.home, "claude.log");
    const env = {
      FAKE_CLAUDE_LOG: log,
      FAKE_CLAUDE_LOG_ENV: "A,OTHER,CLAUDEP_ENV_KEYS",
      OTHER: "o",
      CLAUDEP_ENV_KEYS: "OTHER",
    };
    await runCli(["work", "x"], { home: h.home, env });
    await runCli(["default", "x"], { home: h.home, env });
    const [work, base] = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).env);
    expect(work).toEqual({ A: "1", OTHER: null, CLAUDEP_ENV_KEYS: null });
    expect(base).toEqual({ A: null, OTHER: null, CLAUDEP_ENV_KEYS: null });
  });

  test("env exports the variables and records them; env --unset clears them", async () => {
    using h = fakeHome();
    await runCli(["init", "work", "--no-login", "--env", "A=1", "--env", "B=2"], { home: h.home });
    const dir = join(h.profilesRoot, "work");
    const r = await runCli(["env", "work", "--shell", "sh"], { home: h.home, env: { B: "mine" } });
    expect(r.stdout).toBe(
      `export CLAUDE_CONFIG_DIR='${dir}'\nunset CLAUDEP_AUTO\nexport A='1'\nexport CLAUDEP_ENV_KEYS='A'\n`,
    );
    expect(r.stderr).toBe("claudep: B is already set in this shell; leaving it\n");
    const off = await runCli(["env", "--unset", "--shell", "sh"], { home: h.home, env: { CLAUDEP_ENV_KEYS: "A" } });
    expect(off.stdout).toBe("unset A\nunset CLAUDE_CONFIG_DIR CLAUDEP_AUTO\nunset CLAUDEP_ENV_KEYS\n");
  });
});

describe("doctor and auth status details", () => {
  test("lists a profile's variable names and fails on lines nothing reads", async () => {
    using h = fakeHome();
    await runCli(["init", "work", "--no-login", "--env", "ANTHROPIC_PROFILE=secret-name"], { home: h.home });
    const good = await runCli(["doctor", "work"], { home: h.home });
    expect(good.exitCode).toBe(0);
    expect(good.stdout).toContain("claudep.env: ANTHROPIC_PROFILE");
    expect(good.stdout).not.toContain("secret-name");
    expect(good.stdout).toContain("Claude Code reports this config dir");
    appendFileSync(join(h.profilesRoot, "work", "claudep.env"), "ANTHROPIC_API_KEY=sk-x\n");
    const bad = await runCli(["doctor", "work"], { home: h.home });
    expect(bad.exitCode).toBe(1);
    expect(bad.stdout).toMatch(/claudep\.env: lines 3 are not KEY=VALUE/);
    expect(bad.stdout).not.toContain("sk-x");
  });

  test("fails when Claude Code reports a different config dir, and names an API key source", async () => {
    using h = fakeHome();
    await runCli(["init", "work", "--no-login"], { home: h.home });
    const r = await runCli(["doctor", "work"], {
      home: h.home,
      env: { FAKE_CLAUDE_CONFIG_DIRECTORY: h.base, ANTHROPIC_API_KEY: "sk-test" },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(`Claude Code reports config dir ${h.base}, not ${join(h.profilesRoot, "work")}`);
    expect(r.stdout).toContain("Claude Code uses an API key from ANTHROPIC_API_KEY instead of the profile login");
  });
});

describe("handoff", () => {
  const OLD = "11111111-1111-4111-8111-111111111111";
  const NEW = "22222222-2222-4222-8222-222222222222";

  function sessions(h: ReturnType<typeof fakeHome>): { cwd: string; dir: string } {
    const cwd = join(h.home, "repo");
    mkdirSync(cwd);
    const dir = join(h.base, "projects", projectSlug(cwd));
    mkdirSync(dir, { recursive: true });
    for (const f of [`${OLD}.jsonl`, `${NEW}.jsonl`, "notes.jsonl"]) writeFileSync(join(dir, f), "{}\n");
    utimesSync(join(dir, `${OLD}.jsonl`), new Date(1_000), new Date(1_000));
    return { cwd, dir };
  }

  test("resumes this directory's newest session under the profile as a fork", async () => {
    using h = fakeHome();
    await runCli(["init", "work", "--no-login"], { home: h.home });
    const { cwd } = sessions(h);
    const log = join(h.home, "claude.log");
    const r = await runCli(["handoff", "work", "--", "-p", "go on"], {
      home: h.home,
      cwd,
      env: { FAKE_CLAUDE_LOG: log },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain(`handing session ${NEW}`);
    const entry = JSON.parse(readFileSync(log, "utf8"));
    expect(entry.configDir).toBe(join(h.profilesRoot, "work"));
    expect(entry.argv.slice(entry.argv.indexOf("--resume"))).toEqual([
      "--resume",
      NEW,
      "--fork-session",
      "-p",
      "go on",
    ]);
  });

  test("takes a session id, and refuses junk, an empty directory and a missing profile", async () => {
    using h = fakeHome();
    await runCli(["init", "work", "--no-login"], { home: h.home });
    const { cwd } = sessions(h);
    const log = join(h.home, "claude.log");
    await runCli(["handoff", "work", OLD], { home: h.home, cwd, env: { FAKE_CLAUDE_LOG: log } });
    expect(JSON.parse(readFileSync(log, "utf8")).argv).toContain(OLD);
    const junk = await runCli(["handoff", "work", "nope"], { home: h.home, cwd });
    expect(junk.exitCode).toBe(1);
    expect(junk.stderr).toContain('"nope" is not a session id');
    const empty = await runCli(["handoff", "work"], { home: h.home, cwd: h.home });
    expect(empty.exitCode).toBe(1);
    expect(empty.stderr).toContain("no session for this directory");
    const ghost = await runCli(["handoff", "ghost"], { home: h.home, cwd });
    expect(ghost.stderr).toContain('profile "ghost" does not exist');
  });

  test("handoff is a reserved profile name", async () => {
    using h = fakeHome();
    expect((await runCli(["init", "handoff", "--no-login"], { home: h.home })).stderr).toContain("reserved");
  });
});

describe("statusline", () => {
  const payload = (five: number, week: number) =>
    JSON.stringify({
      session_id: "s",
      rate_limits: {
        five_hour: { used_percentage: five, resets_at: 1_797_500_000 },
        seven_day: { used_percentage: week, resets_at: 1_797_900_000 },
      },
    });

  test("prints the profile with its usage and remembers it under the profiles root", async () => {
    using h = fakeHome();
    await runCli(["init", "work", "--no-login"], { home: h.home });
    const env = { CLAUDE_CONFIG_DIR: join(h.profilesRoot, "work") };
    const r = await runCli(["statusline"], { home: h.home, env, stdin: payload(23.4, 41) });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("work · 5h 23% · 7d 41%\n");
    const cache = JSON.parse(readFileSync(join(h.profilesRoot, ".usage", "work.json"), "utf8"));
    expect(cache).toMatchObject({ fiveHour: { usedPercentage: 23.4, resetsAt: 1_797_500_000 }, source: "statusline" });
    expect(existsSync(join(h.base, ".usage"))).toBe(false);
    // The profiles root's .usage folder is not a profile.
    expect((await runCli(["list"], { home: h.home })).stdout).not.toContain(".usage");
  });

  test("prints only the name without rate limits, and default for ~/.claude", async () => {
    using h = fakeHome();
    const r = await runCli(["statusline"], { home: h.home, stdin: JSON.stringify({ session_id: "s" }) });
    expect(r.stdout).toBe("default\n");
    expect(existsSync(join(h.profilesRoot, ".usage"))).toBe(false);
  });
});

describe("usage", () => {
  test("asks each profile live with -p /usage, writes no transcript, and remembers the numbers", async () => {
    using h = fakeHome();
    await runCli(["init", "work", "--no-login"], { home: h.home });
    const log = join(h.home, "claude.log");
    const r = await runCli(["usage"], { home: h.home, env: { FAKE_CLAUDE_LOG: log } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^default\s+12%\s+Oct 17 at 1:59pm\s+34%\s+Oct 23 at 10:59pm\s+now$/m);
    expect(r.stdout).toMatch(/^work\s+12%/m);
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(calls.map((c: { configDir: string | null }) => c.configDir).sort()).toEqual(
      [join(h.profilesRoot, "work"), null].sort(),
    );
    for (const c of calls)
      expect(c.argv).toEqual(["-p", "/usage", "--output-format", "json", "--no-session-persistence"]);
    expect(existsSync(join(h.profilesRoot, ".usage", "work.json"))).toBe(true);
    const json = await runCli(["usage", "work", "--json"], { home: h.home });
    expect(JSON.parse(json.stdout)[0]).toMatchObject({
      name: "work",
      live: true,
      sevenDay: { usedPercentage: 34 },
      models: { Fable: { usedPercentage: 5 } },
    });
  });

  test("below Claude Code 2.1.301 shows the last seen numbers without asking, and --cached never asks", async () => {
    using h = fakeHome();
    await runCli(["init", "work", "--no-login"], { home: h.home });
    const stdin = JSON.stringify({ rate_limits: { seven_day: { used_percentage: 41, resets_at: 1_797_900_000 } } });
    await runCli(["statusline"], { home: h.home, env: { CLAUDE_CONFIG_DIR: join(h.profilesRoot, "work") }, stdin });
    const log = join(h.home, "claude.log");
    const old = await runCli(["usage"], {
      home: h.home,
      env: { FAKE_CLAUDE_VERSION: "2.1.300 (Claude Code)", FAKE_CLAUDE_LOG: log },
    });
    expect(old.stdout).toMatch(/^work\s+-\s+-\s+41%\s+.+\s+now \(statusline\)$/m);
    expect(old.stdout).toMatch(/^default\s+(-\s+){4}never$/m);
    expect(old.stdout).toContain("anthropics/claude-code/issues/95822");
    expect(existsSync(log)).toBe(false);
    const cached = await runCli(["usage", "--cached"], { home: h.home, env: { FAKE_CLAUDE_LOG: log } });
    expect(cached.stdout).toMatch(/^work\s+-\s+-\s+41%/m);
    expect(cached.stdout).not.toContain("95822");
    expect(existsSync(log)).toBe(false);
  });
});

describe("settings", () => {
  test("sets, lists, prints JSON and unsets a profile's settings", async () => {
    using h = fakeHome();
    await runCli(["init", "work", "--no-login"], { home: h.home });
    const set = await runCli(
      ["settings", "work", "model=opus", "syncClaudeAiSkills=false", 'enabledPlugins={"x@y":true}'],
      {
        home: h.home,
      },
    );
    expect(set.exitCode).toBe(0);
    const file = join(h.profilesRoot, "work", "claudep.settings.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      model: "opus",
      syncClaudeAiSkills: false,
      enabledPlugins: { "x@y": true },
    });
    const list = await runCli(["settings", "work"], { home: h.home });
    expect(list.stdout).toBe('model="opus"\nsyncClaudeAiSkills=false\nenabledPlugins={"x@y":true}\n');
    await runCli(["settings", "work", "--unset", "model", "enabledPlugins"], { home: h.home });
    expect(JSON.parse((await runCli(["settings", "work", "--json"], { home: h.home })).stdout)).toEqual({
      syncClaudeAiSkills: false,
    });
    await runCli(["settings", "work", "--unset", "syncClaudeAiSkills"], { home: h.home });
    expect(existsSync(file)).toBe(false);
  });

  test("refuses env, a bad key and the default profile", async () => {
    using h = fakeHome();
    await runCli(["init", "work", "--no-login"], { home: h.home });
    const env = await runCli(["settings", "work", 'env={"A":"1"}'], { home: h.home });
    expect(env.exitCode).toBe(1);
    expect(env.stderr).toContain("claudep vars");
    expect((await runCli(["settings", "work", "a.b=1"], { home: h.home })).stderr).toContain("not a settings key");
    expect((await runCli(["settings", "default", "model=opus"], { home: h.home })).stderr).toContain(
      "reads " + join(h.base, "settings.json"),
    );
  });

  test("run passes them with the auto-memory path, and your own --settings wins", async () => {
    using h = fakeHome();
    await runCli(["init", "work", "--no-login"], { home: h.home });
    await runCli(["settings", "work", "model=opus"], { home: h.home });
    const log = join(h.home, "claude.log");
    await runCli(["work", "x"], { home: h.home, env: { FAKE_CLAUDE_LOG: log } });
    const [flag, value, ...rest] = JSON.parse(readFileSync(log, "utf8")).argv;
    expect(flag).toBe("--settings");
    const settings = JSON.parse(value);
    expect(settings.model).toBe("opus");
    expect(typeof settings.autoMemoryDirectory).toBe("string");
    expect(rest).toEqual(["x"]);
    const own = await runCli(["work", "--settings", "{}", "x"], {
      home: h.home,
      env: { FAKE_CLAUDE_LOG: join(h.home, "own.log") },
    });
    expect(own.stderr).toContain("is not applied");
    expect(JSON.parse(readFileSync(join(h.home, "own.log"), "utf8")).argv).toEqual(["--settings", "{}", "x"]);
  });

  test("a broken file stops run and fails doctor", async () => {
    using h = fakeHome();
    await runCli(["init", "work", "--no-login"], { home: h.home });
    writeFileSync(join(h.profilesRoot, "work", "claudep.settings.json"), "{ nope");
    const r = await runCli(["work", "x"], { home: h.home });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("not valid JSON");
    const doc = await runCli(["doctor", "work"], { home: h.home });
    expect(doc.exitCode).toBe(1);
    expect(doc.stdout).toContain("claudep run refuses to start this profile");
    expect(doc.stdout).not.toContain("unexpected private items");
  });
});

/** Mark a profile as logged in the way Claude Code leaves it on this platform:
 *  an account in .claude.json plus the credential file, or the Keychain item
 *  the fake `security` answers for. */
function seedStoredLogin(dir: string): Record<string, string> {
  const j = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8"));
  j.oauthAccount = { emailAddress: "me@example.com", organizationName: "Me Org" };
  writeFileSync(join(dir, ".claude.json"), JSON.stringify(j));
  writeFileSync(join(dir, ".credentials.json"), "{}");
  return { FAKE_KEYCHAIN: keychainService(dir) };
}

describe("run links what the profile is missing", () => {
  test("links an item the base gained after init, once, and says so on stderr", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const dir = join(h.profilesRoot, "smoke");
    writeFileSync(join(h.base, "keybindings.json"), "{}");
    mkdirSync(join(h.base, "workflows"));
    const first = await runCli(["smoke", "-p", "hi"], { home: h.home });
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toContain("claudep: linked keybindings.json into smoke");
    expect(first.stderr).toContain("claudep: linked workflows into smoke");
    expect(norm(readlinkSync(join(dir, "keybindings.json")))).toBe(norm(join(h.base, "keybindings.json")));
    expect(lstatSync(join(dir, "workflows")).isSymbolicLink()).toBe(true);
    const second = await runCli(["smoke", "-p", "hi"], { home: h.home });
    expect(second.stderr).not.toContain("linked");
  });

  test("leaves a new top-level *.md to init", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    writeFileSync(join(h.base, "foo.md"), "# foo\n");
    const r = await runCli(["smoke", "-p", "hi"], { home: h.home });
    expect(r.stderr).not.toContain("linked");
    expect(existsSync(join(h.profilesRoot, "smoke", "foo.md"))).toBe(false);
    const doctor = await runCli(["doctor", "smoke"], { home: h.home });
    expect(doctor.stdout).toContain("foo.md: not linked (run: claudep init smoke)");
  });

  test("never replaces a real directory the profile made first", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const dir = join(h.profilesRoot, "smoke");
    mkdirSync(join(dir, "workflows"));
    writeFileSync(join(dir, "workflows", "mine.js"), "");
    mkdirSync(join(h.base, "workflows"));
    const r = await runCli(["smoke", "-p", "hi"], { home: h.home });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toContain("linked workflows");
    expect(lstatSync(join(dir, "workflows")).isDirectory()).toBe(true);
    expect(existsSync(join(dir, "workflows", "mine.js"))).toBe(true);
  });

  test("does not link from a custom base set in this shell, and skips what doctor accepts", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const dir = join(h.profilesRoot, "smoke");
    const custom = join(h.home, "custom");
    mkdirSync(custom);
    writeFileSync(join(custom, "keybindings.json"), "{}");
    const r = await runCli(["smoke", "-p", "hi"], { home: h.home, env: { CLAUDE_CONFIG_DIR: custom } });
    expect(r.stderr).not.toContain("linked");
    expect(existsSync(join(dir, "keybindings.json"))).toBe(false);

    writeFileSync(join(h.base, "keybindings.json"), "{}");
    await runCli(["doctor", "--accept", "smoke", "keybindings.json"], { home: h.home });
    await runCli(["smoke", "-p", "hi"], { home: h.home });
    expect(existsSync(join(dir, "keybindings.json"))).toBe(false);
  });

  test("doctor says the next run links a missing item", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    writeFileSync(join(h.base, "keybindings.json"), "{}");
    const r = await runCli(["doctor", "smoke"], { home: h.home });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("keybindings.json: not linked yet; the next claudep run links it");
  });
});

describe("init and the login", () => {
  test("skips the login on a signed-in profile and starts it when a login flag asks", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const dir = join(h.profilesRoot, "smoke");
    const env = seedStoredLogin(dir);
    const plain = await runCli(["init", "smoke"], { home: h.home, env });
    expect(plain.exitCode).toBe(0);
    expect(plain.stdout).toContain("already logged in as me@example.com (Me Org)");
    expect(plain.stdout).toContain("To log in again: claudep smoke auth login");
    expect(plain.stdout).not.toContain("Logging in");
    expect(existsSync(join(dir, ".fake-login.json"))).toBe(false);

    const sso = await runCli(["init", "smoke", "--sso"], { home: h.home, env });
    expect(sso.stdout).toContain("Logging in");
    expect(JSON.parse(readFileSync(join(dir, ".fake-login.json"), "utf8")).sso).toBe(true);
  });

  test("a recorded account with no credential still logs in", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const dir = join(h.profilesRoot, "smoke");
    seedStoredLogin(dir);
    rmSync(join(dir, ".credentials.json"));
    const r = await runCli(["init", "smoke"], { home: h.home, env: { FAKE_KEYCHAIN: "" } });
    // Windows trusts the account record, because the login can sit in Credential Manager.
    expect(r.stdout).toContain(WIN ? "already logged in" : "Logging in");
  });

  test("remembers login flags given with --no-login, prints them, and logs in with them", async () => {
    using h = fakeHome();
    const made = await runCli(["init", "corp", "--no-login", "--sso", "--email", "me@corp.example"], { home: h.home });
    expect(made.stdout).toContain("Next: claudep corp auth login --sso --email me@corp.example");
    const dir = join(h.profilesRoot, "corp");
    expect(readFileSync(join(dir, "claudep.login"), "utf8")).toBe("--sso --email me@corp.example\n");

    const status = await runCli(["status", "corp"], { home: h.home });
    expect(status.stdout).toContain("Log in: claudep corp auth login --sso --email me@corp.example");
    const doctor = await runCli(["doctor", "corp"], { home: h.home });
    expect(doctor.stdout).toContain("not logged in (claudep corp auth login --sso --email me@corp.example)");
    expect(doctor.stdout).not.toContain("claudep.login");

    const r = await runCli(["init", "corp"], { home: h.home });
    expect(r.stdout).toContain("Logging in");
    const login = JSON.parse(readFileSync(join(dir, ".fake-login.json"), "utf8"));
    expect(login.sso).toBe(true);
    expect(login.email).toBe("me@corp.example");
  });

  test("a signed-in profile with --no-login says so instead of asking for a login", async () => {
    using h = fakeHome();
    await runCli(["init", "corp", "--no-login", "--sso"], { home: h.home });
    const env = seedStoredLogin(join(h.profilesRoot, "corp"));
    const r = await runCli(["init", "corp", "--no-login"], { home: h.home, env });
    expect(r.stdout).toContain("To log in again: claudep corp auth login --sso");
    expect(r.stdout).not.toContain("Next:");
  });
});

describe("credential and config-dir guards", () => {
  test("vars refuses the refresh token and the secure storage variable; run reports a line it skips", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const refresh = await runCli(["vars", "smoke", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN=x"], { home: h.home });
    expect(refresh.exitCode).toBe(1);
    expect(refresh.stderr).toContain("never stores credentials");
    const secure = await runCli(["vars", "smoke", "CLAUDE_SECURESTORAGE_CONFIG_DIR=/x"], { home: h.home });
    expect(secure.exitCode).toBe(1);
    expect(secure.stderr).toContain("moves the profile's login");

    const dir = join(h.profilesRoot, "smoke");
    writeFileSync(join(dir, "claudep.env"), "A=1\nAWS_SECRET_ACCESS_KEY=x\n");
    const log = join(h.home, "log.jsonl");
    const r = await runCli(["smoke", "-p", "hi"], {
      home: h.home,
      env: { FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_LOG_ENV: "A,AWS_SECRET_ACCESS_KEY" },
    });
    expect(r.stderr).toContain("lines 2 are not KEY=VALUE");
    expect(r.stderr).not.toContain("=x");
    expect(JSON.parse(readFileSync(log, "utf8").trim()).env).toEqual({ A: "1", AWS_SECRET_ACCESS_KEY: null });
    const env = await runCli(["env", "smoke", "--shell", "sh"], { home: h.home });
    expect(env.stderr).toContain("lines 2");
    expect(env.stdout).not.toContain("AWS_SECRET_ACCESS_KEY");
  });

  test("run and doctor warn when an inherited secure storage variable moves the login", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const dir = join(h.profilesRoot, "smoke");
    const elsewhere = join(h.home, "elsewhere");
    const env = { CLAUDE_SECURESTORAGE_CONFIG_DIR: elsewhere };
    const run = await runCli(["smoke", "-p", "hi"], { home: h.home, env });
    expect(run.stderr).toContain(
      `CLAUDE_SECURESTORAGE_CONFIG_DIR is set, so Claude Code keeps the "smoke" login in ${elsewhere}`,
    );
    const doctor = await runCli(["doctor", "smoke"], { home: h.home, env });
    expect(doctor.stdout).toContain(`keeps this profile's login in ${elsewhere}`);
    const same = await runCli(["smoke", "-p", "hi"], {
      home: h.home,
      env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: dir },
    });
    expect(same.stderr).not.toContain("CLAUDE_SECURESTORAGE_CONFIG_DIR");
  });

  // Windows has no empty environment variable.
  test.skipIf(WIN)(
    "an empty CLAUDE_CONFIG_DIR stops current, run default and doctor, and a profile still runs",
    async () => {
      using h = fakeHome();
      await runCli(["init", "smoke", "--no-login"], { home: h.home });
      const env = { CLAUDE_CONFIG_DIR: "" };
      for (const args of [["current"], ["run", "default"], ["doctor"]]) {
        const r = await runCli(args, { home: h.home, env });
        expect(r.exitCode).toBe(1);
        expect(r.stdout + r.stderr).toContain("unset CLAUDE_CONFIG_DIR");
      }
      const doctor = await runCli(["doctor"], { home: h.home, env });
      expect(doctor.stdout).toContain(`base: ${h.base}`);
      const log = join(h.home, "log.jsonl");
      const r = await runCli(["smoke", "-p", "hi"], { home: h.home, env: { ...env, FAKE_CLAUDE_LOG: log } });
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(log, "utf8").trim()).configDir).toBe(join(h.profilesRoot, "smoke"));
    },
  );
});

describe("alias list, rewrite and doctor", () => {
  function shim(dir: string, cmd: string, target: string, profile: string): string {
    const [file] = aliasFiles(dir, cmd);
    if (!file) throw new Error("aliasFiles returned nothing");
    writeFileSync(file.path, aliasShim(file.kind, target, profile));
    return file.path;
  }

  /** PATH holding only the test's own directories, in this order. */
  const onlyPath = (...dirs: string[]) => ({
    PATH: [...dirs, ...(WIN ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32")] : [])].join(delimiter),
  });

  test("lists shims with their state, as text and JSON", async () => {
    using h = fakeHome();
    const bin = fakeBin(h.home, { withClaudep: true });
    await runCli(["init", "smoke", "--no-login", "--alias", "esmoke"], { home: h.home, bin });
    const gone = shim(bin, "egone", join(h.home, "gone", "claudep.ts"), "smoke");
    shim(bin, "eghost", SCRIPT, "ghost");
    const env = onlyPath(bin);
    const text = await runCli(["alias"], { home: h.home, bin, env });
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toMatch(/^COMMAND\s+PROFILE\s+STATE\s+TARGET\s+FILE/);
    const json = await runCli(["alias", "--json"], { home: h.home, bin, env });
    const rows = JSON.parse(json.stdout) as { command: string; state: string; path: string; profile: string }[];
    const state = (c: string) => rows.find((r) => r.command === c)?.state;
    expect(state("esmoke")).toBe("ok");
    expect(state("egone")).toBe("missing-target");
    expect(state("eghost")).toBe("missing-profile");
    expect(rows.find((r) => r.command === "egone")?.path).toBe(gone);

    const none = await runCli(["alias"], { home: h.home, bin: join(h.home, "nothing"), env: onlyPath(h.base) });
    expect(none.stdout).toContain("No alias shims on PATH");
  });

  test("rewrites a generated shim in place, also in another PATH directory, and leaves other files alone", async () => {
    using h = fakeHome();
    const bin = fakeBin(h.home, { withClaudep: true });
    const old = join(h.home, "oldbin");
    mkdirSync(old);
    await runCli(["init", "smoke", "--no-login"], { home: h.home, bin });
    const stale = shim(old, "esmoke", join(h.home, "gone", "claudep.ts"), "smoke");
    const env = onlyPath(bin, old);
    const r = await runCli(["alias", "smoke", "esmoke"], { home: h.home, bin, env });
    expect(r.stdout).toContain(`rewrote ${stale}`);
    expect(readFileSync(stale, "utf8")).toContain(realpathSync.native(SCRIPT));
    const [inBin] = aliasFiles(bin, "esmoke");
    expect(existsSync(inBin?.path ?? "")).toBe(false);
    const again = await runCli(["alias", "smoke", "esmoke"], { home: h.home, bin, env });
    expect(again.stdout).toContain("already runs profile smoke");
  });

  test("doctor fails on a dead shim, warns on another claudep, and names the fix", async () => {
    using h = fakeHome();
    const bin = fakeBin(h.home, { withClaudep: true });
    await runCli(["init", "smoke", "--no-login"], { home: h.home, bin });
    const env = onlyPath(bin);
    const other = join(h.home, "other-claudep.ts");
    writeFileSync(other, "");
    shim(bin, "eother", other, "smoke");
    const warned = await runCli(["doctor", "smoke"], { home: h.home, bin, env });
    expect(warned.exitCode).toBe(0);
    expect(warned.stdout).toContain(`runs another claudep: ${other}. Point it at this one: claudep alias smoke eother`);

    const dead = shim(bin, "edead", join(h.home, "gone", "claudep.ts"), "smoke");
    shim(bin, "eghost", SCRIPT, "ghost");
    const failed = await runCli(["doctor"], { home: h.home, bin, env });
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout).toContain(`alias edead (${dead}) runs`);
    expect(failed.stdout).toContain("Rewrite it: claudep alias smoke edead");
    expect(failed.stdout).toContain('runs the profile "ghost", which does not exist');
    expect(failed.stdout).toContain("2 problem(s)");

    const scoped = await runCli(["doctor", "smoke"], { home: h.home, bin, env });
    expect(scoped.stdout).not.toContain("ghost");
  });

  test("a shim behind an earlier PATH entry of the same name is reported as shadowed", async () => {
    using h = fakeHome();
    const bin = fakeBin(h.home, { withClaudep: true });
    const first = join(h.home, "firstbin");
    mkdirSync(first);
    await runCli(["init", "smoke", "--no-login", "--alias", "esmoke"], { home: h.home, bin });
    const [name] = aliasFiles(first, "esmoke");
    writeFileSync(name?.path ?? "", "not a shim, and far too long to be read as one: ".repeat(40));
    const r = await runCli(["alias", "--json"], { home: h.home, bin, env: onlyPath(first, bin) });
    const rows = JSON.parse(r.stdout) as { command: string; state: string }[];
    expect(rows.map((x) => [x.command, x.state])).toContainEqual(["esmoke", "shadowed"]);
  });
});

describe("alias never damages what it did not write", () => {
  test("a symlink is left alone and its target is untouched, also when dangling", async () => {
    using h = fakeHome();
    const bin = fakeBin(h.home, { withClaudep: true });
    await runCli(["init", "smoke", "--no-login"], { home: h.home, bin });
    const target = join(h.home, "tool");
    writeFileSync(target, "mine\n");
    const [file] = aliasFiles(bin, "mytool");
    const [gone] = aliasFiles(bin, "gone");
    if (!file || !gone) throw new Error("aliasFiles returned nothing");
    symlinkSync(target, file.path);
    symlinkSync(join(h.home, "nothing-here"), gone.path);
    for (const cmd of ["mytool", "gone"]) {
      const r = await runCli(["alias", "smoke", cmd], { home: h.home, bin });
      expect(r.stdout).toContain("already exists. Not overwriting");
    }
    expect(readFileSync(target, "utf8")).toBe("mine\n");
    expect(existsSync(join(h.home, "nothing-here"))).toBe(false);
  });

  test("refuses the names a shim runs", async () => {
    using h = fakeHome();
    const bin = fakeBin(h.home, { withClaudep: true });
    await runCli(["init", "smoke", "--no-login"], { home: h.home, bin });
    const script = readFileSync(SCRIPT, "utf8");
    for (const cmd of ["claude", "claudep"]) {
      const r = await runCli(["alias", "smoke", cmd], { home: h.home, bin });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("pick another name");
    }
    expect(readFileSync(SCRIPT, "utf8")).toBe(script);
  });

  test("a directory of that name is a warning, not a crash", async () => {
    using h = fakeHome();
    const bin = fakeBin(h.home, { withClaudep: true });
    await runCli(["init", "smoke", "--no-login"], { home: h.home, bin });
    for (const { path } of aliasFiles(bin, "adir")) mkdirSync(path);
    const r = await runCli(["alias", "smoke", "adir"], { home: h.home, bin });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("already exists. Not overwriting");
  });

  // Windows ignores the read-only bit on a directory, and root ignores it everywhere.
  test.skipIf(WIN || process.getuid?.() === 0)("a shim in a read-only directory fails with a message", async () => {
    using h = fakeHome();
    const bin = fakeBin(h.home, { withClaudep: true });
    const locked = join(h.home, "locked");
    mkdirSync(locked);
    await runCli(["init", "smoke", "--no-login"], { home: h.home, bin });
    writeFileSync(join(locked, "esmoke"), aliasShim("sh", join(h.home, "gone", "claudep.ts"), "smoke"));
    chmodSync(join(locked, "esmoke"), 0o444);
    chmodSync(locked, 0o555);
    try {
      const r = await runCli(["alias", "smoke", "esmoke"], {
        home: h.home,
        bin,
        env: { PATH: [bin, locked].join(delimiter) },
      });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain(`could not write ${join(locked, "esmoke")}`);
      expect(r.stderr).not.toContain("at ");
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

describe("accepted items and other bases", () => {
  test("init leaves an accepted item alone until --force", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const dir = join(h.profilesRoot, "smoke");
    rmSync(join(dir, "CLAUDE.md"));
    await runCli(["doctor", "--accept", "smoke", "CLAUDE.md"], { home: h.home });
    const r = await runCli(["init", "smoke", "--no-login"], { home: h.home });
    expect(r.stdout).toContain("CLAUDE.md left as it is; doctor accepts it");
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
    await runCli(["init", "smoke", "--no-login", "--force"], { home: h.home });
    expect(lstatSync(join(dir, "CLAUDE.md")).isSymbolicLink()).toBe(true);
  });

  test("a profile built on a custom base gets no links from ~/.claude, and doctor does not promise any", async () => {
    using h = fakeHome();
    const custom = join(h.home, "custom");
    mkdirSync(custom);
    writeFileSync(join(custom, "keybindings.json"), "{}");
    await runCli(["init", "cust", "--no-login"], { home: h.home, env: { CLAUDE_CONFIG_DIR: custom } });
    const dir = join(h.profilesRoot, "cust");
    const r = await runCli(["cust", "-p", "hi"], { home: h.home });
    expect(r.stderr).not.toContain("linked");
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
    const doctor = await runCli(["doctor", "cust"], { home: h.home });
    expect(doctor.stdout).toContain("CLAUDE.md: not linked (run: claudep init cust)");
    const shell = await runCli(["doctor", "cust"], { home: h.home, env: { CLAUDE_CONFIG_DIR: custom } });
    expect(shell.stdout).not.toContain("the next claudep run links it");
  });
});

describe("doctor --json and --accept", () => {
  test("--json prints the checks, one schema, and keeps the exit code", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const clean = await runCli(["doctor", "--json"], { home: h.home });
    expect(clean.exitCode).toBe(0);
    const j = JSON.parse(clean.stdout);
    expect(j.schemaVersion).toBe(1);
    expect(j.claude.version).toBe("9.9.9");
    expect(j.base.dir).toBe(h.base);
    expect(j.problems).toBe(0);
    expect(j.profiles.map((p: { name: string }) => p.name)).toEqual(["smoke"]);
    const login = j.profiles[0].checks.find((x: { item: string }) => x.item === "login");
    expect(login).toMatchObject({
      state: "logged-out",
      level: "warn",
      fix: "claudep smoke auth login",
      problem: false,
    });

    writeFileSync(join(h.base, "keybindings.json"), "{}");
    const broken = await runCli(["doctor", "smoke", "--json"], { home: h.home });
    expect(broken.exitCode).toBe(1);
    const k = JSON.parse(broken.stdout);
    expect(k.problems).toBe(1);
    const item = k.profiles[0].checks.find((x: { item: string }) => x.item === "keybindings.json");
    expect(item).toMatchObject({ state: "missing", level: "warn", problem: true });
  });

  test("rejects an unknown flag instead of reading it as a profile", async () => {
    using h = fakeHome();
    const r = await runCli(["doctor", "--nope"], { home: h.home });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("unknown flag --nope");
  });

  test("--accept turns one difference into info and exit 0; --unaccept brings it back", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const dir = join(h.profilesRoot, "smoke");
    rmSync(join(dir, "settings.json"));
    writeFileSync(join(dir, "settings.json"), "{}");
    expect((await runCli(["doctor", "smoke"], { home: h.home })).exitCode).toBe(1);

    const accept = await runCli(["doctor", "--accept", "smoke", "settings.json"], { home: h.home });
    expect(accept.exitCode).toBe(0);
    expect(readFileSync(join(dir, "claudep.doctor"), "utf8")).toContain("settings.json\n");
    const r = await runCli(["doctor", "smoke"], { home: h.home });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("settings.json: real file shadows the shared one (accepted)");
    expect(r.stdout).not.toContain("claudep.doctor");
    const j = JSON.parse((await runCli(["doctor", "smoke", "--json"], { home: h.home })).stdout);
    expect(j.profiles[0].checks.find((x: { item: string }) => x.item === "settings.json")).toMatchObject({
      state: "accepted",
      level: "info",
      problem: false,
    });

    await runCli(["doctor", "--unaccept", "smoke", "settings.json"], { home: h.home });
    expect(existsSync(join(dir, "claudep.doctor"))).toBe(false);
    expect((await runCli(["doctor", "smoke"], { home: h.home })).exitCode).toBe(1);
  });

  test("--accept refuses what is not a shared item and a profile that does not exist", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const item = await runCli(["doctor", "--accept", "smoke", ".credentials.json"], { home: h.home });
    expect(item.exitCode).toBe(1);
    expect(item.stderr).toContain("not a shared item");
    const ghost = await runCli(["doctor", "--accept", "ghost", "skills"], { home: h.home });
    expect(ghost.stderr).toContain('profile "ghost" does not exist');
    const both = await runCli(["doctor", "--accept", "--unaccept", "smoke", "skills"], { home: h.home });
    expect(both.stderr).toContain("not both");
  });

  test("a shadowing directory and settings.json explain themselves, by key name only", async () => {
    using h = fakeHome();
    writeFileSync(join(h.base, "settings.json"), JSON.stringify({ model: "a", theme: "dark", env: { A: "1" } }));
    writeFileSync(join(h.base, "skills", "shared-skill"), "");
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const dir = join(h.profilesRoot, "smoke");
    rmSync(join(dir, "settings.json"));
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ model: "secret-value", theme: "dark", env: { A: "2" } }),
    );
    rmSync(join(dir, "skills"));
    mkdirSync(join(dir, "skills"));
    symlinkSync(join(h.base, "skills", "shared-skill"), join(dir, "skills", "shared-skill"));
    mkdirSync(join(dir, "skills", "synced"));
    const r = await runCli(["doctor", "smoke"], { home: h.home });
    expect(r.stdout).toContain("keys that differ: env, model");
    expect(r.stdout).toContain("claudep settings smoke <key>=<value> can carry model");
    expect(r.stdout).not.toContain("secret-value");
    expect(r.stdout).toContain("1 of 2 entries link into the base; only here: synced");
    expect(r.stdout).toContain(`To share it: ${shareFixCommand(join(dir, "skills"), "smoke", WIN)}`);
    expect(r.stdout).toContain("To keep it: claudep doctor --accept smoke skills");
    expect(r.stdout).toContain("A launch never replaces it");
  });
});

describe("doctor reads managed settings", () => {
  test("the managed env is the strongest source, and a later drop-in wins", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const managed = join(h.home, "managed");
    mkdirSync(join(managed, "managed-settings.d"), { recursive: true });
    writeFileSync(join(managed, "managed-settings.json"), JSON.stringify({ env: { DISABLE_AUTOUPDATER: "0" } }));
    const env = { CLAUDEP_MANAGED_DIR: managed, DISABLE_AUTOUPDATER: "0" };
    const off = await runCli(["doctor", "smoke"], { home: h.home, env });
    expect(off.stdout).not.toContain("managed settings env");

    writeFileSync(
      join(managed, "managed-settings.d", "10-a.json"),
      JSON.stringify({ env: { DISABLE_AUTOUPDATER: "1" } }),
    );
    const on = await runCli(["doctor", "smoke"], { home: h.home, env });
    expect(on.stdout).toContain("auto-update off (DISABLE_AUTOUPDATER in managed settings env)");

    writeFileSync(
      join(managed, "managed-settings.d", "20-b.json"),
      JSON.stringify({ env: { DISABLE_AUTOUPDATER: "0" } }),
    );
    writeFileSync(
      join(managed, "managed-settings.d", ".30-hidden.json"),
      JSON.stringify({ env: { DISABLE_AUTOUPDATER: "1" } }),
    );
    const later = await runCli(["doctor", "smoke"], { home: h.home, env });
    expect(later.stdout).not.toContain("managed settings env");
  });
});
