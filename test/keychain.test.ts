import { describe, expect, test } from "bun:test";
import { type KeychainDeps, keychainHas, keychainService } from "../claudep.ts";

function deps(exit: number, platform: NodeJS.Platform = "darwin"): KeychainDeps & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    platform,
    username: "tester",
    calls,
    spawn: (cmd) => {
      calls.push(cmd);
      return { exited: Promise.resolve(exit) };
    },
  };
}

describe("keychainHas", () => {
  test("asks security for the service under the current user and reads only the exit code", async () => {
    const d = deps(0);
    expect(await keychainHas("Claude Code-credentials-abcd1234", d)).toBe(true);
    expect(d.calls).toEqual([
      ["security", "find-generic-password", "-s", "Claude Code-credentials-abcd1234", "-a", "tester"],
    ]);
  });

  test("a non-zero exit means no item", async () => {
    expect(await keychainHas("svc", deps(44))).toBe(false);
  });

  test("is undefined off macOS and never spawns", async () => {
    const d = deps(0, "linux");
    expect(await keychainHas("svc", d)).toBeUndefined();
    expect(d.calls).toEqual([]);
  });

  test.if(process.platform === "darwin")(
    "the real security binary answers for a service that cannot exist",
    async () => {
      const result = await keychainHas(keychainService(`/claudep-test/${Date.now()}`));
      expect(result).toBe(false);
    },
  );
});
