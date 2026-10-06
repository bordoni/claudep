# Shared vs. private: what a profile symlinks and what it owns

The lists live near the top of `claudep.ts`: `SHARED_FILES`, `SHARED_DIRS`, `KNOWN_PRIVATE`, `SEED_KEYS`. This file records **why** each entry is where it is, so changes are deliberate.

## Principle: explicit allowlist

Sharing is opt-in per item. Anything not listed stays inside the profile directory, and `doctor` reports it as *unclassified* so a human decides. The alternative (share everything except a denylist) fails open: the day Claude Code adds a new org-scoped file, it would silently cross accounts. `remote-settings.json` and `policy-limits.json` are exactly such files; they are pushed by the logged-in org's policy and must never reach another account's session.

## Shared (symlinked into every profile)

| Item | Why it is safe to share |
|---|---|
| `CLAUDE.md` and every top-level `*.md` | Personal instructions; `@RTK.md`-style imports resolve relative to the file, so sibling `.md` files must travel together. A name in `KNOWN_PRIVATE` is skipped: Claude Code 2.1.280 keeps `loop.md` per instance. |
| `settings.json` | Hooks, permissions, statusline, `enabledPlugins`, model, effort. User preferences, not identity. Both profiles write it; same as two terminals. |
| `keybindings.json`, `statusline-command.sh` | Pure preference. Hook and statusline commands reference absolute paths under `~/.claude`, so they keep working. |
| `hooks/`, `skills/`, `commands/`, `agents/` | Content the user authored. Nothing account-specific. |
| `rules/` | User-level rules (`~/.claude/rules/*.md`), loaded before project rules. Instructions the user wrote. Added 2026-09-07 against Claude Code 2.1.263. |
| `output-styles/` | User-level output styles, markdown the user wrote. Same date. |
| `themes/` | Custom theme JSON. The shared `settings.json` names one as `theme: custom:<slug>`, so a profile without this directory has a preference that points nowhere. Same date. |
| `workflows/` | Workflow scripts for the Workflow tool, authored by the user. Same date. |
| `plugins/` | ~200 MB of marketplaces and caches keyed by `enabledPlugins` in the shared `settings.json`; must stay in sync with it. |
| `plans/` | Plan-mode files; harmless, useful across accounts. Claude Code 2.1.280 added `plans` to its runtime-state list, which only governs what it copies into a sandbox. Kept shared on 2026-09-30 for the same reason as `projects/`: nothing inside carries identity. |
| `projects/` | Session transcripts **and auto-memory** (`projects/<slug>/memory/MEMORY.md`). ~600 MB on the author's machine. Claude Code lists it as runtime state, but nothing inside carries identity, and sharing keeps `--resume` and memory working from either account. Decided with the user on 2026-09-02. |

## Private (real files inside each profile)

| Item | Why |
|---|---|
| `.claude.json`, `.claude.json.backup` | `oauthAccount`, `userID`, user-scope `mcpServers`, per-cwd `projects[...]` trust and `allowedTools`. This *is* the account. |
| `.credentials.json` | The credential store on Linux and Windows, plain JSON. `doctor` checks that it exists there and never reads it. |
| `remote-settings.json`, `policy-limits.json` | Pushed by the org. Leaking these applies one org's policy to another's session. |
| `history.jsonl`, `sessions/`, `todos/`, `tasks/`, `jobs/`, `scheduled-tasks/`, `scheduled_tasks.json`, `teams/` | Prompt history, task and agent-team state tied to one login. Claude Code reads `teams/` as `join(configDir, "teams")`. |
| `uploads/`, `usage-data/`, `mcp-discovery-cache/`, `mcp-skill-archives/`, `daemon.json`, `launch.json`, `seed-admin` | Runtime state seen in the 2.1.263 binary's config-dir namespace list and daemon code. Regenerated per instance. |
| `shell-snapshots/`, `file-history/`, `statsig/`, `telemetry/`, `cache/`, `debug/`, `backups/`, `logs/`, `ide/`, `daemon*`, `session-env/`, `paste-cache/`, `chrome/`, `feedback/`, `local/`, `stats-cache.json`, `mcp-needs-auth-cache.json`, `.last-cleanup`, `.last-update-result.json`, `daemon-auth-*` | Caches and runtime scratch. Cheap to regenerate, pointless to share. |
| `settings.local.json`, `.config.json`, `.DS_Store`, `Thumbs.db`, `desktop.ini` | Machine-local or noise. The last two are Windows Explorer's. |
| `state/`, `policy-limits.json.stamp.json`, `policy-limits.json.signature.json`, `policy-limits.json.signature-iat.json`, `remote-settings.json.signature.json`, `remote-settings.json.signature-iat.json`, `remote-settings-consent.json`, `remote-settings-helper-consent`, `hfi-auth.json` | Added to Claude Code's runtime-state list by 2.1.280. The stamp file records which account or key vouched for the cached org policy (`identity`, `kind`, `sha`) and is deleted on logout; the signature files sign the same caches. `state/` holds MCP discovery verdicts and device consent records. All identity- or org-scoped. |
| `shares/`, `storage-v2/`, `daemon.lock`, `server.lock`, `computer-use.lock`, `server-sessions.json`, `active-time.json`, `gh-pr-status-cache.json`, `image-cache/`, `file-transfers/`, `downloads/`, `scratch/`, `traces/`, `startup-perf/`, `feedback-bundles/`, `ccr/`, `bridge-spawn/`, `local-settings/`, `project-settings/`, `remote/`, `systemd/`, `api-dumps/`, `dump-prompts/`, `antproto.json`, `.cc-writes/`, `loop.md` | The rest of the 2.1.280 additions: locks, caches, per-instance scratch and debug output. `.cc-writes` is the temporary directory behind Claude Code's atomic file writes. |

