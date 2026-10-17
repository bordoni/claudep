/**
 * Claude Code updates and claudep (bordoni/claudep#7): how the install is
 * classified, every claude on PATH, whether a config dir runs the
 * auto-updater, its last update record, and `run` waiting while an update
 * has claude removed. The wait runs on an injected clock.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  autoUpdateState,
  type ClaudeLaunch,
  findAllClaude,
  installKind,
  lastUpdate,
  UPDATE_LOCK_STALE_MS,
  type WaitDeps,
  waitForClaude,
} from "../claudep.ts";
import { fakeHome } from "./lib/home.ts";

describe("installKind", () => {
  test.each([
    ["/home/me/.local/bin/claude", "/home/me/.local/share/claude/versions/2.1.286", "linux", "native"],
    ["/usr/local/bin/claude", "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js", "linux", "npm"],
    [
      "/opt/homebrew/bin/claude",
      "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code-darwin-arm64/claude",
      "darwin",
      "npm",
    ],
    [
      "/home/me/.bun/bin/claude",
      "/home/me/.bun/install/global/node_modules/@anthropic-ai/claude-code/cli.js",
      "linux",
      "bun",
    ],
    ["/opt/homebrew/bin/claude", "/opt/homebrew/Caskroom/claude-code/2.1.286/claude", "darwin", "homebrew"],
    [
      "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd",
      "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd",
      "win32",
      "npm",
    ],
    ["C:\\Users\\me\\.local\\bin\\claude.exe", "C:\\Users\\me\\.local\\bin\\claude.exe", "win32", "native"],
    ["/usr/bin/claude", "/usr/bin/claude", "linux", "unknown"],
  ] as const)("%s → %s is %s on %s", (bin, real, platform, kind) => {
    expect(installKind(bin, real, platform)).toBe(kind);
  });
});

describe("findAllClaude", () => {
  test("lists one claude per PATH directory, in order, without repeats", () => {
    const present = new Set(["/a/claude", "/c/claude"]);
    const deps = {
      platform: "linux" as const,
      pathVar: "/a:/b:/c:/a",
      exists: (p: string) => present.has(p),
      which: () => null,
    };
    expect(findAllClaude(deps)).toEqual(["/a/claude", "/c/claude"]);
  });

  test("takes claude.exe or an npm shim on Windows", () => {
    const present = new Set(["C:\\a\\claude.exe", "C:\\b\\claude.cmd", "C:\\c\\claude.ps1"]);
    const deps = {
      platform: "win32" as const,
      pathVar: "C:\\a;C:\\b;C:\\c",
      exists: (p: string) => present.has(p),
      which: () => null,
    };
    expect(findAllClaude(deps)).toEqual(["C:\\a\\claude.exe", "C:\\b\\claude.cmd"]);
  });
});

describe("autoUpdateState", () => {
  test("is on with nothing set", () => {
    expect(autoUpdateState([["this shell", {}]], {})).toEqual({ enabled: true });
  });

  test("names the first variable that switches it off, and where it came from", () => {
    const sources: [string, Record<string, string>][] = [
      ["settings.json env", { DISABLE_AUTOUPDATER: "1" }],
      ["this shell", { DISABLE_UPDATES: "true" }],
    ];
    expect(autoUpdateState(sources, undefined)).toEqual({ enabled: false, by: "DISABLE_UPDATES in this shell" });
    expect(autoUpdateState([sources[0] as [string, Record<string, string>]], undefined)).toEqual({
      enabled: false,
      by: "DISABLE_AUTOUPDATER in settings.json env",
    });
    expect(autoUpdateState([["claudep.env", { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "yes" }]], undefined).by).toBe(
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC in claudep.env",
    );
  });

  test("ignores a variable that is not truthy", () => {
    expect(autoUpdateState([["this shell", { DISABLE_AUTOUPDATER: "0" }]], undefined).enabled).toBe(true);
  });

  test("honours autoUpdates: false unless a native install protects itself", () => {
    expect(autoUpdateState([], { autoUpdates: false })).toEqual({ enabled: false, by: "autoUpdates in .claude.json" });
    expect(
      autoUpdateState([], { autoUpdates: false, installMethod: "native", autoUpdatesProtectedForNative: true }).enabled,
    ).toBe(true);
    expect(
      autoUpdateState([], { autoUpdates: false, installMethod: "npm", autoUpdatesProtectedForNative: true }).enabled,
    ).toBe(false);
  });
});

describe("lastUpdate", () => {
  test("reads .last-update-result.json, or nothing", async () => {
    using h = fakeHome();
    const dir = join(h.profilesRoot, "work");
    mkdirSync(dir, { recursive: true });
    expect(await lastUpdate(dir)).toBeUndefined();
    writeFileSync(
      join(dir, ".last-update-result.json"),
      JSON.stringify({
        timestamp: "2026-10-06T12:45:00.000Z",
        path: "npm-global",
        outcome: "success",
        status: "success",
        version_from: "2.1.289",
        version_to: "2.1.291",
        error_code: null,
      }),
    );
    expect(await lastUpdate(dir)).toEqual({
      from: "2.1.289",
      to: "2.1.291",
      outcome: "success",
      at: "2026-10-06T12:45:00.000Z",
      path: "npm-global",
    });
  });
});

/** A clock that only moves when the wait sleeps. */
function clock(opts: { foundAt?: number; lockAge?: (now: number) => number | undefined }) {
  let now = 0;
  const notes: string[] = [];
  const launch: ClaudeLaunch = { bin: "/usr/bin/claude", kind: "exe" };
  const deps: WaitDeps = {
    find: () => (opts.foundAt !== undefined && now >= opts.foundAt ? launch : undefined),
    lockAges: () => {
      const age = opts.lockAge?.(now);
      return age === undefined ? [] : [age];
    },
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    note: (msg) => notes.push(msg),
  };
  return { deps, notes, launch, elapsed: () => now };
}

