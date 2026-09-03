/**
 * A throwaway $HOME with a realistic ~/.claude inside it.
 *
 * `using home = fakeHome()` builds the tree and removes it when the block ends.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BASE_FILES = ["CLAUDE.md", "RTK.md", "settings.json", "statusline-command.sh"] as const;
export const BASE_DIRS = ["hooks", "skills", "commands", "agents", "plugins", "plans", "projects"] as const;
/** Present in the base, must never be linked into a profile. */
export const PRIVATE_FILES = ["remote-settings.json", "history.jsonl", "policy-limits.json"] as const;
export const PRIVATE_DIRS = ["statsig", "todos", "shell-snapshots"] as const;

export const SEEDABLE = {
  hasCompletedOnboarding: true,
  lastOnboardingVersion: "1.0.67",
  theme: "dark",
  autoUpdates: false,
  installMethod: "native",
} as const;

export const NEVER_SEEDED = {
  oauthAccount: { emailAddress: "base@example.com", organizationName: "Base Org" },
  userID: "user-123",
  projects: { "/tmp/x": { allowedTools: [] } },
} as const;

export const MCP_SERVERS = { linear: { type: "http", url: "https://mcp.linear.app/mcp" } } as const;

export type FakeHome = {
  home: string;
  base: string;
  globalJson: string;
  profilesRoot: string;
  [Symbol.dispose](): void;
};

export type FakeHomeOptions = {
  /** Skip creating ~/.claude entirely. */
  withoutBase?: boolean;
  /** Skip writing ~/.claude.json. */
  withoutGlobalJson?: boolean;
  /** Mark the base as logged in for the fake `claude`. */
  loggedIn?: boolean;
};

export function fakeHome(opts: FakeHomeOptions = {}): FakeHome {
  const parent = process.env.CLAUDEP_TEST_ROOT ?? realpathSync.native(tmpdir());
  const home = mkdtempSync(join(parent, "home-"));
  const base = join(home, ".claude");
  const globalJson = join(home, ".claude.json");

  if (!opts.withoutBase) {
    mkdirSync(base, { recursive: true });
    for (const f of BASE_FILES) writeFileSync(join(base, f), `# ${f}\n`);
    for (const d of BASE_DIRS) mkdirSync(join(base, d));
    for (const f of PRIVATE_FILES) writeFileSync(join(base, f), "{}\n");
    for (const d of PRIVATE_DIRS) mkdirSync(join(base, d));
    if (opts.loggedIn) writeLogin(base, "base@example.com");
  }
  if (!opts.withoutGlobalJson) {
    writeFileSync(
      globalJson,
      `${JSON.stringify({ ...SEEDABLE, ...NEVER_SEEDED, mcpServers: MCP_SERVERS }, null, 2)}\n`,
    );
  }

  return {
    home,
    base,
    globalJson,
    profilesRoot: join(home, ".claudep"),
    [Symbol.dispose]() {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** What the fake `claude` reads to answer `auth status`. */
export function writeLogin(configDir: string, email: string): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, ".fake-login.json"),
    JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      email,
      orgName: `${email}'s Org`,
      subscriptionType: "max",
    }),
  );
}
