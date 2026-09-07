import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import {
  baseEnv,
  canon,
  currentProfile,
  deleteEnv,
  type Env,
  envFor,
  formatTable,
  homeDir,
  isInside,
  isMsysPath,
  keychainService,
  layout,
  NAME_RE,
  onPath,
  PIN_FILE,
  parseAuthStatus,
  parseFlags,
  pathKey,
  RESERVED,
  resolvePin,
  samePath,
  shellInit,
  shortHome,
  splitPathVar,
  toNativePath,
  version,
} from "../claudep.ts";
import { fakeHome } from "./lib/home.ts";

describe("canon", () => {
  test("expands ~/ against the given home", () => {
    expect(canon("~/x/y", "/home/me", "linux")).toBe("/home/me/x/y");
  });

  test("drops trailing slashes", () => {
    expect(canon("/a/b///", "/h", "linux")).toBe("/a/b");
  });

  test("keeps the root itself", () => {
    expect(canon("/", "/h", "linux")).toBe("/");
  });

  test("normalizes to NFC so the keychain hash is stable", () => {
    const decomposed = "/a/café";
    expect(canon(decomposed, "/h", "linux")).toBe("/a/café");
  });

  test("resolves relative paths against cwd", () => {
    expect(canon("rel", "/h")).toBe(resolve("rel"));
  });
});

describe("canon on win32", () => {
  const home = "C:\\Users\\me";

  test("expands ~/ and ~\\ against the given home", () => {
    expect(canon("~/x", home, "win32")).toBe("C:\\Users\\me\\x");
    expect(canon("~\\x", home, "win32")).toBe("C:\\Users\\me\\x");
  });

  test("drops trailing separators of either kind", () => {
    expect(canon("C:\\Users\\me\\.claudep\\", home, "win32")).toBe("C:\\Users\\me\\.claudep");
    expect(canon("C:/Users/me/.claudep/", home, "win32")).toBe("C:\\Users\\me\\.claudep");
  });

  test("rewrites an MSYS /c/ path to a native one", () => {
    expect(canon("/c/Users/me/.claudep/", home, "win32")).toBe("C:\\Users\\me\\.claudep");
    expect(canon("/d", home, "win32")).toBe("D:\\");
  });

  test("upper-cases the drive letter and keeps the rest as spelled", () => {
    expect(canon("c:/users/ME/x", home, "win32")).toBe("C:\\users\\ME\\x");
  });

  test("strips the \\\\?\\ prefix", () => {
    expect(canon("\\\\?\\C:\\a\\b", home, "win32")).toBe("C:\\a\\b");
    expect(canon("\\\\?\\UNC\\srv\\share\\x", home, "win32")).toBe("\\\\srv\\share\\x");
  });

  test("still applies NFC", () => {
    expect(canon("C:\\a\\café", home, "win32")).toBe("C:\\a\\café");
  });
});

