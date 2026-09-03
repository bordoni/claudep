import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  canon,
  envFor,
  formatTable,
  keychainService,
  layout,
  NAME_RE,
  parseAuthStatus,
  parseFlags,
  RESERVED,
} from "../claudep.ts";

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
