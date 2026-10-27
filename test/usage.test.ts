/**
 * Usage limits without a token: the statusline's rate_limits, the text of
 * `claude -p /usage`, the per-profile cache under the profiles root, and the
 * table `claudep usage` prints. The /usage text is the one Claude Code
 * 2.1.286 printed for a Max subscription, with nothing changed.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ageText,
  formatUsageTable,
  layout,
  parseUsageOutput,
  parseUsageText,
  readUsageCache,
  statuslineUsage,
  type Usage,
  usageCachePath,
  usageSegment,
  writeUsageCache,
} from "../claudep.ts";
import { fakeHome } from "./lib/home.ts";

const USAGE_2_1_286 = `You are currently using your subscription to power your Claude Code usage

Current session: 2% used · resets Oct 17 at 1:59pm (America/New_York)
Current week (all models): 2% used · resets Oct 23 at 10:59pm (America/New_York)
Current week (Fable): 0% used · resets Oct 23 at 11pm (America/New_York)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.

Last 24h · 809 requests · 3 sessions
  100% of your usage came from subagent-heavy sessions`;

/** The window lines are 2.1.311's exact format on Linux, where the reset
 *  text has a comma; the behaviour lines come from the server. */
const USAGE_2_1_311 = `You are currently using your subscription to power your Claude Code usage

Current session: 7% used · resets Oct 27, 5:59pm (America/New_York)
Current week (all models): 23% used · resets Oct 30, 10:59pm (America/New_York)
Current week (Sonnet only): 4% used · resets Oct 30, 11pm (America/New_York)
Current week (Fable): 0% used · resets Oct 30, 11pm (America/New_York)

What's contributing to your limits usage?
Approximate · sessions on this machine only · shares overlap

Last 24h · 412 requests · 5 sessions
  64%  Subagent-heavy sessions · 3 sessions ran 10+ subagents
  Top skills: /fetch 40%, /hourly 22%

Last 7d · 2931 requests · 31 sessions
  51%  Subagent-heavy sessions`;

describe("parseUsageText", () => {
  test("reads the session, the week and each model's week", () => {
    expect(parseUsageText(USAGE_2_1_286, 100)).toEqual({
      fiveHour: { usedPercentage: 2, resets: "Oct 17 at 1:59pm (America/New_York)" },
      sevenDay: { usedPercentage: 2, resets: "Oct 23 at 10:59pm (America/New_York)" },
      models: { Fable: { usedPercentage: 0, resets: "Oct 23 at 11pm (America/New_York)" } },
      at: 100,
      source: "usage",
    });
  });

  test("reads 2.1.311, with the Sonnet-only week as a model and the behaviour lines ignored", () => {
    expect(parseUsageText(USAGE_2_1_311, 100)).toEqual({
      fiveHour: { usedPercentage: 7, resets: "Oct 27, 5:59pm (America/New_York)" },
      sevenDay: { usedPercentage: 23, resets: "Oct 30, 10:59pm (America/New_York)" },
      models: {
        "Sonnet only": { usedPercentage: 4, resets: "Oct 30, 11pm (America/New_York)" },
        Fable: { usedPercentage: 0, resets: "Oct 30, 11pm (America/New_York)" },
      },
      at: 100,
      source: "usage",
    });
  });

  test("takes decimals and a window with no reset, and nothing from other text", () => {
    expect(parseUsageText("Current session: 12.5% used", 1)?.fiveHour).toEqual({ usedPercentage: 12.5 });
    expect(parseUsageText("You are using an API key", 1)).toBeUndefined();
  });

  test("parseUsageOutput reads the result of the JSON document", () => {
    const out = JSON.stringify({ type: "result", num_turns: 0, result: USAGE_2_1_286 });
    expect(parseUsageOutput(out, 5)?.sevenDay?.usedPercentage).toBe(2);
    expect(parseUsageOutput("not json", 5)).toBeUndefined();
    expect(parseUsageOutput(JSON.stringify({ result: 3 }), 5)).toBeUndefined();
  });
});

