# Prior art and what was taken from it

Two research passes shaped this repo. Their sources are here so a later "should we add X" can start from the evidence instead of redoing it.

## Testing conventions of bun-native CLIs (2026-09-02)

Fetched and read: sst/opencode, oven-sh/bun, bunup/bunup, photon-hq/imessage-kit, OpenRouterLabs/spawn, haydenbleasel/blume, unjs/citty, bombshell-dev/clack, antfu-collective/ni.

| Practice | Where it came from | In claudep |
|---|---|---|
| `bun test` with a top-level `test/` dir | every bun-native repo above | yes |
| Preload that repoints `HOME` and `XDG_*` and deletes credential env vars | opencode `test/preload.ts`, spawn `src/__tests__/preload.ts` | `test/preload.ts` |
| Spawn the real entrypoint with an isolated env, assert exit code and output | opencode `test/lib/cli-process.ts`, bun `test/harness.ts` | `test/lib/cli.ts` |
| `realpathSync.native(tmpdir())` so macOS `/var` vs `/private/var` does not break comparisons | bun `test/harness.ts` | `test/preload.ts`, `test/lib/home.ts` |
| `NO_COLOR=1` for stable output | bun `test/harness.ts` | `test/lib/cli.ts` |
| Dependency injection over `mock.module` | spawn (moved away from it because of cross-file pollution) | `keychainHas(service, deps)` |
| `import.meta.main` guard so the script is importable | bun docs | bottom of `claudep.ts` |
| `test.if(process.platform === "darwin")` for platform-only behaviour | imessage-kit, bun | `test/keychain.test.ts` |
| Biome as the single lint and format tool | clack, imessage-kit, spawn | `biome.json` |
| `packageManager` field, committed lockfile, `scripts` for test/typecheck/lint | bunup, blume, imessage-kit | `package.json` |
| One `ci.yml`, Linux for static checks, macOS for tests when the tool is macOS-first | imessage-kit, bunup | `.github/workflows/ci.yml` (tests on both) |

Skipped on purpose: vitest, changesets, husky, Codecov, snapshot tests of stdout. The three-OS matrix was skipped at first and added on 2026-09-06 with Windows support.

## quinnjr/claude-code-profiles (2026-09-03)

A 1,586-line POSIX shell library with PowerShell and cmd ports, 91 stars, no tests. It sets `CLAUDE_CONFIG_DIR` to an empty directory per profile and shadows bare `claude` with a shell function. Its issue #8 is worth knowing about: a user claimed all profiles shared one Keychain slot on macOS, then retracted after shimming `/usr/bin/security` and finding the same per-directory hash claudep relies on.

| Their feature | Verdict | Why |
|---|---|---|
| `.claude-profile` file and auto-switch on `cd` | pulled as `.claudep` pins | Best product idea in the repo. Their exported-marker trick (`CLAUDE_PROFILE_AUTO_SET`) became `CLAUDEP_AUTO`. |
| Bare status command | pulled as `claudep current` | claudep had no "what am I on" answer. |
| `version` command | pulled as `--version` | |
| Pure parameter-expansion directory walk | pulled | A fork per prompt would be felt. |
| Per-profile skill selection from a shared pool | not now | Conflicts with `skills/` being one shared symlink; needs a manifest, doctor support and tests. Revisit if context bloat becomes a real complaint. |
| Windows, PowerShell, cmd ports | built 2026-09-06, as one file | Windows support lives in `claudep.ts` behind `platform` parameters, with a `windows-latest` CI job. cmd.exe is excluded: no per-prompt hook. See `windows.md`. |
| MSYS `cygpath -w` conversion, fail loudly if missing | not needed | claudep runs as a native Windows bun even under Git Bash, so `canon()` rewrites `/c/` paths in TypeScript and the bash hook exports the native root it was given. |
| Empty profiles, nothing shared | skipped | The reason claudep exists. |
| Shadowing bare `claude` | skipped | Overlay decision in `design-decisions.md`. |
| `create --init` settings skeleton with `ANTHROPIC_API_KEY` | skipped | Against the Never list. |
| Self-updater with `curl` in the launch path | skipped | `bun add -g` updates; no network call belongs in `run`. |
| Three hand-ported implementations | skipped | Against "keep it one file"; their v1.2.1 was a zsh-only parse-error hotfix. |

Their auto-updater still points at the previous owner's URLs (`pegasusheavy/`), which works only through GitHub's rename redirect. Do not copy any of their URLs.

## Four more switchers (2026-09-07)

Read for the releases after 0.2.0: realiti4/claude-swap (Python, rate-limit rotation), uwuclxdy/clauth (Go, TUI and MCP plugin), JakubKontra/claude-profile-manager (Go, `cpm`), hamzarehmandeveloper/claude-account (Rust). All four set `CLAUDE_CONFIG_DIR`; none supports fish.

| Their feature | Who | Verdict | Why |
|---|---|---|---|
| Live 5-hour and 7-day usage per account, auto-rotation at a threshold | claude-swap, clauth | rejected | Both call Anthropic's usage API with the account's OAuth token. Reading the token is against Never 3, and Claude Code has no non-interactive usage command to shell out to. |
| Strip `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` from the child | claude-account | 0.3.0, as a warning | They silently override the profile's login, always in `-p` mode. claudep warns and names the variable; it does not edit what the user exported. |
| Refuse Claude Code older than 2.1.144 on macOS | claude-account | 0.3.0, in `doctor` | Before that build every config dir shared one Keychain item. |
| Both `CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR` | claude-account | not needed | The hash is over `CLAUDE_CONFIG_DIR` already; the second variable only matters when the two should differ. |
| `prompt` segment for the shell prompt | claude-profile-manager | 0.3.0 as `current --name` | Plus a README note that `${CLAUDE_CONFIG_DIR##*/}` costs nothing in a prompt. |
| `--json` on the list command | claude-swap, clauth | 0.3.0 | `status` already had it. |
| Shell completions | clauth | 0.4.0 | Generated from one command table; profile names from a glob, never a subprocess. |
| Per-profile `env` block (Bedrock, Vertex profiles) | claude-profile-manager | deferred | See `design-decisions.md`. The hook could not apply it. |
| `clone`, cloud sync of settings through git, self-update, TUI, Windows tray, MCP plugin that switches accounts mid-session | various | skipped | Against "one file", "no network in the launch path", or solving a problem `bun add -g` and symlinks already solve. |
| Copied `settings.json` and `CLAUDE.md` per profile with a `--sync` | claude-profile-manager | skipped | claudep symlinks them; a copy forks silently. |

## Release and publishing research (2026-09-02)

Sources: docs.npmjs.com (trusted publishers, provenance, staged publishing), GitHub changelog posts on OIDC and token deprecation, `actions/setup-node` advanced usage, `actions/starter-workflows`, ljharb/actions and antfu/ni release workflows, oven-sh/bun issues #22423 and #15601, Keep a Changelog 1.1.0. What was taken is in `releasing.md`; the reasoning is in `design-decisions.md`.
