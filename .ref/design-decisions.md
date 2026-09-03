# Design decisions

Dated, with the alternative that lost. Reopen one only with a reason that was not on the table the first time.

## 2026-09-02: Overlay profiles, not symmetric profiles

`~/.claude` stays untouched and is the implicit `default` profile. Extra accounts are thin directories that symlink back into it.

Rejected: demoting `~/.claude` to a shared base and making *every* account a named profile. Cleaner mental model, but it forces a migration and a re-login for every user on day one, and it changes what plain `claude` does. Overlay means a teammate adopts claudep by running one `init`.

## 2026-09-02: `projects/` is shared

Sessions and auto-memory follow the user, not the account. Rejected: per-profile `projects/` for stricter isolation. Would split memory and `--resume` and duplicate ~600 MB. Users who need the split can remove `projects` from `SHARED_DIRS` locally.

## 2026-09-02: `CLAUDE_CONFIG_DIR`, not `CLAUDE_CODE_OAUTH_TOKEN`

Rejected: one token per account from `claude setup-token`, exported per shell. It avoids the config-dir mechanism entirely but tokens cannot use claude.ai connectors or Remote Control, expire yearly, and end up in dotfiles. Once it was verified that Keychain entries are namespaced per config dir (see `claude-code-internals.md`), the config-dir approach had no remaining downside.

## 2026-09-02: Profiles root is `~/.claudep`

Originally `~/.claude-profiles`; renamed the same day to match the command name. Renaming changes every profile's Keychain service hash, which was safe only because no profile had logged in yet. **Do not rename again casually**: existing users would have to log in again for every profile.

Kept outside iCloud/Dropbox on purpose; `.claude.json` churn creates conflict copies in synced folders.

## 2026-09-02: Canonical config-dir string

`canon()` = absolute, no trailing slash, NFC. Because Claude Code hashes the literal env value for the Keychain service name, two spellings of the same directory are two logins. All paths flow through `profileDir()`.

## 2026-09-02: Alias shims live next to the `claudep` on PATH

`Bun.main` resolves symlinks, so "next to the script" meant "inside the git checkout" once the script moved into a repo. `aliasDir()` uses `Bun.which("claudep")` first. Shims are plain `#!/bin/sh` files that `exec bun <realpath of claudep.ts> run <name> -- "$@"`, so they survive the symlink being repointed.

## 2026-09-02: `rm` logs out first

Deleting a profile directory does not remove its Keychain item. `rm` runs `claude auth logout` under the profile so the token is revoked server-side and the item removed, unless `--keep-login`. It also refuses any path that does not resolve under the profiles root.

## 2026-09-02: Reserved names and name regex

`NAME_RE = /^[a-z0-9][a-z0-9_-]*$/` keeps directory names shell-safe and lets a bare `claudep <name>` be sugar for `run`. Subcommand words (`init`, `list`, `rm`, …) plus `default` and `base` are reserved so the dispatcher stays unambiguous.

## Not built, on purpose

- **Per-profile `settings.json` overrides.** Would need a merge layer; `--settings <file>` on the command line already covers the rare case.
- **Auto-migration of an existing `~/.claude` login into a named profile.** Would touch the base, which is the one thing claudep promises not to do.
- **Windows / Linux credential checks.** `doctor` reports "skipped"; the rest works because `CLAUDE_CONFIG_DIR` is honoured everywhere and `.credentials.json` is per directory.

## 2026-09-02: Tests: `bun test`, a fake `claude` on PATH, injection over module mocks

The suite follows what bun-native CLIs on GitHub do (sst/opencode, oven-sh/bun, bunup, imessage-kit, OpenRouterLabs/spawn): `bun test`, a `test/` directory, a preload that sandboxes `$HOME`, and subprocess tests that spawn the real entrypoint. Command behaviour is asserted from the outside; helpers are unit-tested in process after being exported behind an `import.meta.main` guard.

