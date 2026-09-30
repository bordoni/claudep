# Claude Code internals that claudep depends on

Verified against the native macOS binary **Claude Code 2.1.280** (`~/.local/share/claude/versions/2.1.280`, arm64) on 2026-09-30 by extracting minified source around known strings. Earlier passes: 2.1.259 on 2026-09-02, 2.1.263 on 2026-09-07. Minified names change between builds (`Se()` is `we()` in 2.1.280, the runtime-state set `Bi` is `ca`); the snippets below keep the 2.1.263 names unless a section says otherwise. Sections 3, 7 and 9 changed in 2.1.280; sections 10 to 12 are new. Re-verify after major updates; the "How to re-verify" section shows how.

## 1. `.claude.json` moves inside the config dir

```js
function dYt(){let t=`.claude${F1()}.json`;return S(process.env.CLAUDE_CONFIG_DIR||ct(),t)}
```

`ct()` is `homedir()`. So with `CLAUDE_CONFIG_DIR` unset the global state file is `~/.claude.json`; with it set, it is `$CLAUDE_CONFIG_DIR/.claude.json`. This file holds `oauthAccount`, user-scope `mcpServers`, per-cwd `projects[...]` trust and allowed tools, and onboarding flags. Older docs saying it always stays in `$HOME` are wrong for this version. `F1()` is an empty suffix in normal builds; staging builds produce `.claude-<suffix>.json`, which the runtime-state filter matches with `/^\.claude(-[a-z-]+)?\.json(\.backup)?$/`. A legacy `.config.json` inside the config dir is used instead when it exists (`Lt()`), which is why `.config.json` is known-private.

## 2. Keychain service name is namespaced per config dir

```js
function HR(n=""){let e=process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
  t=e!==void 0?!e:!process.env.CLAUDE_CONFIG_DIR,
  r=e!==void 0?e.normalize("NFC"):Se(),
  c=t?"":`-${a("sha256").update(r).digest("hex").substring(0,8)}`;
  return`Claude Code${Kt().OAUTH_FILE_SUFFIX}${n}${c}`}
```

- `Se()` is `(CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")).normalize("NFC")`.
- Result: `Claude Code-credentials` for the default dir, `Claude Code-credentials-<sha256(dir)[0:8]>` otherwise. The hash is over the **literal env string**, so `/a/b` and `/a/b/` are different accounts. claudep's `canon()` exists for this reason; `keychainService()` mirrors the formula.
- `CLAUDE_SECURESTORAGE_CONFIG_DIR` overrides which directory is hashed without moving files. Not used by claudep.
- The item is stored with `security add-generic-password -U -a <username> -s <service>`, so `doctor` checks with `-a $USER`.
- GitHub issue #20553 (all config dirs sharing one Keychain entry) describes builds before 2.1.144 and does not apply.

## 3. Claude Code's own runtime-state list

When Claude Code snapshots a host config dir into a sandbox it excludes this set (`var Bi=new Set([...])`, named `Fi` in 2.1.259):

```
.claude.json  .claude.json.backup  .credentials.json  projects  sessions  todos
shell-snapshots  statsig  file-history  history.jsonl  ide  logs  backups
.session_ingress_token
```

This is Anthropic's own boundary between config and per-instance state and is the backbone of `KNOWN_PRIVATE`. claudep deliberately shares `projects/` anyway; see `shared-vs-private.md`.

**2.1.280 (2026-09-30).** The set is `ca` and has grown. It now also holds `policy-limits.json`, `remote-settings.json`, their `.signature.json` and `.signature-iat.json` companions, `policy-limits.json.stamp.json`, `remote-settings-helper-consent`, `remote-settings-consent.json`, `hfi-auth.json`, `daemon`, `jobs`, `teams`, `usage-data`, `shares`, `state`, `uploads`, `feedback`, `feedback-bundles`, `plans`, `telemetry`, `dump-prompts`, `debug`, `traces`, `startup-perf`, `cache`, `mcp-discovery-cache`, `mcp-needs-auth-cache.json`, `gh-pr-status-cache.json`, `tasks`, `local`, `antproto.json`, `ccr`, `session-env`, `bridge-spawn`, `active-time.json`, `loop.md`, `server-sessions.json`, `image-cache`, `paste-cache`, `file-transfers`, `mcp-skill-archives`, `stats-cache.json`, `computer-use.lock`, `server.lock`, `api-dumps`, `chrome`, `downloads`, `local-settings`, `project-settings`, `remote`, `scratch`, `seed-admin`, `storage-v2`, `systemd` and `.cc-writes` (`var DL=".cc-writes"`, the temporary directory of the atomic-write helper). `plans` and `loop.md` are the two that touch claudep's shared list; see `shared-vs-private.md`.

