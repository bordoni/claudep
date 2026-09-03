# Testing claudep

There is no automated test suite. Verification is a scripted manual cycle that must be run after any change to `claudep.ts`. Every step below was run on 2026-09-02 against Claude Code 2.1.259 and bun 1.4.0.

## 1. Strict typecheck

bun does not typecheck. Use `tsc` in a scratch directory so the repo stays dependency-free:

```bash
S=$(mktemp -d) && cd "$S" && bun add -d bun-types typescript >/dev/null \
  && cp ~/workspace/claudep/claudep.ts . \
  && printf '{"compilerOptions":{"strict":true,"noUncheckedIndexedAccess":true,"target":"esnext","module":"esnext","moduleResolution":"bundler","skipLibCheck":true,"noEmit":true,"types":["bun-types"]},"files":["claudep.ts"]}' > tsconfig.json \
  && bunx tsc -p tsconfig.json; echo "tsc exit=$?"; rm -rf "$S"
```

Expect `tsc exit=0` with no output.

## 2. Smoke cycle (no login needed)

```bash
claudep init smoke --no-login          # only symlinks + seeded .claude.json should appear
ls -la ~/.claudep/smoke
claudep doctor smoke                   # 11 shared items on the author's machine; no problems
claudep smoke auth status --text       # "Not logged in", exit 1  → profile is isolated
claude auth status --json              # base account still logged in, unchanged
claudep list                           # default = yes, smoke = no
claudep env smoke                      # export CLAUDE_CONFIG_DIR='/Users/<you>/.claudep/smoke'
claudep status smoke --json
claudep nope                           # error: no profile "nope"
claudep init default                   # error: reserved word
claudep rm smoke --yes --keep-login    # dir gone; ~/.claude and ~/.claude/projects intact
```

Check base integrity after `rm`: `ls ~/.claude/projects | wc -l` and `wc -c ~/.claude/CLAUDE.md` unchanged.

## 3. Alias shim

```bash
claudep alias enterprise eclaude       # shim lands next to the `claudep` on PATH, not in the repo
cat "$(dirname "$(which claudep)")/eclaude"
eclaude auth status --text
```

Confirm `git status` in the repo shows no new file.

## 4. Global install from GitHub, isolated

```bash
S=$(mktemp -d) && BUN_INSTALL="$S" bun install -g github:bordoni/claudep && "$S/bin/claudep" list; rm -rf "$S"
```

Do not run the plain `bun install -g` on the author's machine: `~/.bun/bin` precedes `~/.dotfiles/bin` on PATH and would shadow the symlink.

## 5. Login-dependent checks (needs a human in a browser)

```bash
claudep smoke auth login               # log in with any account
claudep list                           # both rows logged in, different orgs
security find-generic-password -s "Claude Code-credentials-$(printf '%s' "$HOME/.claudep/smoke" | shasum -a 256 | cut -c1-8)" -a "$USER" >/dev/null && echo isolated-keychain-item
claudep smoke -p "reply with ok"
claudep rm smoke --yes                 # logs out first; the keychain item disappears
```

The `shasum` line only matches when the path has no non-ASCII characters (claudep hashes the NFC-normalized string). `claudep doctor` prints the exact service name it expects.

## Gotcha log

- `sed s/claude-profile/claudep/g` during the rename also rewrote `.claude-profiles` to `.claudeps`. Grep for collateral matches before global renames.
- `Bun.main` is the symlink-resolved path. Use `Bun.which("claudep")` when you need the PATH location (alias shims), `realpathSync(Bun.main)` when you need the file itself (the shim's `exec` target).
- `grep -aoE '.{0,200}needle.{0,200}'` on the Claude Code binary times out; see `claude-code-internals.md` for the `Buffer.indexOf` approach.
- zsh's pipe status array is `$pipestatus`, not `$PIPESTATUS`.
