/**
 * Drives the emitted hook in real shells against a fake home and checks it
 * agrees with resolvePin() and the pin rules. Dialects: bash and zsh where
 * present (Git for Windows' bash on Windows), fish where present (CI installs
 * it on macOS and Linux), pwsh wherever it is installed (every GitHub runner
 * image has it), and Windows PowerShell 5.1 on Windows.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCRIPT } from "./lib/cli.ts";
import { fakeHome } from "./lib/home.ts";
import { msys } from "./lib/paths.ts";

type ShellRun = { exitCode: number; stdout: string; stderr: string };

const WIN = process.platform === "win32";
const BUN = process.execPath;

type Dialect = {
  name: string;
  exe: string;
  /** Arguments that make the shell run `script`. */
  args: (script: string) => string[];
  /** Loads the hook and defines `tick` (re-run the hook) and `show` (print the two managed variables). */
  prelude: string;
  cd: (dir: string) => string;
  unset: (name: string) => string;
  echoVar: (name: string) => string;
  /** Runs `claudep resolve` from the shell. */
  resolve: string;
  /** How the hook spells the directory it found a pin in. */
  foundDir: (dir: string) => string;
};

function sh(name: "bash" | "zsh", exe: string): Dialect {
  const q = (p: string) => JSON.stringify(p);
  return {
    name,
    exe,
    args: (script) => ["-c", script],
    prelude: [
      `eval "$(${q(BUN)} ${q(SCRIPT)} shell-init ${name})"`,
      "tick() { _claudep_auto; }",
      `show() { printf "%s|%s\\n" "\${CLAUDE_CONFIG_DIR:-<unset>}" "\${CLAUDEP_AUTO:-<unset>}"; }`,
    ].join("\n"),
    cd: (dir) => `cd ${q(dir)}`,
    unset: (v) => `unset ${v}`,
    echoVar: (v) => `printf "%s\\n" "$${v}"`,
    resolve: `${q(BUN)} ${q(SCRIPT)} resolve`,
    // Git Bash reports $PWD in its own /c/ spelling.
    foundDir: (dir) => `${msys(dir)}/.claudep`,
  };
}

function fish(exe: string): Dialect {
  // fish single quotes: only \ and ' are special.
  const q = (p: string) => `'${p.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  return {
    name: "fish",
    exe,
    args: (script) => ["-c", script],
    prelude: [
      `${q(BUN)} ${q(SCRIPT)} shell-init fish | source`,
      // --on-variable PWD already ran the hook on cd; tick re-runs it and the dedupe makes that a no-op.
      "function tick; _claudep_auto; end",
      `function show; set -l a $CLAUDE_CONFIG_DIR; set -l b $CLAUDEP_AUTO; test -n "$a"; or set a '<unset>'; test -n "$b"; or set b '<unset>'; echo "$a|$b"; end`,
    ].join("\n"),
    cd: (dir) => `cd ${q(dir)}`,
    unset: (v) => `set -e ${v}`,
    echoVar: (v) => `echo $${v}`,
    resolve: `${q(BUN)} ${q(SCRIPT)} resolve`,
    foundDir: (dir) => `${dir}/.claudep`,
  };
}

function powershell(name: string, exe: string): Dialect {
  const q = (p: string) => `'${p.replace(/'/g, "''")}'`;
  return {
    name,
    exe,
    args: (script) => ["-NoProfile", "-NonInteractive", "-Command", script],
    prelude: [
      `& ${q(BUN)} ${q(SCRIPT)} shell-init powershell | Out-String | Invoke-Expression`,
      "function tick { _claudep_auto }",
      "function show { $a = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { '<unset>' }; $b = if ($env:CLAUDEP_AUTO) { $env:CLAUDEP_AUTO } else { '<unset>' }; Write-Output \"$a|$b\" }",
    ].join("\n"),
    cd: (dir) => `Set-Location -LiteralPath ${q(dir)}`,
    unset: (v) => `Remove-Item Env:${v}`,
    echoVar: (v) => `Write-Output $env:${v}`,
    resolve: `& ${q(BUN)} ${q(SCRIPT)} resolve`,
    foundDir: (dir) => join(dir, ".claudep"),
  };
}

/** Git for Windows' bash, never Bun.which("bash"): System32 has a WSL stub by that name. */
function gitBash(): string | undefined {
  for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], "C:\\Program Files"]) {
    if (!root) continue;
    const p = join(root, "Git", "bin", "bash.exe");
    if (existsSync(p)) return p;
  }
  return undefined;
}

function dialects(): Dialect[] {
  const out: Dialect[] = [];
  if (WIN) {
    const bash = gitBash();
    if (bash) out.push(sh("bash", bash));
  } else {
    out.push(sh("bash", "bash"));
    if (Bun.which("zsh")) out.push(sh("zsh", "zsh"));
    const f = Bun.which("fish");
    if (f) out.push(fish(f));
  }
  const pwsh = Bun.which("pwsh");
  if (pwsh) out.push(powershell("pwsh", pwsh));
  const ps5 = WIN ? Bun.which("powershell") : null;
  if (ps5) out.push(powershell("powershell", ps5));
  return out;
}

