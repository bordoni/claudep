# Design decisions

Dated, with the alternative that lost. Reopen one only with a reason the original did not have.

## 2026-09-02 — Overlay profiles, not symmetric profiles

`~/.claude` stays untouched and is the implicit `default` profile. Extra accounts are thin directories that symlink back into it.

Rejected: demoting `~/.claude` to a shared base and making *every* account a named profile. Cleaner mental model, but it forces a migration and a re-login for every user on day one, and it changes what plain `claude` does. Overlay means a teammate adopts claudep by running one `init`.

## 2026-09-02 — `projects/` is shared

Sessions and auto-memory follow the user, not the account. Rejected: per-profile `projects/` for stricter isolation. Would split memory and `--resume` and duplicate ~600 MB. Users who need the split can remove `projects` from `SHARED_DIRS` locally.

## 2026-09-02 — `CLAUDE_CONFIG_DIR`, not `CLAUDE_CODE_OAUTH_TOKEN`

Rejected: one token per account from `claude setup-token`, exported per shell. It avoids the config-dir mechanism entirely but tokens cannot use claude.ai connectors or Remote Control, expire yearly, and end up in dotfiles. Once it was verified that Keychain entries are namespaced per config dir (see `claude-code-internals.md`), the config-dir approach had no remaining downside.

## 2026-09-02 — Profiles root is `~/.claudep`

Originally `~/.claude-profiles`; renamed the same day to match the command name. Renaming changes every profile's Keychain service hash, which was safe only because no profile had logged in yet. **Do not rename again casually**: existing users would have to log in again for every profile.

Kept outside iCloud/Dropbox on purpose; `.claude.json` churn creates conflict copies in synced folders.

## 2026-09-02 — Canonical config-dir string

`canon()` = absolute, no trailing slash, NFC. Because Claude Code hashes the literal env value for the Keychain service name, two spellings of the same directory are two logins. All paths flow through `profileDir()`.

## 2026-09-02 — Alias shims live next to the `claudep` on PATH

`Bun.main` resolves symlinks, so "next to the script" meant "inside the git checkout" once the script moved into a repo. `aliasDir()` uses `Bun.which("claudep")` first. Shims are plain `#!/bin/sh` files that `exec bun <realpath of claudep.ts> run <name> -- "$@"`, so they survive the symlink being repointed.

## 2026-09-02 — `rm` logs out first

Deleting a profile directory does not remove its Keychain item. `rm` runs `claude auth logout` under the profile so the token is revoked server-side and the item removed, unless `--keep-login`. It also refuses any path that does not resolve under the profiles root.

## 2026-09-02 — Reserved names and name regex

`NAME_RE = /^[a-z0-9][a-z0-9_-]*$/` keeps directory names shell-safe and lets a bare `claudep <name>` be sugar for `run`. Subcommand words (`init`, `list`, `rm`, …) plus `default` and `base` are reserved so the dispatcher stays unambiguous.

## Not built, on purpose

- **Per-profile `settings.json` overrides.** Would need a merge layer; `--settings <file>` on the command line already covers the rare case.
- **Auto-migration of an existing `~/.claude` login into a named profile.** Would touch the base, which is the one thing claudep promises not to do.
- **Windows / Linux credential checks.** `doctor` reports "skipped"; the rest works because `CLAUDE_CONFIG_DIR` is honoured everywhere and `.credentials.json` is per directory.