## 4. Subdirectories Claude Code knows inside the config dir (2026-09-07)

The storage layer's `userConfigDir` namespace lists these directories:

```
commands  agents  output-styles  skills  workflows  routines  themes  rules
session-env  uploads  mcp-skill-archives  usage-data  mcp-discovery-cache
```

A second list in the sandbox seeding code adds `shell-snapshots`, `plugins`, `hooks`, `scheduled_tasks.json`, `launch.json`, `daemon.json`, `policy-limits.json`. `teams` is `join(Se(), "teams")` in the read-permission code, next to `tasks`. `seed-admin` is `join(configDir, "seed-admin")` in the worktree code. `shared-vs-private.md` says which of these are shared and why; `routines` is unclassified on purpose.

## 5. Where the user `CLAUDE.md` and rules come from (2026-09-07)

```js
function yQ(e){let t=he();switch(e){case"User":return Ke(Se(),"CLAUDE.md");case"Local":return Ke(t,"CLAUDE.local.md");
  case"Project":return Ke(t,"CLAUDE.md");case"Managed":return Ke(AS(),"CLAUDE.md");case"AutoMem":return mQ()}}
function fge(){return Ke(Se(),"rules")}
```

User memory and user rules resolve from `Se()`, the config dir, only. Upstream issue #30230 (user `CLAUDE.md` loaded from both `$CLAUDE_CONFIG_DIR` and `~/.claude`) does not describe 2.1.263; under a profile the symlinked `CLAUDE.md` is loaded once. The `ide/` lock directory is the one place both are read: `[join(Se(), "ide"), join(homedir(), ".claude", "ide")]` when `CLAUDE_CONFIG_DIR` is set, so IDE extensions that write into `~/.claude/ide` still find a profile session.

## 6. `CLAUDE_CONFIG_DIR` inside settings `env` is rejected

The binary scans `projectSettings` and `localSettings` for an `env.CLAUDE_CONFIG_DIR` that differs from the active dir and, if found, returns `null` from the function that gates certain features. Since 2.1.250 a project-level `env` block cannot set the variable at all; a user-level one still can and still trips the check. Never recommend that pattern.

## 7. Background sessions and the daemon are off under a config dir (2026-09-07)

`claude daemon install` exits with "service install only supports the default config dir" when `CLAUDE_CONFIG_DIR` is set, and the launcher's daemon check (`if(process.env.CLAUDE_CONFIG_DIR||!await ole())return!1`) makes `claude --bg` run unwrapped under a profile. Nothing for claudep to do beyond the README note.

Both checks are unchanged in 2.1.280 (the install message now adds "the launchd/systemd unit is a per-user singleton"). Anthropic's agent-view docs now say a `CLAUDE_CONFIG_DIR` session gets its own supervisor, and upstream #97680 reports 2.1.280 writing `daemon.lock` into the profile but `daemon.json` and `daemon.log` into `~/.claude`, reportedly fixed in 2.1.281. Re-check this section on 2.1.285.

## 8. `CLAUDE_CODE_PROJECT_DIR_NAME` (2026-09-07)

Read only when `CLAUDE_CONFIG_DIR` is set (`Wt()`: `t.CLAUDE_CONFIG_DIR ? ROn(t.CLAUDE_CODE_PROJECT_DIR_NAME) : void 0`). It must match `/^[A-Za-z0-9_-]{1,64}$/` and not be a Windows device name, and it pins the `projects/<name>` directory for transcripts and auto memory. claudep does not set it; users who want one memory directory for every repo opened under a profile can export it themselves.

## 9. `claude auth` subcommands

```
claude auth login [--claudeai|--console] [--sso] [--email <addr>]
claude auth logout
claude auth status [--json|--text]
```