describe("path helpers", () => {
  test("toNativePath only touches win32", () => {
    expect(toNativePath("/c/x", "linux")).toBe("/c/x");
    expect(toNativePath("/c/x", "win32")).toBe("C:/x");
    expect(toNativePath("\\\\?\\C:\\x", "win32")).toBe("C:\\x");
    expect(toNativePath("C:\\x", "win32")).toBe("C:\\x");
  });

  test("isMsysPath", () => {
    expect(isMsysPath("/c/Users/me")).toBe(true);
    expect(isMsysPath("/c")).toBe(true);
    expect(isMsysPath("/cygdrive/c")).toBe(false);
    expect(isMsysPath("/home/me")).toBe(false);
    expect(isMsysPath("C:\\Users")).toBe(false);
  });

  test("pathKey is identity on POSIX and folds case, slashes and prefixes on win32", () => {
    expect(pathKey("/A/b", "linux")).toBe("/A/b");
    expect(pathKey("\\\\?\\C:/A/b\\", "win32")).toBe("c:\\a\\b");
  });

  test("samePath is exact on POSIX and case-insensitive on win32", () => {
    expect(samePath("/a/b", "/A/B", "linux")).toBe(false);
    expect(samePath("C:\\A\\b", "c:/a/B", "win32")).toBe(true);
    expect(samePath("C:\\A\\b", "C:\\A\\b\\c", "win32")).toBe(false);
  });

  test("isInside needs a separator boundary and respects the platform's case rule", () => {
    expect(isInside("/r", "/r/x", "linux")).toBe(true);
    expect(isInside("/r", "/rx", "linux")).toBe(false);
    expect(isInside("/r", "/r", "linux")).toBe(false);
    expect(isInside("/", "/x", "linux")).toBe(true);
    expect(isInside("C:\\r", "c:\\R\\work", "win32")).toBe(true);
    expect(isInside("C:\\r", "C:\\rx", "win32")).toBe(false);
    expect(isInside("C:\\", "C:\\x", "win32")).toBe(true);
  });

  test("shortHome", () => {
    expect(shortHome("/home/me/.claude", "/home/me", "linux")).toBe("~/.claude");
    expect(shortHome("/home/me", "/home/me", "linux")).toBe("~");
    expect(shortHome("/home/me2/x", "/home/me", "linux")).toBe("/home/me2/x");
    expect(shortHome("/opt/cfg", "/home/me", "linux")).toBe("/opt/cfg");
    expect(shortHome("C:\\Users\\ME\\.claudep\\x", "C:\\Users\\me", "win32")).toBe("~\\.claudep\\x");
    expect(shortHome("D:\\other", "C:\\Users\\me", "win32")).toBe("D:\\other");
  });

  test("deleteEnv removes every spelling on win32 and only the exact one elsewhere", () => {
    const a: Env = { Claude_Config_Dir: "x", CLAUDE_CONFIG_DIR: "y", PATH: "p" };
    deleteEnv(a, "CLAUDE_CONFIG_DIR", "win32");
    expect(a).toEqual({ PATH: "p" });
    const b: Env = { Claude_Config_Dir: "x", CLAUDE_CONFIG_DIR: "y" };
    deleteEnv(b, "CLAUDE_CONFIG_DIR", "linux");
    expect(b).toEqual({ Claude_Config_Dir: "x" });
  });

  test("splitPathVar uses the platform delimiter and never splits a drive letter", () => {
    expect(splitPathVar("/a:/b::", "linux")).toEqual(["/a", "/b"]);
    expect(splitPathVar("C:\\a;C:\\b;", "win32")).toEqual(["C:\\a", "C:\\b"]);
  });

  test("onPath finds a directory through the native delimiter", () => {
    using h = fakeHome();
    const dir = join(h.home, "bin");
    const other = join(h.home, "other");
    mkdirSync(dir);
    mkdirSync(other);
    expect(onPath(dir, [other, dir].join(delimiter))).toBe(true);
    expect(onPath(dir, other)).toBe(false);
    expect(onPath(dir, [other, join(h.home, "missing")].join(delimiter))).toBe(false);
    expect(onPath(realpathSync(dir), dir)).toBe(true);
  });
});

