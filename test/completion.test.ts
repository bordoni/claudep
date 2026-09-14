/**
 * Loads the generated completion scripts in the real shells. Parse checks
 * for all three; bash and fish are also driven to produce candidates. zsh's
 * _arguments cannot run outside a completion widget, so zsh is checked to
 * load under compinit and define _claudep. Every case is gated on the shell
 * being installed; the Windows job skips them all.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SCRIPT } from "./lib/cli.ts";
import { fakeHome } from "./lib/home.ts";

const WIN = process.platform === "win32";
const BUN = process.execPath;
const q = (p: string) => JSON.stringify(p);

async function shell(exe: string, args: string[], home: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([exe, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, NO_COLOR: "1", TERM: "dumb" },
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
      expect.arrayContaining(["init", "rm", "completion", "default", "work", "personal"]),
    );
    expect(rm).toBe("default personal work");
    expect(init?.split(" ")).toEqual(expect.arrayContaining(["--sso", "--email"]));
    expect(env).toBe("sh zsh bash fish powershell");
    expect(comp).toBe("zsh bash fish");
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
      expect(rm).toBe("default personal work");
      expect(init).toContain("--sso");
      expect(env).toBe("bash fish powershell sh zsh");
    },
  );

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
