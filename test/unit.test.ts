import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  baseEnv,
  canon,
  currentProfile,
  envFor,
  formatTable,
  keychainService,
  layout,
  NAME_RE,
  PIN_FILE,
  parseAuthStatus,
  parseFlags,
  RESERVED,
  resolvePin,
  shellInit,
  version,
} from "../claudep.ts";
import { fakeHome } from "./lib/home.ts";

describe("canon", () => {
  test("expands ~/ against the given home", () => {
    expect(canon("~/x/y", "/home/me")).toBe("/home/me/x/y");
  });

  test("drops trailing slashes", () => {
    expect(canon("/a/b///", "/h")).toBe("/a/b");
  });

  test("normalizes to NFC so the keychain hash is stable", () => {
    const decomposed = "/a/café";
    expect(canon(decomposed, "/h")).toBe("/a/café");
  });

  test("resolves relative paths against cwd", () => {
    expect(canon("rel", "/h")).toBe(`${process.cwd()}/rel`);
  });
});

describe("keychainService", () => {
  test("matches Claude Code's naming: prefix + first 8 hex of sha256(dir)", () => {
    // sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    expect(keychainService("abc")).toBe("Claude Code-credentials-ba7816bf");
  });

  test("different strings for the same dir with and without a trailing slash", () => {
    expect(keychainService("/x/y")).not.toBe(keychainService("/x/y/"));
    const h = createHash("sha256").update("/x/y").digest("hex").slice(0, 8);
    expect(keychainService("/x/y")).toBe(`Claude Code-credentials-${h}`);
  });
});

describe("layout", () => {
  test("defaults everything under HOME", () => {
    const L = layout({ HOME: "/home/me" });
    expect(L).toEqual({
      home: "/home/me",
      callerConfigDir: undefined,
      managed: false,
      activeProfile: undefined,
      base: "/home/me/.claude",
      baseGlobalJson: "/home/me/.claude.json",
      profilesRoot: "/home/me/.claudep",
    });
  });

  test("honours CLAUDE_CONFIG_DIR from the caller's shell and moves .claude.json inside it", () => {
    const L = layout({ HOME: "/home/me", CLAUDE_CONFIG_DIR: "/cfg/" });
    expect(L.callerConfigDir).toBe("/cfg/");
    expect(L.base).toBe("/cfg");
    expect(L.baseGlobalJson).toBe("/cfg/.claude.json");
  });

  test("treats a CLAUDE_CONFIG_DIR inside the profiles root as an active profile, not a base", () => {
    const L = layout({ HOME: "/home/me", CLAUDE_CONFIG_DIR: "/home/me/.claudep/work/" });
    expect(L.managed).toBe(true);
    expect(L.activeProfile).toBe("work");
    expect(L.base).toBe("/home/me/.claude");
    expect(L.baseGlobalJson).toBe("/home/me/.claude.json");
  });

  test("a nested or invalid dir under the root is managed but names no profile", () => {
    const L = layout({ HOME: "/home/me", CLAUDE_CONFIG_DIR: "/home/me/.claudep/work/sub" });
    expect(L.managed).toBe(true);
    expect(L.activeProfile).toBeUndefined();
  });

  test("honours CLAUDE_PROFILES_DIR with ~ expansion", () => {
    const L = layout({ HOME: "/home/me", CLAUDE_PROFILES_DIR: "~/profiles/" });
    expect(L.profilesRoot).toBe("/home/me/profiles");
  });
});

