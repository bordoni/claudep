/**
 * Stand-in for the real `claude` binary, put on PATH by test/lib/cli.ts.
 *
 * It honours CLAUDE_CONFIG_DIR the way claudep expects:
 *   auth status --json   reads <config dir>/.fake-login.json; exit 1 when absent. Adds
 *                        configDirectory (FAKE_CLAUDE_CONFIG_DIRECTORY overrides it),
 *                        apiProvider, and apiKeySource when ANTHROPIC_API_KEY is set, as 2.1.286 does
 *   auth login           writes that file (email from --email or FAKE_CLAUDE_EMAIL)
 *   auth logout          deletes it
 *   --version            prints a fake version
 *   mcp list             prints FAKE_CLAUDE_MCP, or three servers in 2.1.322's format
 *   -p /usage            prints a result document like 2.1.286's, its text from FAKE_CLAUDE_USAGE
 *                        when set, after logging like anything else
 *   anything else        appends {argv, configDir} to $FAKE_CLAUDE_LOG and exits $FAKE_CLAUDE_EXIT;
 *                        FAKE_CLAUDE_LOG_ENV=A,B adds {env: {A, B}} with the values it saw
 *
 * Before anything but --version, FAKE_CLAUDE_STDERR=<bytes> writes that much to stderr
 * (a full pipe blocks a child nobody reads) and FAKE_CLAUDE_SLEEP=<ms> waits.
 * FAKE_CLAUDE_STOP_FAILURE=<error> runs the matching StopFailure hooks from --settings with
 * that error before exiting, as Claude Code does when a turn ends on an API error.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const home = process.env.HOME ?? process.env.USERPROFILE ?? "/nonexistent";
const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
const loginFile = join(configDir, ".fake-login.json");

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

if (argv[0] === "--version") {
  out(process.env.FAKE_CLAUDE_VERSION ?? "9.9.9 (fake claude)");
  process.exit(0);
}

const noise = Number(process.env.FAKE_CLAUDE_STDERR ?? "0");
if (noise > 0) await Bun.write(Bun.stderr, "x".repeat(noise));
const sleepMs = Number(process.env.FAKE_CLAUDE_SLEEP ?? "0");
if (sleepMs > 0) await Bun.sleep(sleepMs);

/** The fields 2.1.286 adds to every `auth status --json`. */
function reported(): Record<string, string> {
  const fields: Record<string, string> = {
    apiProvider: "firstParty",
    configDirectory: process.env.FAKE_CLAUDE_CONFIG_DIRECTORY ?? configDir,
  };
  if (process.env.ANTHROPIC_API_KEY) fields.apiKeySource = "ANTHROPIC_API_KEY";
  return fields;
}

if (argv[0] === "auth" && argv[1] === "status") {
  if (existsSync(loginFile)) {
    out(JSON.stringify({ ...JSON.parse(readFileSync(loginFile, "utf8")), ...reported() }));
    process.exit(0);
  }
  if (argv.includes("--text")) out("Not logged in. Run claude auth login to authenticate.");
  else out(JSON.stringify({ loggedIn: false, authMethod: "none", ...reported() }));
  process.exit(1);
}

if (argv[0] === "auth" && argv[1] === "login") {
  const i = argv.indexOf("--email");
  const email = (i !== -1 ? argv[i + 1] : undefined) ?? process.env.FAKE_CLAUDE_EMAIL ?? "fake@example.com";
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    loginFile,
    JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      email,
      orgName: `${email}'s Org`,
      subscriptionType: "max",
      sso: argv.includes("--sso"),
    }),
  );
  out(`Logged in as ${email}`);
  process.exit(0);
}

if (argv[0] === "auth" && argv[1] === "logout") {
  const was = existsSync(loginFile);
  rmSync(loginFile, { force: true });
  out(was ? "Logged out" : "Not logged in");
  process.exit(was ? 0 : 1);
}

if (argv[0] === "mcp" && argv[1] === "list") {
  if (process.env.FAKE_CLAUDE_LOG)
    appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ argv, cwd: process.cwd() })}\n`);
  out(
    process.env.FAKE_CLAUDE_MCP ??
      [
        "Checking MCP server health\u2026",
        "",
        "nx1: https://mcp.example.com/mcp (HTTP) - \u2713 Connected",
        "claude.ai Drive: https://claude.ai/x - ! Needs authentication",
        "local: /usr/bin/thing --token-file /secret/path - \u2718 Failed to connect \u2014 ENOENT",
      ].join("\n"),
  );
  process.exit(0);
}

const log = process.env.FAKE_CLAUDE_LOG;
const logEnv = process.env.FAKE_CLAUDE_LOG_ENV;
const entry: Record<string, unknown> = { argv, configDir: process.env.CLAUDE_CONFIG_DIR ?? null };
if (logEnv) entry.env = Object.fromEntries(logEnv.split(",").map((k) => [k, process.env[k] ?? null]));
if (log) appendFileSync(log, `${JSON.stringify(entry)}\n`);
if (argv[0] === "-p" && argv[1] === "/usage") {
  const result =
    process.env.FAKE_CLAUDE_USAGE ??
    "You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 12% used · resets Oct 17 at 1:59pm (America/New_York)\nCurrent week (all models): 34% used · resets Oct 23 at 10:59pm (America/New_York)\nCurrent week (Fable): 5% used · resets Oct 23 at 11pm (America/New_York)\n\nWhat's contributing to your limits usage?";
  out(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 0, total_cost_usd: 0, result }));
  process.exit(0);
}
// Claude Code runs StopFailure hooks when a turn ends on an API error. The fake
// runs every StopFailure command in the --settings it was given whose matcher
// matches, through sh with the payload on stdin, the way Claude Code does.
const stopFailure = process.env.FAKE_CLAUDE_STOP_FAILURE;
const at = argv.indexOf("--settings");
if (stopFailure && at !== -1) {
  type Entry = { matcher?: string; hooks?: { type?: string; command?: string }[] };
  const settings = JSON.parse(argv[at + 1] ?? "{}") as { hooks?: { StopFailure?: Entry[] } };
  const payload = JSON.stringify({ hook_event_name: "StopFailure", error: stopFailure, session_id: "fake" });
  const sh =
    process.platform === "win32"
      ? join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
      : "/bin/sh";
  for (const entry of settings.hooks?.StopFailure ?? []) {
    if (entry.matcher && !new RegExp(`^(?:${entry.matcher})$`).test(stopFailure)) continue;
    for (const h of entry.hooks ?? [])
      if (h.type === "command" && h.command)
        Bun.spawnSync([sh, "-c", h.command], { stdin: new Blob([payload]), stdout: "ignore", stderr: "inherit" });
  }
}
out(`fake claude ran with: ${argv.join(" ")}`);
process.exit(Number(process.env.FAKE_CLAUDE_EXIT ?? "0"));