describe("waitForClaude", () => {
  test("returns at once when claude is there", async () => {
    const t = clock({ foundAt: 0 });
    expect(await waitForClaude(t.deps)).toEqual({ launch: t.launch, updating: false });
    expect(t.elapsed()).toBe(0);
    expect(t.notes).toEqual([]);
  });

  test("gives up after the grace period when no update holds a lock", async () => {
    const t = clock({});
    expect(await waitForClaude(t.deps)).toEqual({ updating: false });
    expect(t.elapsed()).toBe(5_000);
    expect(t.notes).toEqual([]);
  });

  test("covers a reinstall that ends within the grace period", async () => {
    const t = clock({ foundAt: 2_000 });
    expect((await waitForClaude(t.deps)).launch).toEqual(t.launch);
  });

  test("waits past the grace period while a fresh lock exists, and says so once", async () => {
    const t = clock({ foundAt: 40_000, lockAge: (now) => (now < 40_000 ? 1_000 + now : undefined) });
    expect(await waitForClaude(t.deps)).toEqual({ launch: t.launch, updating: false });
    expect(t.elapsed()).toBe(40_000);
    expect(t.notes).toEqual(["claudep: waiting for a Claude Code update to finish"]);
  });

  test("stops at five minutes even with a lock, and a stale lock counts for nothing", async () => {
    const fresh = clock({ lockAge: () => 0 });
    expect(await waitForClaude(fresh.deps)).toEqual({ updating: true });
    expect(fresh.elapsed()).toBe(UPDATE_LOCK_STALE_MS);
    const stale = clock({ lockAge: () => UPDATE_LOCK_STALE_MS + 1 });
    expect(await waitForClaude(stale.deps)).toEqual({ updating: false });
    expect(stale.elapsed()).toBe(5_000);
  });
});