`auth status --json` fields: `loggedIn, authMethod, apiProvider, analyticsDisabled, projectsDirectory, email, orgId, orgName, subscriptionType`. No secrets. Exit code is 1 when not logged in. claudep's `authStatus()` parses this.

2.1.280 adds `configDirectory` (the resolved config dir, `we()`, since 2.1.268), and `forcedLoginMethod` and `apiKeySource` when they apply. `email`, `orgId`, `orgName` and `subscriptionType` appear only when `authMethod` is `claude.ai`; a gateway provider adds `email` alone. The subcommands are unchanged.

## 10. The Anthropic profile store and `ANTHROPIC_PROFILE` (2026-09-30)

Claude Code has a second credential location that does not follow `CLAUDE_CONFIG_DIR`: `$ANTHROPIC_CONFIG_DIR`, else `$XDG_CONFIG_HOME/anthropic`, else `~/.config/anthropic`. It holds `active_config`, `configs/<name>.json` and `credentials/<name>.json`, and `ANTHROPIC_PROFILE` picks the entry. Auth kinds are `user_oauth` and `oidc_federation`. Console sign-ins made without an API key (since 2.1.242) are stored here, so every claudep profile sees the same ones. Claude Code refuses to write the store from a tool call ("The Anthropic profile store holds the sign-in that decides which organization policy applies"). This is the reason per-profile variables were planned for 0.5.0: a profile that sets `ANTHROPIC_PROFILE` picks its own Console sign-in.

## 11. Writes through a symlink are judged where they land (2026-09-30)

Since 2.1.280 the write-permission check builds every spelling of a path, the requested one and the symlink landing, and all of them must pass. The auto-memory exception compares with `startsWith(<CLAUDE_CONFIG_DIR>/projects/<slug>/memory/)`, so in a claudep profile the landing `~/.claude/projects/...` fails it, and the sensitive-file check then flags the `.claude` segment. The prompt is marked not approvable by the auto-mode classifier, and allow rules and PreToolUse hooks run too late to help. Upstream: anthropics/claude-code#98044 and #97585, open through 2.1.285. `claudep doctor` warns from `MEMORY_SYMLINK_PROMPT_FROM`.

The setting that might route around it is `autoMemoryDirectory` (`R_()` reads it from `policySettings`, `flagSettings`, `userSettings`, and project settings only when trusted). The default is `~/.claude/projects/<sanitized-cwd>/memory/`. `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` is a fixed override. Neither is set by claudep yet.

## 12. Windows Credential Manager (2026-09-30)

Credential stores come in three kinds, `keychain`, `plaintext` and `windows-credman`, and fallback pairs such as `windows-credman-with-plaintext-fallback`. Credential Manager is on when `CLAUDE_CODE_FORCE_WINDOWS_CREDMAN=1`, or when `cachedGrowthBookFeatures.tengu_windows_credman` is true in the config dir's `.claude.json` (`ivr()`), so a server-side flag can switch one profile and not another. The Windows-only code that names the Credential Manager entry is not in the macOS build, so whether it is namespaced per config dir like the Keychain item is not verified. `claudep doctor` on Windows no longer calls a profile without `.credentials.json` logged out when `auth status` says it is logged in. Verify the entry name on a Windows machine when the flag is seen in the wild.

## How to re-verify

The fastest way needs no script: byte offsets from a fixed-string grep, then a bounded slice around each one. `/usr/bin/grep` because the shell's `grep` is ugrep and rejects wide context regexes; `tr` because the slice is binary.

```sh
B=~/.local/share/claude/versions/<version>
/usr/bin/grep -a -b -o -F 'CLAUDE_CONFIG_DIR' "$B" | cut -d: -f1     # one offset per hit
tail -c +$((OFFSET-220)) "$B" | head -c 460 | LC_ALL=C tr -c '[:print:]' '.'
```

The same works for `new Set([".claude.json"` (the runtime-state list), `"teams")`, `case"User":return` and `CLAUDE_SECURESTORAGE_CONFIG_DIR`. Search for `Code-credentials` returns nothing because the service string is assembled at runtime. The earlier `Buffer.indexOf` script in bun works too but must be written to a file; inline scripts lose their braces on this machine (see `tooling-gotchas.md`).
