import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { link, readJson, SEED_KEYS, seedGlobalJson, sharedItems } from "../claudep.ts";
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

describe("link", () => {
  test("creates the symlink, then reports ok on rerun", () => {
    using h = fakeHome();
    const dir = join(h.profilesRoot, "p");
    mkdirSync(dir, { recursive: true });
    expect(link(h.base, dir, "CLAUDE.md", false)).toBe("linked");
    expect(readlinkSync(join(dir, "CLAUDE.md"))).toBe(join(h.base, "CLAUDE.md"));
    expect(link(h.base, dir, "CLAUDE.md", false)).toBe("ok");
  });

  test("never overwrites a real file, even with --force", () => {
    using h = fakeHome();
    const dir = join(h.profilesRoot, "p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), "{}");
    expect(link(h.base, dir, "settings.json", false)).toBe("conflict");
    expect(link(h.base, dir, "settings.json", true)).toBe("conflict");
    expect(lstatSync(join(dir, "settings.json")).isSymbolicLink()).toBe(false);
  });

  test("reports a symlink pointing elsewhere and relinks it only with force", () => {
    using h = fakeHome();
    const dir = join(h.profilesRoot, "p");
    mkdirSync(dir, { recursive: true });
    symlinkSync("/somewhere/else", join(dir, "skills"));
    expect(link(h.base, dir, "skills", false)).toBe("wrong-target");
    expect(readlinkSync(join(dir, "skills"))).toBe("/somewhere/else");
    expect(link(h.base, dir, "skills", true)).toBe("linked");
    expect(readlinkSync(join(dir, "skills"))).toBe(join(h.base, "skills"));
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