async function runShell(
  d: Dialect,
  home: string,
  lines: string[],
  env: Record<string, string> = {},
): Promise<ShellRun> {
  const cleanEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    NO_COLOR: "1",
    ...env,
  };
  if (WIN) cleanEnv.USERPROFILE = home;
  // What the shells need from the host to start at all; nothing claudep reads.
  for (const k of [
    "PSModulePath",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "PATHEXT",
    "COMSPEC",
    "LOCALAPPDATA",
    "APPDATA",
    "LANG",
    "TERM",
  ]) {
    const v = process.env[k];
    if (v !== undefined && cleanEnv[k] === undefined) cleanEnv[k] = v;
  }
  const proc = Bun.spawn([d.exe, ...d.args(`${d.prelude}\n${lines.join("\n")}`)], {
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
  return { exitCode, stdout: stdout.replace(/\r\n/g, "\n"), stderr: stderr.replace(/\r\n/g, "\n") };
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

const all = dialects();

describe.each(all)("$name hook", (d) => {
  const run = (home: string, lines: string[], env?: Record<string, string>) => runShell(d, home, lines, env);
  const lines = (r: ShellRun) => r.stdout.trim().split("\n");

  test("sets the profile on entering a pinned tree and clears it on leaving", async () => {
    using h = fakeHome();
    const { nested, work } = pinnedTree(h.home, h.profilesRoot);
    const r = await run(h.home, ["show", d.cd(nested), "tick", "show", d.cd("/"), "tick", "show"]);
    expect(r.stderr).toBe("");
    expect(lines(r)).toEqual(["<unset>|<unset>", `${work}|${work}`, "<unset>|<unset>"]);
  });

  test("never touches a manual pin", async () => {
    using h = fakeHome();
    const { nested } = pinnedTree(h.home, h.profilesRoot);
    const manual = join(h.profilesRoot, "manual");
    mkdirSync(manual);
    const r = await run(h.home, [d.cd(nested), "tick", "show", d.cd("/"), "tick", "show"], {
      CLAUDE_CONFIG_DIR: manual,
    });
    expect(lines(r)).toEqual([`${manual}|<unset>`, `${manual}|<unset>`]);
  });

  test("takes over again after the manual pin is cleared", async () => {
    using h = fakeHome();
    const { nested, work } = pinnedTree(h.home, h.profilesRoot);
    const manual = join(h.profilesRoot, "manual");
    mkdirSync(manual);
    const r = await run(
      h.home,
      [d.cd(nested), "tick", "show", d.unset("CLAUDE_CONFIG_DIR"), d.cd(h.home), "tick", d.cd(nested), "tick", "show"],
      { CLAUDE_CONFIG_DIR: manual },
    );
    expect(lines(r)).toEqual([`${manual}|<unset>`, `${work}|${work}`]);
  });

  test("reads a pin file with CRLF line endings", async () => {
    using h = fakeHome();
    const { repo, nested, work } = pinnedTree(h.home, h.profilesRoot);
    writeFileSync(join(repo, ".claudep"), "# from Windows\r\nwork\r\n");
    const r = await run(h.home, [d.cd(nested), "tick", "show"]);
    expect(r.stderr).toBe("");
    expect(lines(r)).toEqual([`${work}|${work}`]);
  });

  test("reads a pin file without a trailing newline", async () => {
    using h = fakeHome();
    const { repo, nested, work } = pinnedTree(h.home, h.profilesRoot);
    writeFileSync(join(repo, ".claudep"), "work");
    const r = await run(h.home, [d.cd(nested), "tick", "show"]);
    expect(r.stderr).toBe("");
    expect(lines(r)).toEqual([`${work}|${work}`]);
  });

  test("an empty pin in a subtree cancels the parent pin", async () => {
    using h = fakeHome();
    const { repo, nested, work } = pinnedTree(h.home, h.profilesRoot);
    writeFileSync(join(repo, "src", ".claudep"), "# no pin below here\n");
    const r = await run(h.home, [d.cd(repo), "tick", "show", d.cd(nested), "tick", "show"]);
    expect(lines(r)).toEqual([`${work}|${work}`, "<unset>|<unset>"]);
  });

  test("warns once per directory change when the pinned profile does not exist, and clears any auto pin", async () => {
    using h = fakeHome();
    const { nested } = pinnedTree(h.home, h.profilesRoot);
    const other = join(h.home, "other");
    mkdirSync(other);
    writeFileSync(join(other, ".claudep"), "ghost\n");
    const r = await run(h.home, [d.cd(nested), "tick", d.cd(other), "tick", "tick", "show"]);
    expect(r.stdout.trim()).toBe("<unset>|<unset>");
    expect(r.stderr.trim().split("\n")).toEqual([
      `claudep: ${d.foundDir(other)} names profile "ghost", which does not exist. Run: claudep init ghost`,
    ]);
  });

  test("agrees with `claudep resolve` on the nearest pin", async () => {
    using h = fakeHome();
    const { nested, work } = pinnedTree(h.home, h.profilesRoot);
    const r = await run(h.home, [d.cd(nested), "tick", d.echoVar("CLAUDE_CONFIG_DIR"), d.resolve]);
    expect(lines(r)).toEqual([work, "work"]);
  });
});

test.if(all.length === 0)("no shell to drive the hook with on this machine", () => {
  // Windows without Git for Windows or PowerShell. The unit tests still cover the hook text.
  expect(WIN).toBe(true);
});
