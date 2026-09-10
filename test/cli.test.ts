import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { aliasFiles, envScript, fishQuote, keychainService, SHELLS } from "../claudep.ts";
import { fakeBin, REPO, runCli, SCRIPT } from "./lib/cli.ts";
import { BASE_DIRS, BASE_FILES, fakeHome, PRIVATE_DIRS, PRIVATE_FILES, writeLogin } from "./lib/home.ts";
import { norm, rx, tilde } from "./lib/paths.ts";

const SHARED = [...BASE_FILES, ...BASE_DIRS] as readonly string[];
const WIN = process.platform === "win32";

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
    });
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
    });
    expect(rows[1]).toEqual({ name: "smoke", dir: join(h.profilesRoot, "smoke"), loggedIn: false, authMethod: "none" });
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
    expect(entry).toEqual({ argv: ["-p", "say hi", "--model", "x"], configDir: join(h.profilesRoot, "smoke") });
  });

  test("`run <name> -- args` strips the separator", async () => {
    using h = fakeHome();
    await runCli(["init", "smoke", "--no-login"], { home: h.home });
    const log = join(h.home, "claude.log");
    await runCli(["run", "smoke", "--", "--version-ish"], { home: h.home, env: { FAKE_CLAUDE_LOG: log } });
    expect(JSON.parse(readFileSync(log, "utf8")).argv).toEqual(["--version-ish"]);
  });

  test("`default` runs claude with the caller's environment untouched", async () => {
    using h = fakeHome();
    const log = join(h.home, "claude.log");
    await runCli(["default", "x"], { home: h.home, env: { FAKE_CLAUDE_LOG: log } });
    expect(JSON.parse(readFileSync(log, "utf8")).configDir).toBeNull();
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
