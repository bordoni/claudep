# Shared vs. private: what a profile symlinks and what it owns

The lists live near the top of `claudep.ts`: `SHARED_FILES`, `SHARED_DIRS`, `KNOWN_PRIVATE`, `SEED_KEYS`. This file records **why** each entry is where it is, so changes are deliberate.

## Principle: explicit allowlist

Sharing is opt-in per item. Anything not listed stays inside the profile directory, and `doctor` reports it as *unclassified* so a human decides. The alternative (share everything except a denylist) fails open: the day Claude Code adds a new org-scoped file, it would silently cross accounts. `remote-settings.json` and `policy-limits.json` are exactly such files; they are pushed by the logged-in org's policy and must never reach another account's session.

## Shared (symlinked into every profile)

| Item | Why it is safe to share |
|---|---|
| `CLAUDE.md` and every top-level `*.md` | Personal instructions; `@RTK.md`-style imports resolve relative to the file, so sibling `.md` files must travel together. |
| `settings.json` | Hooks, permissions, statusline, `enabledPlugins`, model, effort. User preferences, not identity. Both profiles write it; same as two terminals. |
| `keybindings.json`, `statusline-command.sh` | Pure preference. Hook and statusline commands reference absolute paths under `~/.claude`, so they keep working. |
| `hooks/`, `skills/`, `commands/`, `agents/` | Content the user authored. Nothing account-specific. |
| `plugins/` | ~200 MB of marketplaces and caches keyed by `enabledPlugins` in the shared `settings.json`; must stay in sync with it. |
| `plans/` | Plan-mode files; harmless, useful across accounts. |
| `projects/` | Session transcripts **and auto-memory** (`projects/<slug>/memory/MEMORY.md`). ~600 MB on the author's machine. Claude Code lists it as runtime state, but nothing inside carries identity, and sharing keeps `--resume` and memory working from either account. Decided with the user on 2026-09-02. |

## Private (real files inside each profile)

| Item | Why |
|---|---|
| `.claude.json`, `.claude.json.backup` | `oauthAccount`, `userID`, user-scope `mcpServers`, per-cwd `projects[...]` trust and `allowedTools`. This *is* the account. |
| `.credentials.json` | Fallback credential store on non-macOS. |
| `remote-settings.json`, `policy-limits.json` | Pushed by the org. Leaking these applies one org's policy to another's session. |
| `history.jsonl`, `sessions/`, `todos/`, `tasks/`, `jobs/`, `scheduled-tasks/` | Prompt history and task state tied to one login. |
| `shell-snapshots/`, `file-history/`, `statsig/`, `telemetry/`, `cache/`, `debug/`, `backups/`, `logs/`, `ide/`, `daemon*`, `session-env/`, `paste-cache/`, `chrome/`, `feedback/`, `local/`, `stats-cache.json`, `mcp-needs-auth-cache.json`, `.last-cleanup`, `.last-update-result.json`, `daemon-auth-*` | Caches and runtime scratch. Cheap to regenerate, pointless to share. |
| `settings.local.json`, `.config.json`, `.DS_Store` | Machine-local or noise. |

## Seeded into a new profile's `.claude.json`

`SEED_KEYS`: `hasCompletedOnboarding`, `lastOnboardingVersion`, `theme`, `editorMode`, `preferredNotifChannel`, `shiftEnterKeyBindingInstalled`, `autoUpdates`, `installMethod`. Only keys present in the base are copied. Purpose: skip first-run onboarding. With `--copy-mcp`, the top-level `mcpServers` object is copied too (work MCP servers usually belong in the work profile). Never copied: `oauthAccount`, `userID`, `projects`, any cache.

The base `.claude.json` lives at `~/.claude.json` when `CLAUDE_CONFIG_DIR` is unset in the caller's shell, otherwise inside that dir. `BASE_GLOBAL_JSON` handles both.

## Classifying a new file

When `doctor` reports an unclassified base item, ask in order:

1. Does it carry identity, tokens, org policy, or per-account entitlements? → `KNOWN_PRIVATE`.
2. Is it session or cache state that any instance regenerates? → `KNOWN_PRIVATE`.
3. Is it something the user authored and would expect in every account? → `SHARED_FILES` / `SHARED_DIRS`, and add a row above.
4. Unsure → leave it unclassified. Private-by-default is the safe failure.

iCloud conflict copies such as `settings 2.json` are noise from the author's synced `~/.claude`; do not add them to any list.

## Location of profiles

`~/.claudep` (override with `CLAUDE_PROFILES_DIR`) is in the real home directory on purpose. `.claude.json` is rewritten constantly; inside iCloud or Dropbox that produces conflict copies.
