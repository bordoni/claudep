import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type LinkDeps,
  link,
  linkState,
  readJson,
  SEED_KEYS,
  type SharedItem,
  seedGlobalJson,
  sharedItems,
} from "../claudep.ts";
import {
  BASE_DIRS,
  BASE_FILES,
  fakeHome,
  MCP_SERVERS,
  NEVER_SEEDED,
  PRIVATE_DIRS,
  PRIVATE_FILES,
  SEEDABLE,
} from "./lib/home.ts";

describe("sharedItems", () => {
  test("returns exactly the allowlist entries that exist, plus every top-level *.md", () => {
    using h = fakeHome();
    const names = sharedItems(h.base).map((i) => i.name);
    expect(names.sort()).toEqual([...BASE_FILES, ...BASE_DIRS].sort());
    for (const p of [...PRIVATE_FILES, ...PRIVATE_DIRS]) expect(names).not.toContain(p);
  });

  test("skips allowlisted items that are missing from the base", () => {
    using h = fakeHome();
    const names = sharedItems(h.base).map((i) => i.name);
    expect(names).not.toContain("keybindings.json");
  });

  test("tags files and dirs", () => {
    using h = fakeHome();
    const byName = new Map(sharedItems(h.base).map((i) => [i.name, i.kind]));
    expect(byName.get("CLAUDE.md")).toBe("file");
    expect(byName.get("skills")).toBe("dir");
  });

  test("is empty when the base does not exist", () => {
    using h = fakeHome({ withoutBase: true });
    expect(sharedItems(h.base)).toEqual([]);
  });
});

const CLAUDE_MD: SharedItem = { name: "CLAUDE.md", kind: "file" };
const SETTINGS: SharedItem = { name: "settings.json", kind: "file" };
const SKILLS: SharedItem = { name: "skills", kind: "dir" };

/** Real file-system deps with a recorder and an optional EPERM injection. */
function recordingDeps(opts: { deny?: boolean; platform?: NodeJS.Platform } = {}): LinkDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    platform: opts.platform ?? process.platform,
    calls,
    symlink: (target, dest, type) => {
      calls.push(`${type}:${dest}`);
      if (opts.deny) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      symlinkSync(target, dest, type);
    },
    readlink: (p) => readlinkSync(p),
  };
}

