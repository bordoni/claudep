/**
 * Loads the generated completion scripts in the real shells. Parse checks
 * for zsh, bash and fish; bash, fish and PowerShell are also driven to
 * produce candidates, PowerShell through TabExpansion2. zsh's _arguments
 * cannot run outside a completion widget, so zsh is checked to load under
 * compinit and define _claudep. Every case is gated on the shell being
 * installed. The Windows job runs only the PowerShell cases, under pwsh and
 * Windows PowerShell 5.1.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fakeBin, SCRIPT } from "./lib/cli.ts";
import { fakeHome } from "./lib/home.ts";

const WIN = process.platform === "win32";
const BUN = process.execPath;
const q = (p: string) => JSON.stringify(p);

/** What the shells need from the host to start at all, Windows PowerShell
 *  above all; nothing claudep reads. */
function hostEnv(): Record<string, string> {
  const out: Record<string, string> = {};
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
  ]) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

async function shell(
  exe: string,
  args: string[],
  home: string,
  bin?: string,
): Promise<{ code: number; out: string; err: string }> {
  const path = [bin, process.env.PATH].filter(Boolean).join(delimiter);
  const proc = Bun.spawn([exe, ...args], {
    env: { ...hostEnv(), PATH: path, HOME: home, USERPROFILE: home, NO_COLOR: "1", TERM: "dumb" },
    cwd: home,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

function withProfiles(): ReturnType<typeof fakeHome> {
  const h = fakeHome();
  mkdirSync(join(h.profilesRoot, "work"), { recursive: true });
  mkdirSync(join(h.profilesRoot, "personal"), { recursive: true });
  return h;
}

const gen = (sh: string) => `${q(BUN)} ${q(SCRIPT)} completion ${sh}`;

describe("completion scripts in real shells", () => {
  for (const sh of ["zsh", "bash", "fish"] as const) {
    test.if(!WIN && Bun.which(sh) !== null)(`${sh} parses the script`, async () => {
      using h = withProfiles();
      const r = await shell(sh, ["-c", `${gen(sh)} > "$HOME/comp"; ${sh} -n "$HOME/comp"`], h.home);
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
    });
  }

  test.if(!WIN)("bash offers commands, profiles, flags, values and shells", async () => {
    using h = withProfiles();
    const lines = [
      `eval "$(${gen("bash")})"`,
      `COMP_WORDS=(claudep ''); COMP_CWORD=1; _claudep; echo "\${COMPREPLY[*]}"`,
      `COMP_WORDS=(claudep rm ''); COMP_CWORD=2; _claudep; echo "\${COMPREPLY[*]}"`,
      `COMP_WORDS=(claudep init --); COMP_CWORD=2; _claudep; echo "\${COMPREPLY[*]}"`,
      `COMP_WORDS=(claudep env work --shell ''); COMP_CWORD=4; _claudep; echo "\${COMPREPLY[*]}"`,
      `COMP_WORDS=(claudep completion ''); COMP_CWORD=2; _claudep; echo "\${COMPREPLY[*]}"`,
    ];
    const r = await shell("bash", ["-c", lines.join("\n")], h.home);
    expect(r.err).toBe("");
    const [top, rm, init, env, comp] = r.out.trim().split("\n");
    expect(top?.split(" ")).toEqual(
      expect.arrayContaining(["init", "rm", "vars", "completion", "default", "work", "personal"]),
    );
    expect(rm).toBe("default personal work");
    expect(init?.split(" ")).toEqual(expect.arrayContaining(["--sso", "--email", "--env"]));
    expect(env).toBe("sh zsh bash fish powershell");
    expect(comp).toBe("zsh bash fish powershell");
  });

  test.if(!WIN && Bun.which("fish") !== null)(
    "fish offers commands with descriptions, profiles and flags",
    async () => {
      using h = withProfiles();
      const lines = [
        `${gen("fish")} | source`,
        "complete -C 'claudep ' | string join ' '",
        "complete -C 'claudep rm ' | string replace -r '\\t.*' '' | string join ' '",
        "complete -C 'claudep init --' | string join ' '",
        "complete -C 'claudep env work --shell ' | string join ' '",
      ];
      const r = await shell("fish", ["-c", lines.join("\n")], h.home);
      expect(r.err).toBe("");
      const [top, rm, init, env] = r.out.trim().split("\n");
      expect(top).toContain("init\tcreate or update a profile and log in");
      expect(top).toContain("work\tprofile");
      expect(top).toContain("vars\tlist, set or unset the variables a profile exports");
      expect(rm).toBe("default personal work");
      expect(init).toContain("--sso");
      expect(init).toContain("--env");
      expect(env).toBe("bash fish powershell sh zsh");
    },
  );

  const powershells = [
    ["pwsh", Bun.which("pwsh")],
    ["powershell", WIN ? Bun.which("powershell") : null],
  ] as const;
  // claudep is on PATH, as it is once installed. Without it every Tab sends
  // PowerShell through PATH and module auto-loading looking for the command,
  // which on the Windows runner took pwsh 17 s and 5.1 past 30 s.
  // Windows PowerShell 5.1 never calls a native completer for a bare `-`,
  // `--` or `-x` word: its own parameter completion takes those and finds
  // nothing. From `--x` on it calls the completer as pwsh does.
  for (const [name, exe] of powershells) {
    test.if(exe !== null)(`${name} offers commands, profiles, flags, values and shells`, async () => {
      using h = withProfiles();
      const bin = fakeBin(h.home, { withClaudep: true });
      const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;
      const script = [
        `& ${psq(BUN)} ${psq(SCRIPT)} completion powershell | Out-String | Invoke-Expression`,
        "function c([string]$line) { ((TabExpansion2 -inputScript $line -cursorColumn $line.Length).CompletionMatches | ForEach-Object { $_.CompletionText }) -join ' ' }",
        "c 'claudep '",
        "c 'claudep rm '",
        "c 'claudep init --'",
        "c 'claudep init --e'",
        "c 'claudep env work --shell '",
        "c 'claudep completion '",
        "c 'claudep sta'",
        "(TabExpansion2 -inputScript 'claudep in' -cursorColumn 10).CompletionMatches[0].ToolTip",
      ].join("\n");
      const r = await shell(exe as string, ["-NoProfile", "-NonInteractive", "-Command", script], h.home, bin);
      expect(r.err).toBe("");
      const [top, rm, init, initE, env, comp, sta, tip] = r.out.trim().split(/\r?\n/);
      expect(top?.split(" ")).toEqual(
        expect.arrayContaining(["init", "rm", "vars", "completion", "default", "work", "personal"]),
      );
      expect(rm).toBe("default personal work");
      if (name === "pwsh") expect(init?.split(" ")).toEqual(expect.arrayContaining(["--sso", "--email", "--env"]));
      else expect(init).toBe("");
      expect(initE).toBe("--email --env");
      expect(env).toBe("sh zsh bash fish powershell");
      expect(comp).toBe("zsh bash fish powershell");
      expect(sta).toBe("status");
      expect(tip).toBe("create or update a profile and log in");
    });
  }

  test.if(!WIN && Bun.which("zsh") !== null)("zsh loads the script under compinit and registers _claudep", async () => {
    using h = withProfiles();
    const script = [
      "autoload -Uz compinit; compinit -u -D",
      `eval "$(${gen("zsh")})"`,
      "(( $+functions[_claudep] )) && echo defined",
      "print -r -- $_comps[claudep]",
    ].join("\n");
    const r = await shell("zsh", ["-f", "-c", script], h.home);
    expect(r.err).toBe("");
    expect(r.out.trim().split("\n")).toEqual(["defined", "_claudep"]);
  });
});