describe("homeDir", () => {
  test("HOME first on POSIX", () => {
    expect(homeDir({ HOME: "/home/me", USERPROFILE: "C:\\Users\\me" }, "linux")).toBe("/home/me");
  });

  test("USERPROFILE first on win32, then a HOME converted from MSYS form", () => {
    expect(homeDir({ HOME: "/c/Users/me", USERPROFILE: "C:\\Users\\me" }, "win32")).toBe("C:\\Users\\me");
    expect(homeDir({ HOME: "/c/Users/me" }, "win32")).toBe("C:/Users/me");
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
    const L = layout({ HOME: "/home/me" }, "linux");
    expect(L).toEqual({
      platform: "linux",
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
    const L = layout({ HOME: "/home/me", CLAUDE_CONFIG_DIR: "/cfg/" }, "linux");
    expect(L.callerConfigDir).toBe("/cfg/");
    expect(L.base).toBe("/cfg");
    expect(L.baseGlobalJson).toBe("/cfg/.claude.json");
  });

  test("treats a CLAUDE_CONFIG_DIR inside the profiles root as an active profile, not a base", () => {
    const L = layout({ HOME: "/home/me", CLAUDE_CONFIG_DIR: "/home/me/.claudep/work/" }, "linux");
    expect(L.managed).toBe(true);
    expect(L.activeProfile).toBe("work");
    expect(L.base).toBe("/home/me/.claude");
    expect(L.baseGlobalJson).toBe("/home/me/.claude.json");
  });

  test("a nested or invalid dir under the root is managed but names no profile", () => {
    const L = layout({ HOME: "/home/me", CLAUDE_CONFIG_DIR: "/home/me/.claudep/work/sub" }, "linux");
    expect(L.managed).toBe(true);
    expect(L.activeProfile).toBeUndefined();
  });

  test("a sibling of the root with the same prefix is not managed", () => {
    const L = layout({ HOME: "/home/me", CLAUDE_CONFIG_DIR: "/home/me/.claudep-other/work" }, "linux");
    expect(L.managed).toBe(false);
    expect(L.base).toBe("/home/me/.claudep-other/work");
  });

  test("honours CLAUDE_PROFILES_DIR with ~ expansion", () => {
    const L = layout({ HOME: "/home/me", CLAUDE_PROFILES_DIR: "~/profiles/" }, "linux");
    expect(L.profilesRoot).toBe("/home/me/profiles");
  });
});

describe("layout on win32", () => {
  test("defaults everything under USERPROFILE with backslashes", () => {
    const L = layout({ USERPROFILE: "C:\\Users\\me" }, "win32");
    expect(L).toEqual({
      platform: "win32",
      home: "C:\\Users\\me",
      callerConfigDir: undefined,
      managed: false,
      activeProfile: undefined,
      base: "C:\\Users\\me\\.claude",
      baseGlobalJson: "C:\\Users\\me\\.claude.json",
      profilesRoot: "C:\\Users\\me\\.claudep",
    });
  });

  test("recognises an active profile spelled with any case, slashes or trailing separator", () => {
    const L = layout({ USERPROFILE: "C:\\Users\\me", CLAUDE_CONFIG_DIR: "c:/users/me/.claudep/work/" }, "win32");
    expect(L.managed).toBe(true);
    expect(L.activeProfile).toBe("work");
    expect(L.base).toBe("C:\\Users\\me\\.claude");
  });

  test("recognises an active profile from a Git Bash shell", () => {
    const env = {
      HOME: "/c/Users/me",
      USERPROFILE: "C:\\Users\\me",
      MSYSTEM: "MINGW64",
      CLAUDE_CONFIG_DIR: "/c/Users/me/.claudep/work",
    };
    const L = layout(env, "win32");
    expect(L.home).toBe("C:\\Users\\me");
    expect(L.managed).toBe(true);
    expect(L.activeProfile).toBe("work");
    expect(L.profilesRoot).toBe("C:\\Users\\me\\.claudep");
  });

  test("a custom dir outside the root is the base and gets .claude.json inside it", () => {
    const L = layout({ USERPROFILE: "C:\\Users\\me", CLAUDE_CONFIG_DIR: "D:\\cfg\\" }, "win32");
    expect(L.base).toBe("D:\\cfg");
    expect(L.baseGlobalJson).toBe("D:\\cfg\\.claude.json");
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

  test("replaces every spelling of CLAUDE_CONFIG_DIR on win32", () => {
    const env = { claude_config_dir: "C:\\old", PATH: "C:\\bin" };
    expect(envFor("C:\\p", env, "win32")).toEqual({ PATH: "C:\\bin", CLAUDE_CONFIG_DIR: "C:\\p" });
    expect(envFor("/p", env, "linux")).toEqual({ ...env, CLAUDE_CONFIG_DIR: "/p" });
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
      "linux",
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
    const [, line] = formatTable([{ name: "x", dir: "/opt/cfg", status: { loggedIn: false } }], "/home/me", "linux");
    expect(line).toContain("/opt/cfg");
    expect(line).not.toContain("~");
  });

  test("shortens a Windows home regardless of case", () => {
    const [, line] = formatTable(
      [{ name: "work", dir: "c:\\users\\me\\.claudep\\work", status: { loggedIn: false } }],
      "C:\\Users\\me",
      "win32",
    );
    expect(line).toContain("~\\.claudep\\work");
  });
});

describe("baseEnv", () => {
  test("strips a hook or manual claudep pin so the base really is the base", () => {
    const env = { CLAUDE_CONFIG_DIR: "/home/me/.claudep/work", CLAUDEP_AUTO: "/home/me/.claudep/work", PATH: "/bin" };
    const L = layout({ HOME: "/home/me", ...env }, "linux");
    expect(baseEnv(L, env)).toEqual({ PATH: "/bin" });
  });

  test("keeps a custom CLAUDE_CONFIG_DIR that lives outside the profiles root", () => {
    const env = { CLAUDE_CONFIG_DIR: "/opt/cfg" };
    expect(baseEnv(layout({ HOME: "/home/me", ...env }, "linux"), env)).toEqual(env);
  });

  test("strips every spelling of the pin variables on win32", () => {
    const env = {
      CLAUDE_CONFIG_DIR: "C:\\Users\\me\\.claudep\\work",
      claudep_auto: "C:\\Users\\me\\.claudep\\work",
      PATH: "C:\\bin",
    };
    const L = layout({ USERPROFILE: "C:\\Users\\me", ...env }, "win32");
    expect(baseEnv(L, env)).toEqual({ PATH: "C:\\bin" });
  });
});

describe("currentProfile", () => {
  test("base when nothing is set", () => {
    const L = layout({ HOME: "/home/me" }, "linux");
    expect(currentProfile(L, {})).toEqual({ kind: "base", name: undefined, dir: "/home/me/.claude", setBy: "none" });
  });

  test("profile set by the hook when CLAUDEP_AUTO matches", () => {
    const env = { CLAUDE_CONFIG_DIR: "/home/me/.claudep/work", CLAUDEP_AUTO: "/home/me/.claudep/work/" };
    const cur = currentProfile(layout({ HOME: "/home/me", ...env }, "linux"), env);
    expect(cur).toEqual({ kind: "profile", name: "work", dir: "/home/me/.claudep/work", setBy: "hook" });
  });

  test("manual pin when CLAUDEP_AUTO is absent or points elsewhere", () => {
    const a = { CLAUDE_CONFIG_DIR: "/home/me/.claudep/work" };
    expect(currentProfile(layout({ HOME: "/home/me", ...a }, "linux"), a).setBy).toBe("manual");
    const b = { CLAUDE_CONFIG_DIR: "/home/me/.claudep/work", CLAUDEP_AUTO: "/home/me/.claudep/other" };
    expect(currentProfile(layout({ HOME: "/home/me", ...b }, "linux"), b).setBy).toBe("manual");
  });

  test("custom for a dir outside the profiles root", () => {
    const env = { CLAUDE_CONFIG_DIR: "/opt/cfg" };
    expect(currentProfile(layout({ HOME: "/home/me", ...env }, "linux"), env)).toEqual({
      kind: "custom",
      name: undefined,
      dir: "/opt/cfg",
      setBy: "manual",
    });
  });

  test("hook pin on win32 matches across case and separators", () => {
    const env = { CLAUDE_CONFIG_DIR: "C:\\Users\\me\\.claudep\\work", CLAUDEP_AUTO: "c:/users/me/.claudep/work/" };
    const cur = currentProfile(layout({ USERPROFILE: "C:\\Users\\me", ...env }, "win32"), env);
    expect(cur).toEqual({ kind: "profile", name: "work", dir: "C:\\Users\\me\\.claudep\\work", setBy: "hook" });
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

  test("reads a pin file with CRLF line endings", () => {
    using h = fakeHome();
    const repo = join(h.home, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, PIN_FILE), "# from Windows\r\nwork\r\n");
    expect(resolvePin(repo)?.name).toBe("work");
  });

  test("skips a directory named like the pin file, such as ~/.claudep itself", () => {
    using h = fakeHome();
    mkdirSync(join(h.home, PIN_FILE, "work"), { recursive: true });
    const tree = join(h.home, "somewhere");
    mkdirSync(tree);
    expect(resolvePin(tree)).toBeUndefined();
  });

  test("returns undefined at the filesystem root", () => {
    expect(resolvePin(join(resolve("/"), `claudep-does-not-exist-${Date.now()}`))).toBeUndefined();
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

  test("strips a carriage return from the pin line", () => {
    expect(shellInit("bash", "/home/me/.claudep")).toContain(`_claudep_line="\${_claudep_line%$'\\r'}"`);
  });

  test("embeds the native separator so Git Bash exports a path claude.exe reads", () => {
    expect(shellInit("bash", "/home/me/.claudep", "linux")).toContain("_claudep_sep='/'");
    const win = shellInit("bash", "C:\\Users\\me\\.claudep", "win32");
    expect(win).toContain("_claudep_root='C:\\Users\\me\\.claudep'");
    expect(win).toContain("_claudep_sep='\\'");
    expect(win).toContain('export CLAUDE_CONFIG_DIR="$_claudep_root$_claudep_sep$_claudep_name"');
  });

  test("single-quotes a root with an apostrophe safely", () => {
    expect(shellInit("bash", "/home/o'brien/.claudep")).toContain(`_claudep_root='/home/o'\\''brien/.claudep'`);
  });
});