## Seeded into a new profile's `.claude.json`

`SEED_KEYS`: `hasCompletedOnboarding`, `lastOnboardingVersion`, `theme`, `editorMode`, `preferredNotifChannel`, `shiftEnterKeyBindingInstalled`, `autoUpdates`, `installMethod`. Only keys present in the base are copied. Purpose: skip first-run onboarding. With `--copy-mcp`, the top-level `mcpServers` object is copied too (work MCP servers usually belong in the work profile). Never copied: `oauthAccount`, `userID`, `projects`, any cache.

The base `.claude.json` lives at `~/.claude.json` when `CLAUDE_CONFIG_DIR` is unset in the caller's shell, otherwise inside that dir. `BASE_GLOBAL_JSON` handles both.

`claudep.env` is claudep's own per-profile file of variables (see `design-decisions.md`, 2026-10-05). It is in `KNOWN_PRIVATE` so `doctor` never calls it a stray, and it never exists in the base.

## Classifying a new file

When `doctor` reports an unclassified base item, ask in order:

1. Does it carry identity, tokens, org policy, or per-account entitlements? → `KNOWN_PRIVATE`.
2. Is it session or cache state that any instance regenerates? → `KNOWN_PRIVATE`.
3. Is it something the user authored and would expect in every account? → `SHARED_FILES` / `SHARED_DIRS`, and add a row above.
4. Unsure → leave it unclassified. Private-by-default is the safe failure.

iCloud conflict copies such as `settings 2.json` are noise from the author's synced `~/.claude`; do not add them to any list. `settings.json.bak` in the author's base is not written by Claude Code (the 2.1.263 binary never mentions it) and stays unclassified for the same reason.

`routines/` appears in the 2.1.263 binary's list of config-dir subdirectories next to `workflows` and `rules`. By 2.1.280 it is clear what it is: user-authored routine definitions, seeded into sandboxes like `commands/`, with run state kept in `routines/.state/`. Sharing the directory would share that run state across accounts, so it stays in neither list. Revisit if a user asks for routines in every profile; the answer is probably a per-item link that skips `.state/`.

## Synced skills and plugins inside the shared directories

Since Claude Code 2.1.273 a terminal session copies the skills and plugins enabled on the claude.ai account into `skills/synced/<orgUuid>_<accountUuid>/` and `plugins/synced/<orgUuid>_<accountUuid>/`, with a `manifest.json` and a `.bucket-<same id>` marker. Both parents are shared, and the per-account folder keeps two accounts' copies apart, so nothing is mixed. The switches that turn it off, `syncClaudeAiSkills` and `syncClaudeAiPlugins`, live in the shared `settings.json` and cannot differ per profile.

A synced skill that is replaced or removed moves to `skills/.trash/<ms>-<pid>-<random>/` (`plugins/.trash/` likewise). On the author's machine eight `docs` and `google-workspace` copies landed there between 2026-09-22 and 09-28. Five share one pid within three hours, which is one long session re-syncing an updated skill, not two accounts pruning each other. Only one of the two accounts has `docs` in its synced folder. Checked 2026-09-30; no change to claudep.

`plugins/known_marketplaces_claudeai.json` lists marketplaces hosted on claude.ai for the account that last wrote it. It sits inside the shared `plugins/`, so a second account sees the first one's list. It holds marketplace names, no credentials; accepted.

## The pin file is not a profile item

`.claudep` files live in repositories and directory trees, never inside a profile or the base. They are read by the shell hook and by `claudep resolve`. Nothing in `SHARED_FILES` or `KNOWN_PRIVATE` refers to them, and `~/.claudep` the directory is skipped by the upward walk because only regular files count.

## Location of profiles

`~/.claudep` (override with `CLAUDE_PROFILES_DIR`) is in the real home directory on purpose. `.claude.json` is rewritten constantly; inside iCloud or Dropbox that produces conflict copies.