describe("link", () => {
  test("creates the symlink, then reports ok on rerun", () => {
    using h = fakeHome();
    const dir = join(h.profilesRoot, "p");
    mkdirSync(dir, { recursive: true });
    expect(link(h.base, dir, CLAUDE_MD, false)).toBe("linked");
    expect(readlinkSync(join(dir, "CLAUDE.md"))).toBe(join(h.base, "CLAUDE.md"));
    expect(link(h.base, dir, CLAUDE_MD, false)).toBe("ok");
  });

  test("passes the item kind as the symlink type on every platform", () => {
    using h = fakeHome();
    const dir = join(h.profilesRoot, "p");
    mkdirSync(dir, { recursive: true });
    const deps = recordingDeps();
    expect(link(h.base, dir, SKILLS, false, deps)).toBe("linked");
    expect(link(h.base, dir, CLAUDE_MD, false, deps)).toBe("linked");
    expect(deps.calls).toEqual([`dir:${join(dir, "skills")}`, `file:${join(dir, "CLAUDE.md")}`]);
    expect(existsSync(join(dir, "skills", ".."))).toBe(true);
  });

  test("never overwrites a real file, even with --force", () => {
    using h = fakeHome();
    const dir = join(h.profilesRoot, "p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), "{}");
    expect(link(h.base, dir, SETTINGS, false)).toBe("conflict");
    expect(link(h.base, dir, SETTINGS, true)).toBe("conflict");
    expect(lstatSync(join(dir, "settings.json")).isSymbolicLink()).toBe(false);
  });

  test("reports a symlink pointing elsewhere and relinks it only with force", () => {
    using h = fakeHome();
    const dir = join(h.profilesRoot, "p");
    mkdirSync(dir, { recursive: true });
    const elsewhere = join(h.home, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(dir, "skills"), "dir");
    expect(link(h.base, dir, SKILLS, false)).toBe("wrong-target");
    expect(readlinkSync(join(dir, "skills"))).toBe(elsewhere);
    expect(link(h.base, dir, SKILLS, true)).toBe("linked");
    expect(readlinkSync(join(dir, "skills"))).toBe(join(h.base, "skills"));
  });

  test("reports denied when the OS answers EPERM, and leaves nothing behind", () => {
    using h = fakeHome();
    const dir = join(h.profilesRoot, "p");
    mkdirSync(dir, { recursive: true });
    expect(link(h.base, dir, SKILLS, false, recordingDeps({ deny: true }))).toBe("denied");
    expect(existsSync(join(dir, "skills"))).toBe(false);
    expect(lstatSync(dir).isDirectory()).toBe(true);
  });

  test("propagates any other symlink error", () => {
    using h = fakeHome();
    const dir = join(h.profilesRoot, "p");
    mkdirSync(dir, { recursive: true });
    const deps: LinkDeps = {
      platform: process.platform,
      symlink: () => {
        throw Object.assign(new Error("boom"), { code: "EIO" });
      },
      readlink: readlinkSync,
    };
    expect(() => link(h.base, dir, SKILLS, false, deps)).toThrow("boom");
  });

  test("accepts a readlink answer with a \\\\?\\ prefix or other case on win32", () => {
    using h = fakeHome();
    const dir = join(h.profilesRoot, "p");
    mkdirSync(dir, { recursive: true });
    link(h.base, dir, SKILLS, false);
    const deps: LinkDeps = {
      platform: "win32",
      symlink: symlinkSync,
      readlink: () => `\\\\?\\${join(h.base, "skills").toUpperCase()}`,
    };
    expect(link(h.base, dir, SKILLS, false, deps)).toBe("ok");
    expect(link(h.base, dir, SKILLS, false, { ...deps, platform: "linux" })).toBe("wrong-target");
  });
});

describe("linkState", () => {
  test("reports every state doctor prints", () => {
    using h = fakeHome();
    const dir = join(h.profilesRoot, "p");
    mkdirSync(dir, { recursive: true });
    expect(linkState(h.base, dir, CLAUDE_MD)).toBe("missing");
    link(h.base, dir, CLAUDE_MD, false);
    expect(linkState(h.base, dir, CLAUDE_MD)).toBe("ok");

    writeFileSync(join(dir, "settings.json"), "{}");
    expect(linkState(h.base, dir, SETTINGS)).toBe("shadowed");

    symlinkSync(join(h.home, "elsewhere"), join(dir, "skills"), "dir");
    expect(linkState(h.base, dir, SKILLS)).toBe("wrong-target");

    const gone: SharedItem = { name: "gone.md", kind: "file" };
    symlinkSync(join(h.base, "gone.md"), join(dir, "gone.md"), "file");
    expect(linkState(h.base, dir, gone)).toBe("broken");
  });

  test("folds readlink answers on win32 like link() does", () => {
    using h = fakeHome();
    const dir = join(h.profilesRoot, "p");
    mkdirSync(dir, { recursive: true });
    link(h.base, dir, SKILLS, false);
    const readlink = () => `\\\\?\\${join(h.base, "skills").toUpperCase()}`;
    expect(linkState(h.base, dir, SKILLS, { platform: "win32", readlink })).toBe("ok");
    expect(linkState(h.base, dir, SKILLS, { platform: "linux", readlink })).toBe("wrong-target");
  });
});

describe("seedGlobalJson", () => {
  test("copies only SEED_KEYS and never account identity", async () => {
    using h = fakeHome();
    const dir = join(h.profilesRoot, "p");
    mkdirSync(dir, { recursive: true });
    expect(await seedGlobalJson(h.globalJson, dir, false)).toBe("seeded");
    const seeded = await readJson(join(dir, ".claude.json"));
    expect(seeded).toEqual(SEEDABLE);
    for (const k of Object.keys(NEVER_SEEDED)) expect(seeded).not.toHaveProperty(k);
    expect(seeded).not.toHaveProperty("mcpServers");
    for (const k of Object.keys(seeded ?? {})) expect(SEED_KEYS as readonly string[]).toContain(k);
  });

  test("copies mcpServers only when asked", async () => {
    using h = fakeHome();
    const dir = join(h.profilesRoot, "p");
    mkdirSync(dir, { recursive: true });
    await seedGlobalJson(h.globalJson, dir, true);
    expect((await readJson(join(dir, ".claude.json")))?.mcpServers).toEqual(MCP_SERVERS);
  });

  test("does not touch an existing .claude.json", async () => {
    using h = fakeHome();
    const dir = join(h.profilesRoot, "p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".claude.json"), '{"keep":1}');
    expect(await seedGlobalJson(h.globalJson, dir, true)).toBe("exists");
    expect(await readJson(join(dir, ".claude.json"))).toEqual({ keep: 1 });
  });

  test("reports no-base when the base file is missing or invalid", async () => {
    using h = fakeHome({ withoutGlobalJson: true });
    const dir = join(h.profilesRoot, "p");
    mkdirSync(dir, { recursive: true });
    expect(await seedGlobalJson(h.globalJson, dir, false)).toBe("no-base");
    expect(existsSync(join(dir, ".claude.json"))).toBe(false);
    writeFileSync(h.globalJson, "[1,2]");
    expect(await seedGlobalJson(h.globalJson, dir, false)).toBe("no-base");
  });
});
