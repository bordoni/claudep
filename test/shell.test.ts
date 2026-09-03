/**
 * Drives the emitted shell hook in a real bash (and zsh when present) against
 * a fake home, and checks it agrees with resolvePin() and the pin rules.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCRIPT } from "./lib/cli.ts";
import { fakeHome } from "./lib/home.ts";

type ShellRun = { exitCode: number; stdout: string; stderr: string };

async function runShell(
  shell: "bash" | "zsh",
  home: string,
  script: string,
  env: Record<string, string> = {},
): Promise<ShellRun> {
  // Load the hook, then run the caller's script. `tick` re-runs the hook the way a
  // prompt or chpwd would; `show` prints the two variables the hook manages.
  const prelude = [
    `eval "$(${JSON.stringify(process.execPath)} ${JSON.stringify(SCRIPT)} shell-init ${shell})"`,
    "tick() { _claudep_auto; }",
    `show() { printf "%s|%s\\n" "\${CLAUDE_CONFIG_DIR:-<unset>}" "\${CLAUDEP_AUTO:-<unset>}"; }`,
  ].join("\n");
  const cleanEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    NO_COLOR: "1",
    ...env,
  };
  const proc = Bun.spawn([shell, "-c", `${prelude}\n${script}`], {
    env: cleanEnv,
    cwd: home,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function pinnedTree(home: string, profilesRoot: string): { repo: string; nested: string; work: string } {
  const repo = join(home, "repo");
  const nested = join(repo, "src", "deep");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(repo, ".claudep"), "work\n");
  const work = join(profilesRoot, "work");
  mkdirSync(work, { recursive: true });
  return { repo, nested, work };
}

const shells: ("bash" | "zsh")[] = ["bash", ...(Bun.which("zsh") ? (["zsh"] as const) : [])];

describe.each(shells)("%s hook", (shell) => {
  test("sets the profile on entering a pinned tree and clears it on leaving", async () => {
    using h = fakeHome();
    const { nested, work } = pinnedTree(h.home, h.profilesRoot);
    const r = await runShell(shell, h.home, `show; cd ${JSON.stringify(nested)}; tick; show; cd /; tick; show`);
    expect(r.stderr).toBe("");
    expect(r.stdout.trim().split("\n")).toEqual(["<unset>|<unset>", `${work}|${work}`, "<unset>|<unset>"]);
  });

  test("never touches a manual pin", async () => {
    using h = fakeHome();
    const { nested } = pinnedTree(h.home, h.profilesRoot);
    const manual = join(h.profilesRoot, "manual");
    mkdirSync(manual);
    const r = await runShell(shell, h.home, `cd ${JSON.stringify(nested)}; tick; show; cd /; tick; show`, {
      CLAUDE_CONFIG_DIR: manual,
    });
    expect(r.stdout.trim().split("\n")).toEqual([`${manual}|<unset>`, `${manual}|<unset>`]);
  });

  test("takes over again after the manual pin is cleared", async () => {
    using h = fakeHome();
    const { nested, work } = pinnedTree(h.home, h.profilesRoot);
    const manual = join(h.profilesRoot, "manual");
    mkdirSync(manual);
    const r = await runShell(
      shell,
      h.home,
      `cd ${JSON.stringify(nested)}; tick; show; unset CLAUDE_CONFIG_DIR; cd ${JSON.stringify(h.home)}; tick; cd ${JSON.stringify(nested)}; tick; show`,
      { CLAUDE_CONFIG_DIR: manual },
    );
    expect(r.stdout.trim().split("\n")).toEqual([`${manual}|<unset>`, `${work}|${work}`]);
  });

  test("an empty pin in a subtree cancels the parent pin", async () => {
    using h = fakeHome();
    const { repo, nested, work } = pinnedTree(h.home, h.profilesRoot);
    writeFileSync(join(repo, "src", ".claudep"), "# no pin below here\n");
    const r = await runShell(
      shell,
      h.home,
      `cd ${JSON.stringify(repo)}; tick; show; cd ${JSON.stringify(nested)}; tick; show`,
    );
    expect(r.stdout.trim().split("\n")).toEqual([`${work}|${work}`, "<unset>|<unset>"]);
  });

  test("warns once per directory change when the pinned profile does not exist, and clears any auto pin", async () => {
    using h = fakeHome();
    const { repo, nested, work } = pinnedTree(h.home, h.profilesRoot);
    const other = join(h.home, "other");
    mkdirSync(other);
    writeFileSync(join(other, ".claudep"), "ghost\n");
    const r = await runShell(
      shell,
      h.home,
      `cd ${JSON.stringify(nested)}; tick; cd ${JSON.stringify(other)}; tick; tick; show`,
    );
    expect(r.stdout.trim()).toBe("<unset>|<unset>");
    expect(r.stderr.trim().split("\n")).toEqual([
      `claudep: ${other}/.claudep names profile "ghost", which does not exist. Run: claudep init ghost`,
    ]);
    expect(work).toContain(repo.split("/").slice(0, -1).join("/"));
  });

  test("agrees with `claudep resolve` on the nearest pin", async () => {
    using h = fakeHome();
    const { nested, work } = pinnedTree(h.home, h.profilesRoot);
    const r = await runShell(
      shell,
      h.home,
      `cd ${JSON.stringify(nested)}; tick; printf "%s\\n" "$CLAUDE_CONFIG_DIR"; ${JSON.stringify(process.execPath)} ${JSON.stringify(SCRIPT)} resolve`,
    );
    expect(r.stdout.trim().split("\n")).toEqual([work, "work"]);
  });
});