describe("statuslineUsage", () => {
  test("reads both windows, and either one alone", () => {
    const both = JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: 1_797_500_000 },
        seven_day: { used_percentage: 41, resets_at: 1_797_900_000 },
      },
    });
    expect(statuslineUsage(both, 9)).toEqual({
      fiveHour: { usedPercentage: 23.5, resetsAt: 1_797_500_000 },
      sevenDay: { usedPercentage: 41, resetsAt: 1_797_900_000 },
      at: 9,
      source: "statusline",
    });
    const week = JSON.stringify({ rate_limits: { seven_day: { used_percentage: 7, resets_at: 1 } } });
    expect(statuslineUsage(week, 9)?.fiveHour).toBeUndefined();
  });

  test("is undefined without rate_limits, as for an API-key session", () => {
    expect(statuslineUsage(JSON.stringify({ session_id: "s" }), 9)).toBeUndefined();
    expect(statuslineUsage("", 9)).toBeUndefined();
    expect(
      statuslineUsage(JSON.stringify({ rate_limits: { five_hour: { used_percentage: "x" } } }), 9),
    ).toBeUndefined();
  });

  test("usageSegment rounds and leaves out a missing window", () => {
    const u: Usage = { fiveHour: { usedPercentage: 23.5, resetsAt: 1 }, at: 0, source: "statusline" };
    expect(usageSegment("work", u)).toBe("work · 5h 24%");
    expect(usageSegment("work", undefined)).toBe("work");
  });
});

describe("the usage cache", () => {
  test("lives under the profiles root and is written only when the numbers change", async () => {
    using h = fakeHome();
    const L = layout({ HOME: h.home, USERPROFILE: h.home });
    const u: Usage = { fiveHour: { usedPercentage: 10, resetsAt: 5 }, at: 1, source: "statusline" };
    expect(usageCachePath(L, "work")).toBe(join(h.profilesRoot, ".usage", "work.json"));
    expect(writeUsageCache(L, "work", u, undefined)).toBe(true);
    const read = await readUsageCache(L, "work");
    expect(read).toEqual({
      fiveHour: { usedPercentage: 10, resetsAt: 5 },
      sevenDay: undefined,
      at: 1,
      source: "statusline",
    });
    expect(writeUsageCache(L, "work", { ...u, at: 2 }, read)).toBe(false);
    expect(JSON.parse(readFileSync(usageCachePath(L, "work"), "utf8")).at).toBe(1);
    expect(writeUsageCache(L, "work", { ...u, fiveHour: { usedPercentage: 11, resetsAt: 5 } }, read)).toBe(true);
    expect(existsSync(join(h.base, ".usage"))).toBe(false);
  });
});

describe("formatUsageTable", () => {
  test("shows live rows as now, cached rows with their age and source, and unknown ones as never", () => {
    const now = 10_000;
    const live = parseUsageText(USAGE_2_1_286, now);
    const cached: Usage = { sevenDay: { usedPercentage: 41.2 }, at: now - 600, source: "statusline" };
    const lines = formatUsageTable(
      [
        { name: "default", usage: live, live: true },
        { name: "work", usage: cached, live: false },
        { name: "api", live: false },
      ],
      now,
    );
    expect(lines[0]).toMatch(/^PROFILE\s+5H\s+RESETS\s+7D\s+RESETS\s+SEEN$/);
    expect(lines[1]).toMatch(/^default\s+2%\s+Oct 17 at 1:59pm\s+2%\s+Oct 23 at 10:59pm\s+now$/);
    expect(lines[2]).toMatch(/^work\s+-\s+-\s+41%\s+-\s+10 min ago \(statusline\)$/);
    expect(lines[3]).toMatch(/^api\s+-\s+-\s+-\s+-\s+never$/);
  });

  test("ageText", () => {
    expect(ageText(100, 130)).toBe("now");
    expect(ageText(0, 3599)).toBe("59 min ago");
    expect(ageText(0, 7200)).toBe("2 h ago");
    expect(ageText(0, 200_000)).toBe("2 d ago");
  });
});