describe("envFor", () => {
  test("sets CLAUDE_CONFIG_DIR for a profile without mutating the input", () => {
    const env = { PATH: "/bin" };
    const out = envFor("/p", env);
    expect(out).toEqual({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/p" });
    expect(env).toEqual({ PATH: "/bin" });
  });

  test("leaves the caller's CLAUDE_CONFIG_DIR alone for the base", () => {
    expect(envFor(undefined, { CLAUDE_CONFIG_DIR: "/keep" })).toEqual({ CLAUDE_CONFIG_DIR: "/keep" });
    expect(envFor(undefined, {})).toEqual({});
  });
});

describe("parseFlags", () => {
  test("separates booleans, string flags and positionals", () => {
    const f = parseFlags(["smoke", "--sso", "--email", "a@b.c", "extra"], ["--sso"], ["--email"]);
    expect([...f.bools]).toEqual(["--sso"]);
    expect(f.strs.get("--email")).toBe("a@b.c");
    expect(f.rest).toEqual(["smoke", "extra"]);
  });

  test("accepts --key=value, keeping any later = in the value", () => {
    const f = parseFlags(["--email=a=b"], [], ["--email"]);
    expect(f.strs.get("--email")).toBe("a=b");
  });

  test("dies on an unknown flag", () => {
    const exit = spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => parseFlags(["--nope"], [], [])).toThrow("exit 1");
      expect(err.mock.calls[0]?.[0]).toContain("unknown flag --nope");
    } finally {
      exit.mockRestore();
      err.mockRestore();
    }
  });

  test("dies when a string flag has no value", () => {
    const exit = spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => parseFlags(["--email"], [], ["--email"])).toThrow("exit 1");
    } finally {
      exit.mockRestore();
      err.mockRestore();
    }
  });
});

describe("profile names", () => {
  test.each([
    ["enterprise", true],
    ["work-2", true],
    ["a_b", true],
    ["9lives", true],
    ["Enterprise", false],
    ["-lead", false],
    ["has space", false],
    ["dots.no", false],
    ["", false],
  ])("NAME_RE %p -> %p", (name, valid) => {
    expect(NAME_RE.test(name)).toBe(valid);
  });

  test("every subcommand word is reserved", () => {
    for (const w of [
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
      "default",
      "base",
    ])
      expect(RESERVED.has(w)).toBe(true);
  });
});

describe("parseAuthStatus", () => {
  test("extracts the fields claudep shows", () => {
    const s = parseAuthStatus(
      JSON.stringify({
        loggedIn: true,
        email: "a@b.c",
        orgName: "Org",
        subscriptionType: "max",
        authMethod: "claude.ai",
        orgId: "x",
      }),
    );
    expect(s).toEqual({
      loggedIn: true,
      email: "a@b.c",
      orgName: "Org",
      subscriptionType: "max",
      authMethod: "claude.ai",
    });
  });

  test("treats garbage or non-objects as logged out", () => {
    expect(parseAuthStatus("not json")).toEqual({ loggedIn: false });
    expect(parseAuthStatus("42")).toEqual({ loggedIn: false });
    expect(parseAuthStatus("")).toEqual({ loggedIn: false });
  });
});

describe("formatTable", () => {
  test("aligns columns and shortens the home dir to ~", () => {
    const lines = formatTable(
      [
        {
          name: "default",
          dir: "/home/me/.claude",
          status: { loggedIn: true, email: "me@x.io", orgName: "Org", subscriptionType: "max" },
        },
        { name: "work", dir: "/home/me/.claudep/work", status: { loggedIn: false } },
      ],
      "/home/me",
    );
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^PROFILE {2}LOGIN {2}EMAIL {4}ORG {2}PLAN {2}DIR/);
    expect(lines[1]).toContain("~/.claude ");
    expect(lines[2]).toContain("~/.claudep/work");
    expect(lines[2]?.trimEnd()).toMatch(/^work\s+no\s+-\s+-\s+-\s+~\/\.claudep\/work$/);
    const [h, a, b] = lines as [string, string, string];
    expect(a.indexOf("~/")).toBe(h.indexOf("DIR"));
    expect(b.indexOf("~/")).toBe(h.indexOf("DIR"));
  });

  test("leaves dirs outside home untouched", () => {
    const [, line] = formatTable([{ name: "x", dir: "/opt/cfg", status: { loggedIn: false } }], "/home/me");
    expect(line).toContain("/opt/cfg");
    expect(line).not.toContain("~");
  });
});

describe("baseEnv", () => {
  test("strips a hook or manual claudep pin so the base really is the base", () => {
    const env = { CLAUDE_CONFIG_DIR: "/home/me/.claudep/work", CLAUDEP_AUTO: "/home/me/.claudep/work", PATH: "/bin" };
    const L = layout({ HOME: "/home/me", ...env });
    expect(baseEnv(L, env)).toEqual({ PATH: "/bin" });
  });

  test("keeps a custom CLAUDE_CONFIG_DIR that lives outside the profiles root", () => {
    const env = { CLAUDE_CONFIG_DIR: "/opt/cfg" };
    expect(baseEnv(layout({ HOME: "/home/me", ...env }), env)).toEqual(env);
  });
});