Rejected: `mock.module` for `Bun.spawn`. Both opencode and spawn moved away from it because of cross-file mock pollution. `keychainHas` takes an injected spawner instead, and the CLI tests use a fake `claude` and `security` on PATH, which also proves the environment claudep hands to the child.

Dev-only dependencies (`typescript`, `@types/bun`, `@biomejs/biome`) are allowed. They do not ship: `bun install -g` of the package installs the `bin` entry and nothing else. The "never add a dependency" rule now reads "runtime dependency".

## 2026-09-02: `layout()` instead of import-time constants

`HOME`, `BASE`, `PROFILES_ROOT` used to be computed when the module loaded, which made them impossible to redirect in tests. `layout(env)` computes them on call and every helper takes what it needs as a parameter. `main()` calls it once.

## 2026-09-03: What was pulled from quinnjr/claude-code-profiles, and what was not

That project is a 1,586-line POSIX shell library (plus PowerShell and cmd ports, no tests) that sets `CLAUDE_CONFIG_DIR` to an empty directory per profile. Three things came over:

- `claudep current`: reverse-maps `CLAUDE_CONFIG_DIR` to a profile and says how it was set. Their bare `claude-profile` status did this.
- Directory pins: a `.claudep` file plus a `shell-init` hook, their `.claude-profile` and `local`/`auto` commands. Their exported-marker idea (`CLAUDE_PROFILE_AUTO_SET`) became `CLAUDEP_AUTO`: the hook manages only a variable it set itself, so a manual pin always wins. Their pure-parameter-expansion walk was kept for the same reason they gave, a fork per prompt would be felt. Naming rule: everything here says `claudep`, never `.claude-profile`.
- `claudep --version`.

Two choices made while porting. Leaving every pinned tree returns the shell to `~/.claude` rather than keeping the last profile, because a silent stale profile is worse than a visible default. And a `CLAUDE_CONFIG_DIR` inside the profiles root is now recognised as an active profile rather than a custom base, so `claudep init` and the `default` row in `list` keep pointing at `~/.claude` from inside a pinned repo.

Left behind, with the reason: empty profiles where nothing is shared (the reason claudep exists); shadowing bare `claude` with a function (overlay decision above); a `create --init` skeleton that writes `ANTHROPIC_API_KEY` into `settings.json` (against the Never list); a self-updater that runs `curl` inside the launch path (`bun install -g` already updates); three hand-ported implementations (against "keep it one file"); per-profile skill selection from a pool (right idea, conflicts with `skills/` being one shared symlink, revisit if context bloat becomes a real complaint).

## 2026-09-03: Releases, npm and GitHub Packages

Hand-written Keep a Changelog promoted by `scripts/changelog.ts`, a `bun run release` script that commits and tags, and a tag-triggered workflow that publishes. Chosen over release-please and changesets because it adds no dependency, no bot commits and no PAT, and the changelog reads like prose written for the people who run the tool. release-please reads this format unchanged if the team grows.

`npm publish` runs through the npm CLI on Node 24 in the workflow because `bun publish` has no trusted-publishing support (oven-sh/bun#22423 open, the PR closed unmerged). Trusted publishing was the deciding factor: classic tokens are gone, granular tokens expire in ninety days, and OIDC needs neither.

The package is named `@bordoni/claudep` on both registries. GitHub Packages only accepts scoped names, and one name in both places avoids a second identity to explain; the bin is still `claudep`. GitHub Packages is a best-effort mirror published with `GITHUB_TOKEN` and `continue-on-error`, because it needs a token even to install a public package and so cannot be the main channel.

Not built: a Node launcher shim in `bin/` for machines without bun. `bunx @bordoni/claudep` and `bun add -g @bordoni/claudep` cover the intended audience; revisit if `npm install -g` users report `env: bun: No such file or directory`.

Actions in `release.yml` are pinned to commit SHAs because that workflow holds `id-token: write` and `packages: write`. `ci.yml` keeps tag pins.
