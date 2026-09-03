# claudep working agreement

This is the source of truth for anyone changing this repository, human or agent. `CLAUDE.md` points here and the detail lives in [`.ref/`](./.ref/). Read this file end to end. Open `.ref/` files when the index below says so.

## What this is

A single-file bun CLI, [`claudep.ts`](./claudep.ts), that runs Claude Code under separate accounts on one machine. It creates named profiles under `~/.claudep/<name>`, points Claude Code at them via `CLAUDE_CONFIG_DIR`, symlinks shared config back into `~/.claude`, and leaves credentials and account state per profile.

- Zero runtime dependencies. Strict TypeScript, executed directly by bun (`#!/usr/bin/env bun`). No build step. Dev tooling only: `typescript`, `@types/bun`, `@biomejs/biome`.
- macOS-first: the Keychain check is darwin-only and degrades to "skipped" elsewhere; everything else is portable.
- Installed either by symlinking `claudep.ts` onto PATH (how the author runs it: `~/.dotfiles/bin/claudep`) or with `bun install -g github:bordoni/claudep` (the `bin` entry in `package.json`).
- `~/.claude` is never modified. It is the implicit `default` profile.

## Reference index

| File | Read it when |
|---|---|
| [`.ref/claude-code-internals.md`](./.ref/claude-code-internals.md) | You are debugging login isolation, a new Claude Code version moved something, or you need to re-verify a claim against the binary. |
| [`.ref/shared-vs-private.md`](./.ref/shared-vs-private.md) | You are changing `SHARED_FILES`, `SHARED_DIRS`, `KNOWN_PRIVATE` or `SEED_KEYS`, or `claudep doctor` reports an unclassified file. |
| [`.ref/testing.md`](./.ref/testing.md) | You changed `claudep.ts`, the shell hook, or anything under `test/`. How the suite is built, what the fake `claude` proves, and the checks that still need a human. |
| [`.ref/releasing.md`](./.ref/releasing.md) | You are cutting a release, the release workflow failed, or you need the one-time npm and GitHub Packages setup. |
| [`.ref/directory-pins.md`](./.ref/directory-pins.md) | You are touching `.claudep` pins, `resolvePin()`, `claudep current` or the shell hook. The TypeScript and the shell must agree. |
| [`.ref/prior-art.md`](./.ref/prior-art.md) | Someone asks whether to add a feature another tool has, or how other bun CLIs test and release. |
| [`.ref/tooling-gotchas.md`](./.ref/tooling-gotchas.md) | Before running non-trivial shell commands here: inline scripts lose braces, SSH to GitHub times out, zsh differs from bash. |
| [`.ref/writing.md`](./.ref/writing.md) | You are writing or editing prose a person reads: README, this file, `.ref/`, help text, CLI messages. |
| [`.ref/design-decisions.md`](./.ref/design-decisions.md) | You are tempted to restructure profiles, rename paths, or add a feature that was already considered. |

## Commands

```bash
bun install                         # dev tooling only
bun run check                       # typecheck + lint + tests; this is what CI runs
bun test --watch                    # while editing
bun run lint:fix                    # let Biome format and fix
bun claudep.ts help                 # run from the checkout without installing
claudep doctor                      # symlink, keychain and classification check for all profiles
```

## Rules

1. Keep the tool one file. New behaviour goes into `claudep.ts`, tests into `test/`, documentation into `.ref/`.
2. Every shared item is an explicit allowlist entry with a reason recorded in `.ref/shared-vs-private.md`. Unknown files stay private by default.
3. A profile name must match `NAME_RE` and must not be in `RESERVED`; both live near the top of `claudep.ts`.
4. The string handed to `CLAUDE_CONFIG_DIR` must be canonical (absolute, no trailing slash, NFC) because Claude Code hashes it for the Keychain service name. Always go through `profileDir()` / `canon()`.
5. Any change to what `init` links or seeds must be reflected in `doctor`, which is the user's only way to see drift.
6. Update `README.md` (user-facing), the `help()` text and `test/cli.test.ts` together when a command or flag changes. A change to the shell hook also updates `resolvePin()` and `test/shell.test.ts`; the two must agree.
7. Every change a user could notice gets a line under `[Unreleased]` in `CHANGELOG.md` in the same change. CI enforces it for pull requests that touch `claudep.ts`.
8. Helpers take their inputs as parameters and are exported; commands get a `Layout` from `layout()`. Without that the tests cannot redirect paths and the `$HOME` sandbox does nothing.

## Never

1. **Never add a runtime dependency.** Users install one file. Dev-only tooling is fine and lives in `devDependencies`. Prefer `Bun.*` APIs; use `node:*` only where bun has no equivalent (symlinks, lstat).
2. **Never write Python** or shell-heavy helpers. Scripts and tooling are bun + TypeScript. Two-line `#!/bin/sh` shims that only `exec` something are fine.
3. **Never print, log, or store credential material.** Keychain checks use `security find-generic-password` for its exit code only, with stdout and stderr discarded.
4. **Never overwrite a real file or directory inside a profile.** `link()` refuses and reports; keep that behaviour.
5. **Never touch `~/.claude` from `rm`** or any other command. `rm` unlinks symlinks inside the profile dir and refuses paths outside the profiles root.
6. **Never turn the shared allowlist into a denylist.** Org-pushed files such as `remote-settings.json` must not be able to leak across accounts because a future Claude Code version added something.
7. **Never write alias shims into this repo.** They go next to the `claudep` found on PATH (`aliasDir()`), because `Bun.main` resolves symlinks and would otherwise point into the checkout.
8. **Never commit anything from `~/.claudep`** or reference a specific person's profile in code.
9. **Never suggest putting `CLAUDE_CONFIG_DIR` in a settings `env` block.** Claude Code detects the mismatch and disables features.
10. **Never put a subprocess or network call in the shell hook.** It runs on every directory change or prompt. Parameter expansion and builtins only.
11. **Never publish from a laptop after 0.1.0.** Releases are `bun run release <bump> --push`; the tag triggers the workflow, which publishes through trusted publishing. No npm tokens anywhere.
12. **Never let a test reach the real `~/.claude`, `~/.claudep`, `claude` or `security`.** Go through `test/lib`. The preload sandbox is a backstop for mistakes, and a test that needs it is already wrong.
