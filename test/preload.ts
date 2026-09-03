/**
 * Loaded before every test file (bunfig.toml [test].preload).
 *
 * Redirects HOME and the XDG dirs to a throwaway directory so nothing under
 * test can touch the real ~/.claude, ~/.claudep or keychain, and strips any
 * credential or profile env vars from the developer's shell.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(realpathSync.native(tmpdir()), "claudep-test-"));

process.env.HOME = root;
process.env.XDG_CONFIG_HOME = join(root, ".config");
process.env.XDG_DATA_HOME = join(root, ".local", "share");
process.env.XDG_STATE_HOME = join(root, ".local", "state");
process.env.XDG_CACHE_HOME = join(root, ".cache");
process.env.NO_COLOR = "1";
process.env.CLAUDEP_TEST_ROOT = root;

for (const key of Object.keys(process.env)) {
  if (key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_")) delete process.env[key];
}

process.on("exit", () => {
  rmSync(root, { recursive: true, force: true });
});
