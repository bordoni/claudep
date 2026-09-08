# Claude Code internals that claudep depends on

Verified against the native macOS binary **Claude Code 2.1.263** (`~/.local/share/claude/versions/2.1.263`, arm64, ~200 MB) on 2026-09-07 by extracting minified source around known strings. First verified against 2.1.259 on 2026-09-02; nothing below changed between the two except the additions marked with the later date. Re-verify after major updates; the "How to re-verify" section shows how.

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

## 8. `CLAUDE_CODE_PROJECT_DIR_NAME` (2026-09-07)

Read only when `CLAUDE_CONFIG_DIR` is set (`Wt()`: `t.CLAUDE_CONFIG_DIR ? ROn(t.CLAUDE_CODE_PROJECT_DIR_NAME) : void 0`). It must match `/^[A-Za-z0-9_-]{1,64}$/` and not be a Windows device name, and it pins the `projects/<name>` directory for transcripts and auto memory. claudep does not set it; users who want one memory directory for every repo opened under a profile can export it themselves.

## 9. `claude auth` subcommands

```
claude auth login [--claudeai|--console] [--sso] [--email <addr>]
claude auth logout
claude auth status [--json|--text]
```

`auth status --json` fields: `loggedIn, authMethod, apiProvider, analyticsDisabled, projectsDirectory, email, orgId, orgName, subscriptionType`. No secrets. Exit code is 1 when not logged in. claudep's `authStatus()` parses this.

## How to re-verify

The fastest way needs no script: byte offsets from a fixed-string grep, then a bounded slice around each one. `/usr/bin/grep` because the shell's `grep` is ugrep and rejects wide context regexes; `tr` because the slice is binary.

```sh
B=~/.local/share/claude/versions/<version>
/usr/bin/grep -a -b -o -F 'CLAUDE_CONFIG_DIR' "$B" | cut -d: -f1     # one offset per hit
tail -c +$((OFFSET-220)) "$B" | head -c 460 | LC_ALL=C tr -c '[:print:]' '.'
```

The same works for `new Set([".claude.json"` (the runtime-state list), `"teams")`, `case"User":return` and `CLAUDE_SECURESTORAGE_CONFIG_DIR`. Search for `Code-credentials` returns nothing because the service string is assembled at runtime. The earlier `Buffer.indexOf` script in bun works too but must be written to a file; inline scripts lose their braces on this machine (see `tooling-gotchas.md`).
