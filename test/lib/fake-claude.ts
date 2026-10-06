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
 *   anything else        appends {argv, configDir} to $FAKE_CLAUDE_LOG and exits $FAKE_CLAUDE_EXIT;
 *                        FAKE_CLAUDE_LOG_ENV=A,B adds {env: {A, B}} with the values it saw
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

const log = process.env.FAKE_CLAUDE_LOG;
const logEnv = process.env.FAKE_CLAUDE_LOG_ENV;
const entry: Record<string, unknown> = { argv, configDir: process.env.CLAUDE_CONFIG_DIR ?? null };
if (logEnv) entry.env = Object.fromEntries(logEnv.split(",").map((k) => [k, process.env[k] ?? null]));
if (log) appendFileSync(log, `${JSON.stringify(entry)}\n`);
out(`fake claude ran with: ${argv.join(" ")}`);
process.exit(Number(process.env.FAKE_CLAUDE_EXIT ?? "0"));
