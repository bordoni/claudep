/**
 * Drives the emitted shell hook in a real bash (and zsh when present) against
 * a fake home, and checks it agrees with resolvePin() and the pin rules.
 * On Windows the bash is Git for Windows', which is what a Git Bash user runs.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCRIPT } from "./lib/cli.ts";
import { fakeHome } from "./lib/home.ts";
import { msys } from "./lib/paths.ts";

type ShellRun = { exitCode: number; stdout: string; stderr: string };

const WIN = process.platform === "win32";

/** Git for Windows' bash, never Bun.which("bash"): System32 has a WSL stub by that name. */
function gitBash(): string | undefined {
  for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], "C:\\Program Files"]) {
    if (!root) continue;
    const p = join(root, "Git", "bin", "bash.exe");
    if (existsSync(p)) return p;
  }
  return undefined;
}

const shells: { name: "bash" | "zsh"; exe: string }[] = WIN
  ? [gitBash()].filter((p): p is string => p !== undefined).map((exe) => ({ name: "bash" as const, exe }))
  : [{ name: "bash", exe: "bash" }, ...(Bun.which("zsh") ? [{ name: "zsh" as const, exe: "zsh" }] : [])];

async function runShell(
  shell: "bash" | "zsh",
  exe: string,
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
  if (WIN) {
    cleanEnv.USERPROFILE = home;
    for (const k of ["SystemRoot", "TEMP", "TMP", "PATHEXT", "COMSPEC"]) {
      const v = process.env[k];
      if (v !== undefined) cleanEnv[k] = v;
    }
  }
  const proc = Bun.spawn([exe, "-c", `${prelude}\n${script}`], {
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

describe.each(shells)("$name hook", ({ name: shell, exe }) => {
  const run = (home: string, script: string, env?: Record<string, string>) => runShell(shell, exe, home, script, env);

  test("sets the profile on entering a pinned tree and clears it on leaving", async () => {
    using h = fakeHome();
    const { nested, work } = pinnedTree(h.home, h.profilesRoot);
    const r = await run(h.home, `show; cd ${JSON.stringify(nested)}; tick; show; cd /; tick; show`);
    expect(r.stderr).toBe("");
    expect(r.stdout.trim().split("\n")).toEqual(["<unset>|<unset>", `${work}|${work}`, "<unset>|<unset>"]);
  });

  test("never touches a manual pin", async () => {
    using h = fakeHome();
    const { nested } = pinnedTree(h.home, h.profilesRoot);
    const manual = join(h.profilesRoot, "manual");
    mkdirSync(manual);
    const r = await run(h.home, `cd ${JSON.stringify(nested)}; tick; show; cd /; tick; show`, {
      CLAUDE_CONFIG_DIR: manual,
    });
    expect(r.stdout.trim().split("\n")).toEqual([`${manual}|<unset>`, `${manual}|<unset>`]);
  });

  test("takes over again after the manual pin is cleared", async () => {
    using h = fakeHome();
    const { nested, work } = pinnedTree(h.home, h.profilesRoot);
    const manual = join(h.profilesRoot, "manual");
    mkdirSync(manual);
    const r = await run(
      h.home,
      `cd ${JSON.stringify(nested)}; tick; show; unset CLAUDE_CONFIG_DIR; cd ${JSON.stringify(h.home)}; tick; cd ${JSON.stringify(nested)}; tick; show`,
      { CLAUDE_CONFIG_DIR: manual },
    );
    expect(r.stdout.trim().split("\n")).toEqual([`${manual}|<unset>`, `${work}|${work}`]);
  });

  test("reads a pin file with CRLF line endings", async () => {
    using h = fakeHome();
    const { repo, nested, work } = pinnedTree(h.home, h.profilesRoot);
    writeFileSync(join(repo, ".claudep"), "# from Windows\r\nwork\r\n");
    const r = await run(h.home, `cd ${JSON.stringify(nested)}; tick; show`);
    expect(r.stderr).toBe("");
    expect(r.stdout.trim().split("\n")).toEqual([`${work}|${work}`]);
  });

  test("an empty pin in a subtree cancels the parent pin", async () => {
    using h = fakeHome();
    const { repo, nested, work } = pinnedTree(h.home, h.profilesRoot);
    writeFileSync(join(repo, "src", ".claudep"), "# no pin below here\n");
    const r = await run(h.home, `cd ${JSON.stringify(repo)}; tick; show; cd ${JSON.stringify(nested)}; tick; show`);
    expect(r.stdout.trim().split("\n")).toEqual([`${work}|${work}`, "<unset>|<unset>"]);
  });

  test("warns once per directory change when the pinned profile does not exist, and clears any auto pin", async () => {
    using h = fakeHome();
    const { nested } = pinnedTree(h.home, h.profilesRoot);
    const other = join(h.home, "other");
    mkdirSync(other);
    writeFileSync(join(other, ".claudep"), "ghost\n");
    const r = await run(h.home, `cd ${JSON.stringify(nested)}; tick; cd ${JSON.stringify(other)}; tick; tick; show`);
    expect(r.stdout.trim()).toBe("<unset>|<unset>");
    // The hook reports where it found the pin in the shell's own spelling of $PWD.
    expect(r.stderr.trim().split("\n")).toEqual([
      `claudep: ${msys(other)}/.claudep names profile "ghost", which does not exist. Run: claudep init ghost`,
    ]);
  });

  test("agrees with `claudep resolve` on the nearest pin", async () => {
    using h = fakeHome();
    const { nested, work } = pinnedTree(h.home, h.profilesRoot);
    const r = await run(
      h.home,
      `cd ${JSON.stringify(nested)}; tick; printf "%s\\n" "$CLAUDE_CONFIG_DIR"; ${JSON.stringify(process.execPath)} ${JSON.stringify(SCRIPT)} resolve`,
    );
    expect(r.stdout.trim().split("\n")).toEqual([work, "work"]);
  });
});

test.if(shells.length === 0)("no shell to drive the hook with on this machine", () => {
  // Windows without Git for Windows. The unit tests still cover the hook text.
  expect(WIN).toBe(true);
});
