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

Skipped on purpose: vitest, changesets, husky, Codecov, snapshot tests of stdout, a three-OS matrix.

## quinnjr/claude-code-profiles (2026-09-03)

A 1,586-line POSIX shell library with PowerShell and cmd ports, 91 stars, no tests. It sets `CLAUDE_CONFIG_DIR` to an empty directory per profile and shadows bare `claude` with a shell function. Its issue #8 is worth knowing about: a user claimed all profiles shared one Keychain slot on macOS, then retracted after shimming `/usr/bin/security` and finding the same per-directory hash claudep relies on.

| Their feature | Verdict | Why |
|---|---|---|
| `.claude-profile` file and auto-switch on `cd` | pulled as `.claudep` pins | Best product idea in the repo. Their exported-marker trick (`CLAUDE_PROFILE_AUTO_SET`) became `CLAUDEP_AUTO`. |
| Bare status command | pulled as `claudep current` | claudep had no "what am I on" answer. |
| `version` command | pulled as `--version` | |
| Pure parameter-expansion directory walk | pulled | A fork per prompt would be felt. |
| Per-profile skill selection from a shared pool | not now | Conflicts with `skills/` being one shared symlink; needs a manifest, doctor support and tests. Revisit if context bloat becomes a real complaint. |
| Windows, PowerShell, cmd ports | not now | bun runs on Windows and `CLAUDE_CONFIG_DIR` is honoured there; the gap is untested, not unimplemented. A Windows CI job is the cheap first step. |
| MSYS `cygpath -w` conversion, fail loudly if missing | recorded, not built | Passing a `/c/Users/...` path to `claude.exe` makes it create a config dir somewhere unexpected. |
| Empty profiles, nothing shared | skipped | The reason claudep exists. |
| Shadowing bare `claude` | skipped | Overlay decision in `design-decisions.md`. |
| `create --init` settings skeleton with `ANTHROPIC_API_KEY` | skipped | Against the Never list. |
| Self-updater with `curl` in the launch path | skipped | `bun add -g` updates; no network call belongs in `run`. |
| Three hand-ported implementations | skipped | Against "keep it one file"; their v1.2.1 was a zsh-only parse-error hotfix. |

Their auto-updater still points at the previous owner's URLs (`pegasusheavy/`), which works only through GitHub's rename redirect. Do not copy any of their URLs.

## Release and publishing research (2026-09-02)

Sources: docs.npmjs.com (trusted publishers, provenance, staged publishing), GitHub changelog posts on OIDC and token deprecation, `actions/setup-node` advanced usage, `actions/starter-workflows`, ljharb/actions and antfu/ni release workflows, oven-sh/bun issues #22423 and #15601, Keep a Changelog 1.1.0. What was taken is in `releasing.md`; the reasoning is in `design-decisions.md`.
