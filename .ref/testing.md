# Testing claudep

`bun run check` is the gate: typecheck, lint, then the suite. CI runs the same three steps on every push and pull request (`.github/workflows/ci.yml`), with the tests on both macOS and Linux. The suite takes about four seconds locally.

```bash
bun install              # dev tooling only: typescript, @types/bun, @biomejs/biome
bun run check            # what CI runs
bun test --watch         # while editing
bun run test:coverage    # text table plus coverage/lcov.info
bun run lint:fix         # let Biome format and fix what it can
```

## How the suite is built

| Piece | Job |
|---|---|
| `bunfig.toml` | Points `bun test` at `test/preload.ts` and configures coverage. |
| `test/preload.ts` | Runs before any test file. Moves `HOME` and the XDG dirs to a throwaway directory, sets `NO_COLOR=1`, and deletes every `ANTHROPIC_*` and `CLAUDE_*` variable from the shell. Nothing under test can reach the real `~/.claude`, `~/.claudep` or keychain. |
| `test/lib/home.ts` | `using h = fakeHome()` builds a realistic `~/.claude` (shared files, private files, a `.claude.json` with seedable keys and identity that must never be copied) and removes it when the block ends. |
| `test/lib/cli.ts` | `runCli(args, { home })` spawns the real `claudep.ts` with a fake `$HOME` and a bin dir prepended to PATH, and returns `{ exitCode, stdout, stderr }`. |
| `test/lib/fake-claude.ts` | Stands in for `claude`. Reads and writes `<config dir>/.fake-login.json` for `auth status/login/logout`, prints a fake `--version`, and logs any other invocation to `$FAKE_CLAUDE_LOG` with the `CLAUDE_CONFIG_DIR` it saw. `FAKE_CLAUDE_EXIT` sets its exit code. |
| `test/lib/fake-security.ts` | Stands in for macOS `security`. Exits 0 when the requested service is listed in `$FAKE_KEYCHAIN`. |

Test files:

- `test/unit.test.ts`: pure helpers imported from `claudep.ts` (`canon`, `layout`, `keychainService`, `parseFlags`, `formatTable`, `parseAuthStatus`, name rules).
- `test/fs.test.ts`: `sharedItems`, `link`, `seedGlobalJson` against a fake home, in process.
- `test/keychain.test.ts`: `keychainHas` with an injected spawner, plus one real `security` call gated on macOS.
- `test/cli.test.ts`: every command as a subprocess. This is where behaviour lives; add a case here when you change a command.
- `test/changelog.test.ts`: the Keep a Changelog helpers in `scripts/changelog.ts` (`extract`, `promote`, link rewriting) plus one run of the CLI, and a check that the real `CHANGELOG.md` parses.
- `test/shell.test.ts`: runs the hook printed by `shell-init` in a real `bash`, and in `zsh` when `Bun.which("zsh")` finds one (macOS runners have it, Ubuntu runners do not). Checks entering and leaving pinned trees, the manual-pin rule, the empty-pin cancel, the missing-profile warning, and that the hook and `claudep resolve` agree.

`claudep.ts` exports its helpers and guards the entrypoint with `import.meta.main`, so importing it in a test runs nothing.

## What the fake claude proves and what it cannot

It proves that claudep passes the right `CLAUDE_CONFIG_DIR` and arguments, reads `auth status --json` correctly, and calls `auth logout` before deleting a profile. It cannot prove that the real Claude Code isolates logins per config dir. That fact was verified against the binary (see `claude-code-internals.md`) and is re-checked by hand:

```bash
claudep init smoke --no-login
claudep smoke auth login                  # any account, in the browser
claudep list                              # two rows, different logins
security find-generic-password -s "Claude Code-credentials-$(printf '%s' "$HOME/.claudep/smoke" | shasum -a 256 | cut -c1-8)" -a "$USER" >/dev/null && echo isolated-keychain-item
claudep smoke -p "reply with ok"
claudep rm smoke --yes                    # logs out first; the keychain item disappears
```

Run that after a Claude Code major update. The `shasum` line matches only for ASCII paths; `claudep doctor` prints the exact service name it expects.

## Coverage

Coverage counts only code that ran in the test process. The subprocess tests exercise most of `claudep.ts` but do not show up in the table, so the reported line coverage understates the real number. There is no threshold gate.

## Install check

```bash
S=$(mktemp -d) && BUN_INSTALL="$S" bun install -g github:bordoni/claudep && "$S/bin/claudep" list; rm -rf "$S"
```

Do not run the plain `bun install -g` on the author's machine: `~/.bun/bin` precedes `~/.dotfiles/bin` on PATH and would shadow the symlink.

## Gotcha log

- bun's `os.homedir()` reads `getpwuid()` and ignores `$HOME`. `claudep.ts` reads `process.env.HOME` first for this reason; without it the preload sandbox silently does nothing.
- `Bun.main` is the symlink-resolved path. Use `Bun.which("claudep")` for the PATH location (alias shims) and `realpathSync(Bun.main)` for the file itself.
- Column padding: the table pads every cell, including the last column, so assert on `line.trimEnd()`.
- `sed s/claude-profile/claudep/g` once rewrote `.claude-profiles` to `.claudeps`. Grep for collateral matches before global renames.
- `grep -aoE` with context on the Claude Code binary times out; `claude-code-internals.md` has the `Buffer.indexOf` approach.
- zsh's pipe status array is `$pipestatus`, not `$PIPESTATUS`.