describe("currentProfile", () => {
  test("base when nothing is set", () => {
    const L = layout({ HOME: "/home/me" });
    expect(currentProfile(L, {})).toEqual({ kind: "base", name: undefined, dir: "/home/me/.claude", setBy: "none" });
  });

  test("profile set by the hook when CLAUDEP_AUTO matches", () => {
    const env = { CLAUDE_CONFIG_DIR: "/home/me/.claudep/work", CLAUDEP_AUTO: "/home/me/.claudep/work/" };
    const cur = currentProfile(layout({ HOME: "/home/me", ...env }), env);
    expect(cur).toEqual({ kind: "profile", name: "work", dir: "/home/me/.claudep/work", setBy: "hook" });
  });

  test("manual pin when CLAUDEP_AUTO is absent or points elsewhere", () => {
    const a = { CLAUDE_CONFIG_DIR: "/home/me/.claudep/work" };
    expect(currentProfile(layout({ HOME: "/home/me", ...a }), a).setBy).toBe("manual");
    const b = { CLAUDE_CONFIG_DIR: "/home/me/.claudep/work", CLAUDEP_AUTO: "/home/me/.claudep/other" };
    expect(currentProfile(layout({ HOME: "/home/me", ...b }), b).setBy).toBe("manual");
  });

  test("custom for a dir outside the profiles root", () => {
    const env = { CLAUDE_CONFIG_DIR: "/opt/cfg" };
    expect(currentProfile(layout({ HOME: "/home/me", ...env }), env)).toEqual({
      kind: "custom",
      name: undefined,
      dir: "/opt/cfg",
      setBy: "manual",
    });
  });
});

describe("resolvePin", () => {
  test("nearest file wins and reports where it was found", () => {
    using h = fakeHome();
    const tree = join(h.home, "repo", "a", "b");
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(h.home, "repo", PIN_FILE), "outer\n");
    writeFileSync(join(h.home, "repo", "a", PIN_FILE), "# comment\n\n  inner  \n");
    expect(resolvePin(tree)).toEqual({
      name: "inner",
      file: join(h.home, "repo", "a", PIN_FILE),
      dir: join(h.home, "repo", "a"),
    });
    expect(resolvePin(join(h.home, "repo"))?.name).toBe("outer");
  });

  test("an empty pin cancels a parent pin", () => {
    using h = fakeHome();
    const tree = join(h.home, "repo", "sub");
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(h.home, "repo", PIN_FILE), "outer\n");
    writeFileSync(join(tree, PIN_FILE), "# nothing here\n");
    expect(resolvePin(tree)?.name).toBe("");
  });

  test("skips a directory named like the pin file, such as ~/.claudep itself", () => {
    using h = fakeHome();
    mkdirSync(join(h.home, PIN_FILE, "work"), { recursive: true });
    const tree = join(h.home, "somewhere");
    mkdirSync(tree);
    expect(resolvePin(tree)).toBeUndefined();
  });

  test("returns undefined at the filesystem root", () => {
    expect(resolvePin(`/claudep-does-not-exist-${Date.now()}`)).toBeUndefined();
  });
});

describe("version", () => {
  test("reads package.json", async () => {
    const pkg = (await Bun.file(join(import.meta.dir, "..", "package.json")).json()) as { version: string };
    expect(version()).toBe(pkg.version);
  });
});

describe("shellInit", () => {
  test.each(["zsh", "bash"] as const)("%s hook has no subprocess and embeds the profiles root", (shell) => {
    const out = shellInit(shell, "/home/me/.claudep");
    expect(out).toContain("_claudep_root='/home/me/.claudep'");
    const body = out
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    expect(body).not.toMatch(/\$\(|`/);
    expect(out).toContain(shell === "zsh" ? "add-zsh-hook chpwd _claudep_auto" : "PROMPT_COMMAND");
  });

  test("single-quotes a root with an apostrophe safely", () => {
    expect(shellInit("bash", "/home/o'brien/.claudep")).toContain(`_claudep_root='/home/o'\\''brien/.claudep'`);
  });
});
