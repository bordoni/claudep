# Tooling gotchas on the author's machine

Things that cost time in this repo's history. Most are about the environment an agent runs in here, not about claudep itself. Read this before running anything non-trivial through a shell.

## Inline code through the shell loses braces

A command-rewriting hook sits in front of every Bash call in the author's Claude Code setup. Twice it stripped `${...}` and `{...}` from inline `bun -e '...'` scripts, silently turning `${cmd}` into `$cmd` and `${PIN_FILE} file` into `$PIN_FILEfile`. The file then still parsed because the damage landed inside template literals, and only a test caught it.

Rule: never pass code with braces inline. Write the script to a file with a quoted heredoc (`cat > x.ts <<'EOF'`) and run `bun x.ts`. Heredocs came through intact every time. `sed` with no braces is fine.

## Shell

- zsh, not bash. The pipe status array is `$pipestatus` (lowercase); `$PIPESTATUS` is empty. Unquoted `$VAR` does not word-split, so build file lists with `set -A` arrays or quote each path.
- `ls` is aliased to eza and once hung on a directory with `node_modules`; use `/bin/ls` in scripts.
- `timeout` does not exist on macOS. Use the tool's own timeout or a `until ... do sleep; done` loop.
- `grep` is `ugrep`; regexes with wide `.{0,200}` context fail with "exceeds complexity limits". Use `/usr/bin/grep` or `Buffer.indexOf` in bun.

## GitHub access

- SSH to github.com times out intermittently from this machine. `gh api` always works. When `git push` over SSH fails, push over HTTPS with a one-off credential helper:

  ```bash
  git -c "credential.helper=!gh auth git-credential" push https://github.com/bordoni/claudep.git main
  ```

  Then `git fetch https://... main && git update-ref refs/remotes/origin/main FETCH_HEAD` so `git status` stops saying "ahead".
- `gh run list` and `gh run watch` need `--repo bordoni/claudep` when the working directory is not the checkout.
- The `gh` token has no `read:packages`, so the GitHub Packages mirror cannot be listed or installed from here until `gh auth refresh -h github.com -s read:packages` is run.

## bun

- `os.homedir()` ignores `$HOME`; the tests only sandbox because `claudep.ts` reads `process.env.HOME` first.
- `Bun.main` is the symlink-resolved path. `Bun.which("claudep")` gives the PATH location.
- `bun publish` has no trusted-publishing support, so the release workflow publishes with the npm CLI.
- `bunx <pkg>` from a scratch directory prints "Saved lockfile" but writes it into bun's cache, not the current directory.
- `bun test` coverage counts only in-process code; subprocess tests do not show in the table.

## npm

- 2FA is `auth-and-writes`, so a manual `npm publish` needs a code. Trusted publishing from the workflow needs none.
- `npm view <pkg>` returns 404 until the package exists; a fresh publish is visible within seconds. A 404 minutes after "I published" means the publish did not happen. Check `~/.npm/_logs` for an `argv "publish"` line.
- `npm publish` warns that `bin` was "cleaned" from `./claudep.ts` to `claudep.ts`. Harmless; `npm pkg fix` would change the file, and that change must not land between a tag and its publish.

## Claude Code binary

- The native binary is ~200 MB of minified JS. `grep -aoE` with context times out; `Buffer.indexOf` finds a string in seconds. See `claude-code-internals.md`.
