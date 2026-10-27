# Claude Code internals that claudep depends on

Verified against **Claude Code 2.1.311** (npm-global, Linux x64, build 2026-10-26) on 2026-10-27 by extracting minified source around known strings. Earlier passes: 2.1.259 on 2026-09-02, 2.1.263 on 2026-09-07, the native macOS 2.1.280 (`~/.local/share/claude/versions/2.1.280`, arm64) on 2026-09-30, and 2.1.286 for sections 9, 11, 13 and 14 in October. Minified names change between builds. The config-dir function is `Se()` in 2.1.263, `we()` in 2.1.280 and `Ne()` in 2.1.311; the runtime-state set is `Bi`, then `ca`, then `hl`. Snippets keep the names of the build they were read from, and each section says which. In 2.1.311 the name `Ne` is reused in several chunks; in this file `Ne()` is always the config-dir function from `chunk-cy3eb12w.js`. Sections 3, 5, 7, 13 and 14 changed in 2.1.311, and sections 15 and 16 are new. Re-verify after major updates; the "How to re-verify" section shows how.

## 1. `.claude.json` moves inside the config dir

```js
function dYt(){let t=`.claude${F1()}.json`;return S(process.env.CLAUDE_CONFIG_DIR||ct(),t)}
```

`ct()` is `homedir()`. So with `CLAUDE_CONFIG_DIR` unset the global state file is `~/.claude.json`; with it set, it is `$CLAUDE_CONFIG_DIR/.claude.json`. This file holds `oauthAccount`, user-scope `mcpServers`, per-cwd `projects[...]` trust and allowed tools, and onboarding flags. Older docs saying it always stays in `$HOME` are wrong for this version. `F1()` is an empty suffix in normal builds; staging builds produce `.claude-<suffix>.json`, which the runtime-state filter matches with `/^\.claude(-[a-z-]+)?\.json(\.backup)?$/`. A legacy `.config.json` inside the config dir is used instead when it exists (`Lt()`), which is why `.config.json` is known-private.

Unchanged in 2.1.311. The functions are `Rpr()` and `h_()`, which picks `<config dir>/.config.json` when it is a non-empty file, or when it is writable and there is no `.claude.json`.

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
- `CLAUDE_SECURESTORAGE_CONFIG_DIR` overrides which directory is hashed, and on 2.1.311 it also moves the credentials file (below). Not used by claudep.
- The item is stored with `security add-generic-password -U -a <username> -s <service>`, so `doctor` checks with `-a $USER`.
- GitHub issue #20553 (all config dirs sharing one Keychain entry) describes builds before 2.1.144 and does not apply.

**2.1.311.** The service formula is unchanged and is now `XSe()`. Three things are new or more precise:

- **The credentials file follows `CLAUDE_SECURESTORAGE_CONFIG_DIR`.** On Linux the plaintext store is `join(Z0(), ".credentials.json")`:

  ```js
  function Z0(){let e=process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;if(e!==void 0)return(e||u(o(),".claude")).normalize("NFC");return Ne()}
  ```

  An empty value means `~/.claude`, and unset means the config dir. The storage-v5 reader opens the file with `O_NOFOLLOW` and reports `refused-symlink` for a symlink, so `.credentials.json` must stay a real file in each profile. claudep never shares it.
- **Keychain account.** `Bq()` uses `$USER` (or `userInfo().username`) only when it matches `/^[a-zA-Z0-9._-]+$/`. Otherwise the account is `claude-code-user`, and `doctor`'s `-a $USER` check would miss the item.
- **Device keys are machine-wide.** Trusted-device binding for `claude --cloud` keeps its key in a Keychain item named exactly `Claude Code-device-keys`, with no hash suffix, or in `~/.claude/.device-keys.json` (`join(homedir(), ".claude", ".device-keys.json")`), locked with `~/.claude/.device-keys.lock`. Neither follows `CLAUDE_CONFIG_DIR`, so every profile on the machine shares one device key. The file sits in the base only, which is why `.device-keys.json` is known-private.

## 3. Claude Code's own runtime-state list

When Claude Code snapshots a host config dir into a sandbox it excludes this set (`var Bi=new Set([...])`, named `Fi` in 2.1.259):

```
.claude.json  .claude.json.backup  .credentials.json  projects  sessions  todos
shell-snapshots  statsig  file-history  history.jsonl  ide  logs  backups
.session_ingress_token
```

This is Anthropic's own boundary between config and per-instance state and is the backbone of `KNOWN_PRIVATE`. claudep deliberately shares `projects/` anyway; see `shared-vs-private.md`.

**2.1.280 (2026-09-30).** The set is `ca` and has grown. It now also holds `policy-limits.json`, `remote-settings.json`, their `.signature.json` and `.signature-iat.json` companions, `policy-limits.json.stamp.json`, `remote-settings-helper-consent`, `remote-settings-consent.json`, `hfi-auth.json`, `daemon`, `jobs`, `teams`, `usage-data`, `shares`, `state`, `uploads`, `feedback`, `feedback-bundles`, `plans`, `telemetry`, `dump-prompts`, `debug`, `traces`, `startup-perf`, `cache`, `mcp-discovery-cache`, `mcp-needs-auth-cache.json`, `gh-pr-status-cache.json`, `tasks`, `local`, `antproto.json`, `ccr`, `session-env`, `bridge-spawn`, `active-time.json`, `loop.md`, `server-sessions.json`, `image-cache`, `paste-cache`, `file-transfers`, `mcp-skill-archives`, `stats-cache.json`, `computer-use.lock`, `server.lock`, `api-dumps`, `chrome`, `downloads`, `local-settings`, `project-settings`, `remote`, `scratch`, `seed-admin`, `storage-v2`, `systemd` and `.cc-writes` (`var DL=".cc-writes"`, the temporary directory of the atomic-write helper). `plans` and `loop.md` are the two that touch claudep's shared list; see `shared-vs-private.md`.

**2.1.311 (2026-10-27).** The set is `hl`, and it lives in the self-hosted runner's host-config snapshot (`--host-config-snapshot`), which reads `SELF_HOSTED_RUNNER_HOST_CONFIG_DIR || CLAUDE_CONFIG_DIR || ~/.claude`. Eight entries are no longer literals:

```js
hl=new Set([".claude.json",".claude.json.backup",".credentials.json","projects",…,
  "policy-limits.json","remote-settings.json",
  ...["policy-limits.json","remote-settings.json"].flatMap((e)=>[$Fe(e),FFe(e)]),
  Irt("policy-limits.json"),lGt("remote-settings.json"),YPe,YJn,"hfi-auth.json",MPt,
  "daemon",…,"remote","remote-control","scratch","seed-admin","storage-v2","systemd",LW])
```

`$Fe` and `FFe` append `.signature.json` and `.signature-iat.json`, `Irt` appends `.stamp.json`, `lGt` appends `.synced-at`, and `YPe`, `YJn`, `MPt` and `LW` are `remote-settings-helper-consent`, `remote-settings-consent.json`, `ccr-home-seed.json` and `.cc-writes`. The `hl` chunk imports each name unaliased and exactly one chunk exports each, so the mapping is exact. Resolved, the set has 73 names. Against 2.1.280 it adds three and drops none:

- `remote-settings.json.synced-at`: when the org's remote settings were last synced. `ezr()` writes a millisecond timestamp with mode 0600 and refuses to write through a symlink. Org-scoped.
- `ccr-home-seed.json`: the sidecar that cloud-session (CCR) home seeding writes next to the settings it seeded. That path runs only for managed or runner-child sessions.
- `remote-control`: holds `remote-control/fork-seeds/<id>.json` for Remote Control session forks. The startup cleanup sweeps it with `backups/`, `debug/` and `feedback-bundles/`.

The set is not the whole filter. The predicate that applies it, `ha()`, also drops every name that starts with `.`, `daemon` or `agent-memory`, anything matching `/^\.claude(-[a-z-]+)?\.json\./` or `/^\.config\.json(\.|$)/`, `.session_ingress_token*`, and atomic-write temp names (`<name>.tmp.<hex>` and `.<16 hex>.tmp`):

```js
function ha(e){let n=Cp(e);return!hl.has(n)&&!n.startsWith(".")&&!n.startsWith("daemon")
  &&!n.startsWith("agent-memory")&&…&&!apr(n)&&!noe(n)}
```

**Lock files.** Claude Code bundles proper-lockfile. The lock for a file is a directory named `<file>.lock` (`` function ne(e,r){return r.lockfilePath||`${e}.lock`} ``, then `mkdir`), and a held lock gets its mtime refreshed, so an old, empty `<file>.lock` was left by a process that exited while holding it. The top-level lock names a config dir can hold:

- `.claude.json.lock` (the global-config lock) and `history.jsonl.lock`;
- `policy-limits.json.signature-iat.json.lock` and `remote-settings.json.signature-iat.json.lock` (the signed-cache lock). On 2026-10-27 the author's base and one profile each held both, empty and hours old;
- `.storage-write.lock` (secure-storage writes, under `Z0()`);
- `.oauth_refresh.lock` and its owner record `.oauth_refresh.lock.owner`, `.cloud_sessions_oauth_refresh.lock` and `.design_oauth_refresh.lock`, all under `Z0()`;
- `mcp-refresh-<server>.lock.lock`: the name passed in already ends in `.lock`, and the default appends a second one;
- `.update.lock`, a plain file holding a pid (section 13);
- `.device-keys.lock`, in `~/.claude` only (section 2).

Claude Code's own sweeper treats any name ending in `.lock` as transient (`var $T=/(^\..*\.tmp~?$)|(\.tmp[.~][0-9a-f]{8}$)|(\.lock$)|.../`). claudep 0.7.1 adds `remote-settings.json.synced-at`, `ccr-home-seed.json`, `remote-control` and `.device-keys.json` to `KNOWN_PRIVATE`, and treats any top-level name ending in `.lock` or `.lock.owner` as private.

The legacy OAuth lock is `${realpath(Z0())}.lock`, which puts `~/.claudep/<name>.lock` next to each profile. `listProfileNames` skips it because `NAME_RE` allows no dots.

## 4. Subdirectories Claude Code knows inside the config dir (2026-09-07)

The storage layer's `userConfigDir` namespace lists these directories:

```
commands  agents  output-styles  skills  workflows  routines  themes  rules
session-env  uploads  mcp-skill-archives  usage-data  mcp-discovery-cache
```

A second list in the sandbox seeding code adds `shell-snapshots`, `plugins`, `hooks`, `scheduled_tasks.json`, `launch.json`, `daemon.json`, `policy-limits.json`. `teams` is `join(Se(), "teams")` in the read-permission code, next to `tasks`. `seed-admin` is `join(configDir, "seed-admin")` in the worktree code. `shared-vs-private.md` says which of these are shared and why; `routines` is unclassified on purpose.

**2.1.311 (2026-10-27).** A second list, `Tqn`, names 49 config-home entries:

```
agent-memory  agent-memory-local  agent-memory-project  api-dumps  backups  cache  chrome
cowork_plugins  daemon  debug  downloads  dump-prompts  feedback  feedback-bundles
file-history  file-transfers  ide  image-cache  jobs  local  local-settings  logs
mcp-discovery-cache  mcp-skill-archives  paste-cache  plans  plugins  project-settings
projects  remote  remote-control  scratch  seed-admin  session-env  sessions  shares
shell-snapshots  startup-perf  state  statsig  storage-v2  systemd  tasks  teams
telemetry  todos  traces  uploads  usage-data
```

It belongs to the write-permission code, not to snapshots. `BQt()` walks each config home (`CLAUDE_CONFIG_DIR`, `~/.claude` and the secure-storage dir) for symlinks that lead into the working tree, so files that are really config can be protected from writes. It does not walk into a top-level entry named in `Tqn`, and for `plugins`, `cowork_plugins` and `state` it checks only the links one level down. It is not a copy of `hl`: it adds `plugins` and the agent-memory names, and it has no files. The names new to claudep:

- `agent-memory/`: user-scope subagent memory, `join(<config dir>, "agent-memory", <agent>)` unless `CLAUDE_CODE_REMOTE_MEMORY_DIR` is set. It holds a `MEMORY.md` and topic files per custom agent, written across projects: the same kind of content as `projects/<slug>/memory/`, keyed by agents that live in the shared `agents/`. For user scope the loader follows a symlink. Not on the author's machine on 2026-10-27; see `shared-vs-private.md`.
- `agent-memory-local/`, `agent-memory-project/`: not config-dir items. Project and local scope live at `<cwd>/.claude/agent-memory/` and `<cwd>/.claude/agent-memory-local/`, and they are in `Tqn` because `~/.claude` is also the project `.claude` of a session started in `$HOME`.
- `cowork_plugins/`: the plugin root used instead of `plugins/` in Cowork mode or with `CLAUDE_CODE_USE_COWORK_PLUGINS`.

One more config-dir path is in neither list: `memory/personal/`, the account-scope memory store (`join(Ne(), "memory", "personal")`), behind `CLAUDE_MEMORY_STORES`. It is account-scoped, so it is a `KNOWN_PRIVATE` candidate if it ever appears.

## 5. Where the user `CLAUDE.md` and rules come from (2026-10-27)

Re-verified on 2.1.311. The names were `yQ`, `fge` and `Se` in 2.1.263:

```js
var Ne=so(()=>(a8t()??E(C(),".claude")).normalize("NFC"),a8t);   // a8t() is process.env.CLAUDE_CONFIG_DIR
function DX(e){switch(e){case"User":return st(Ne(),"CLAUDE.md");case"Local":return st(ke(),"CLAUDE.local.md");
  case"Project":return st(ke(),"CLAUDE.md");case"Managed":return st(ab(),"CLAUDE.md");case"AutoMem":return Mq()}}
function fst(){return st(Ne(),"rules")}
```

User memory and user rules resolve from the config dir only. Upstream issue #30230 (user `CLAUDE.md` loaded from both `$CLAUDE_CONFIG_DIR` and `~/.claude`) still does not apply.

`~/.claude/CLAUDE.md` can still get in through the project walk. The loader collects every directory from the cwd up to, but not including, the filesystem root. It does not stop at `$HOME`, and in each directory it reads `CLAUDE.md`, `.claude/CLAUDE.md` and `.claude/rules` as Project:

```js
for(let ho=Ge;ho!==void 0&&ho!==GUo(ho).root;ho=UC(ho))gt.unshift(ho);   // Ge = cwd, GUo = path.parse, UC = path.dirname
... projectFiles:Lo?[fh(ho,"CLAUDE.md"),fh(ho,".claude","CLAUDE.md")]:[], rulesDir:Lo?fh(ho,".claude","rules"):void 0
```

So when the cwd is under `$HOME`, `~/.claude/CLAUDE.md` and `~/.claude/rules` are Project files. The loader dedupes by resolved path and loads User first, so a profile whose `CLAUDE.md` is claudep's symlink gets the file once, labelled user. A profile without the symlink gets it as "(project instructions, checked into the codebase)", and only when the cwd is under `$HOME`. Both cases were checked against a fake local API endpoint with a fresh config dir. This is what a profile created before `~/.claude/CLAUDE.md` existed shows; `claudep doctor` reports "CLAUDE.md: not linked", and `claudep init <name>` fixes it.

`--add-dir` plays no part in that. Additional directories are never walked upward, and their memory loads only when `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` is set. Then only `<dir>/CLAUDE.md`, `<dir>/.claude/CLAUDE.md`, `<dir>/.claude/rules` and `<dir>/CLAUDE.local.md` are read.

When the entrypoint is Cowork (`local-agent`), a user `CLAUDE.md` that is a symlink or a hard link is skipped (`if(h===0&&je.isSymbolicLink()||(je.nlink??1)>1&&je.isFile())return[]`). The CLI and VS Code are not affected, and claudep does not target Cowork.

The `ide/` lock directory is unchanged and still the one place both are read: `[join(Ne(), "ide"), join(homedir(), ".claude", "ide")]` when `CLAUDE_CONFIG_DIR` is set, so IDE extensions that write into `~/.claude/ide` still find a profile session.

## 6. `CLAUDE_CONFIG_DIR` inside settings `env` is rejected

The binary scans `projectSettings` and `localSettings` for an `env.CLAUDE_CONFIG_DIR` that differs from the active dir and, if found, returns `null` from the function that gates certain features. Since 2.1.250 a project-level `env` block cannot set the variable at all; a user-level one still can and still trips the check. Never recommend that pattern.

**2.1.311.** The scan is `Q()` in the auth module, and the value it nulls is `auth status`'s `projectsDirectory`. It reads only project and local settings, so a user-level `env` does not trip it. A second check catches a move from any tier: `UJn()` compares `CLAUDE_CONFIG_DIR`, `HOME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH` and `CLAUDE_CODE_USE_COWORK_PLUGINS` with a snapshot taken at launch. When a settings file moved one, seed-admin reports `settings_moved`, git bundle upload refuses, and relaunch puts back the launch value. The resume helper also deletes `env.CLAUDE_CONFIG_DIR` from the `settings.json` it copies. Whether a project-level `env` still drops the variable was not re-checked. The advice stands: set `CLAUDE_CONFIG_DIR` in the shell only, which is what claudep does.

## 7. Background sessions and the daemon under a config dir (2026-10-27)

Re-verified on 2.1.311. The 2.1.280 launcher check `if(process.env.CLAUDE_CONFIG_DIR||!await ole())return!1`, which made `claude --bg` run unwrapped under a profile, is gone. `CLAUDE_CONFIG_DIR` now turns off only the installed launchd/systemd service:

```js
async function ir(){if(sr()||!await q3e())return!1;return Jte().catch(()=>!1)}   // use the installed service
function sr(){return Boolean(process.env.CLAUDE_CONFIG_DIR)}
async function dr(){return o2e()&&await q3e()&&!process.env.CLAUDE_CONFIG_DIR&&r2e()}   // offer "claude daemon install"
```

Under a profile, `claude --bg` and `claude agents` fall through to a transient supervisor (`["daemon","run","--origin","transient",...]`, with `CLAUDE_CONFIG_DIR` passed through) that belongs to that config dir. All of its paths go through `Ne()`:

```js
function $D(){return o(Ne(),"daemon.json")}function wge(){return o(Ne(),"daemon.log")}
var h="daemon.lock";function ND(){return b(Ne(),h)}
function c(e){return e===void 0?o(Ne(),"daemon"):o(e,"daemon")}
function q(){return createHash("sha256").update(resolve(Ne())).digest("hex").slice(0,8)}   // socket dir /tmp/cc-daemon-<uid>/<q()>
```

Upstream #97680 (2.1.280 writing `daemon.lock` into the profile but `daemon.json` and `daemon.log` into `~/.claude`) is fixed in the code, but the issue was still open on 2026-10-27. `claude daemon --help` still prints `default: ~/.claude/daemon.json` and `~/.claude/daemon.log` whatever the config dir: the help text is a constant, and the real defaults are `$D()` and `wge()`.

`claude daemon install` still refuses a non-default config dir with "service install only supports the default config dir", followed by "the launchd/systemd unit is a per-user singleton". Two checks run first. The `tengu_amber_anchor` flag must be on, or every config dir gets "`claude daemon install` is disabled in this version", followed by "the daemon runs on demand". A systemd user runtime dir must also exist. The flag was off in every profile on the author's machine on 2026-10-27, so service install is unavailable everywhere and the on-demand supervisor is the normal path. Nothing for claudep to do beyond the README note.

## 8. `CLAUDE_CODE_PROJECT_DIR_NAME` (2026-09-07)

Read only when `CLAUDE_CONFIG_DIR` is set (`Wt()`: `t.CLAUDE_CONFIG_DIR ? ROn(t.CLAUDE_CODE_PROJECT_DIR_NAME) : void 0`). It must match `/^[A-Za-z0-9_-]{1,64}$/` and not be a Windows device name, and it pins the `projects/<name>` directory for transcripts and auto memory. claudep does not set it; users who want one memory directory for every repo opened under a profile can export it themselves.

Unchanged in 2.1.311 (`Nfs()`). It is also read in the `zte()` host mode, not only when `CLAUDE_CONFIG_DIR` is set.

## 9. `claude auth` subcommands

```
claude auth login [--claudeai|--console] [--sso] [--email <addr>]
claude auth logout
claude auth status [--json|--text]
```

`auth status --json` fields: `loggedIn, authMethod, apiProvider, analyticsDisabled, projectsDirectory, email, orgId, orgName, subscriptionType`. No secrets. Exit code is 1 when not logged in. claudep's `authStatus()` parses this.

2.1.280 adds `configDirectory` (the resolved config dir, `we()`, since 2.1.268), and `forcedLoginMethod` and `apiKeySource` when they apply. `email`, `orgId`, `orgName` and `subscriptionType` appear only when `authMethod` is `claude.ai`; a gateway provider adds `email` alone. The subcommands are unchanged.

Checked on 2.1.286 (2026-10-05) under a profile: `configDirectory` is the canonical profile dir, the same string claudep sets. With `ANTHROPIC_API_KEY` set, `authMethod` is `api_key` and `apiKeySource` is `ANTHROPIC_API_KEY`. With `CLAUDE_CODE_OAUTH_TOKEN` set, `authMethod` is `oauth_token` and there is no `apiKeySource`, so `doctor` keeps its own check of the variables. With `CLAUDE_CODE_USE_BEDROCK=1`, `authMethod` is `third_party` and `apiProvider` is `bedrock`. `doctor` fails when `configDirectory` is not the profile dir, and `status --json` and `list --json` pass `apiProvider`, `apiKeySource` and `configDirectory` through.

Checked on 2.1.311 (2026-10-27): the subcommands and flags are unchanged, and `configDirectory` is `Ne()`. In an empty config dir it prints `{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty","analyticsDisabled":true,"projectsDirectory":"<dir>/projects","configDirectory":"<dir>"}` and exits 1. New in the output: `allowedProviders` when managed settings carry that list; the `authMethod` value `api_key_helper` (the full set is `none`, `third_party`, `claude.ai`, `api_key_helper`, `oauth_token`, `api_key`); and `email`, `orgId` and `orgName` for an `api_key` that came from a `/login` managed key. `authStatus()` reads `authMethod` as a plain string and ignores unknown keys, so it needs no change. `auth login` can also mint a stored login from `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, which needs `CLAUDE_CODE_OAUTH_SCOPES` and is spent by the attempt (section 16).

## 10. The Anthropic profile store and `ANTHROPIC_PROFILE` (2026-09-30)

Claude Code has a second credential location that does not follow `CLAUDE_CONFIG_DIR`: `$ANTHROPIC_CONFIG_DIR`, else `$XDG_CONFIG_HOME/anthropic`, else `~/.config/anthropic`. It holds `active_config`, `configs/<name>.json` and `credentials/<name>.json`, and `ANTHROPIC_PROFILE` picks the entry. Auth kinds are `user_oauth` and `oidc_federation`. Console sign-ins made without an API key (since 2.1.242) are stored here, so every claudep profile sees the same ones. Claude Code refuses to write the store from a tool call ("The Anthropic profile store holds the sign-in that decides which organization policy applies"). This is the reason per-profile variables were planned for 0.5.0: a profile that sets `ANTHROPIC_PROFILE` picks its own Console sign-in.

Re-verified on 2.1.311 (2026-10-27). The order is unchanged (`M()`), but the fallback reads the `HOME` variable, not `os.homedir()`; the store is off in diskless host mode; and a config's `authentication.credentials_path` replaces the default `credentials/<name>.json`. `ANTHROPIC_PROFILE` must be letters, digits, `_`, `.` and `-`. Logout removes the active entry's credential file and revokes its refresh token, so `claude auth logout` in one claudep profile signs out every profile that uses the same store entry. That comes from reading the code; it was not run.

## 11. Writes through a symlink are judged where they land (2026-09-30)

Since 2.1.280 the write-permission check builds every spelling of a path, the requested one and the symlink landing, and all of them must pass. The auto-memory exception compares with `startsWith(<CLAUDE_CONFIG_DIR>/projects/<slug>/memory/)`, so in a claudep profile the landing `~/.claude/projects/...` fails it, and the sensitive-file check then flags the `.claude` segment. The prompt is marked not approvable by the auto-mode classifier, and allow rules and PreToolUse hooks run too late to help. Upstream: anthropics/claude-code#98044 and #97585, both still open on 2026-10-27 (2.1.311). `claudep doctor` warns from `MEMORY_SYMLINK_PROMPT_FROM`.

Re-verified on 2.1.286 (2026-10-02), where the functions are `pE()`, `Tc()`, `Z3()` and `PFt()`:

- `autoMemoryDirectory` is read from `policySettings`, then `flagSettings`, then local and project settings only when trusted, then `userSettings`. `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` wins over all of them.
- The value gets `~/` expansion, `path.normalize`, one trailing separator and NFC. It is not realpathed.
- The exception `Z3()` is `normalize(path).startsWith(<memory dir>)` for a `.md` file, and `PFt()` runs it for each spelling.
- The default dir is `<config dir>/projects/<slug>/memory/`. The slug is `CLAUDE_CODE_PROJECT_DIR_NAME` when valid (section 8). Otherwise it is the canonical git root, or the launch cwd outside a repo, with `[^a-zA-Z0-9]` replaced by `-`. A slug over 200 characters is cut and gets `-` plus the base-36 `Math.abs` of the Java string hash. The canonical root `en()` maps a linked worktree to its main checkout through `gitdir`, `commondir` and the `gitdir` back-pointer.
- `CLAUDE_CODE_REMOTE_MEMORY_DIR` replaces the config dir in that path and also moves `agent-memory-local`.

Re-verified on 2.1.311 (2026-10-27) by reading the code; not run. The write check is `bRe()`, the per-spelling loop `ql()` and the exception `_ee()`:

- `ql()` gives a spelling that came back passthrough a second try through `VZn()`, which rewrites a path under another spelling of a known root (the cwd, the project root, the config dir, the memory base) back to that root. That helps when the config dir itself is reached through a symlink. It does not help claudep's layout, where the profile dir is real and only `projects/` inside it points at `~/.claude/projects`: the landing is under no spelling of the profile dir, so it still fails. Keep the workaround.
- The exception now also needs `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` unset, and `Nee()` refuses a path with a sensitive segment below the memory dir.
- `XJo()` allows a second dir, `resolveOwnProjectDir`: `<config dir>/projects/<current project key>/memory/`, only when no override or setting is in force and the memory base is the config dir.
- A settings tier that is turned off is skipped (behind `tengu_linked_cake`). `sd()` refuses a `~/` value that climbs out with `..`, and a value that is not absolute, is shorter than 3 characters, or is a bare drive.
- The default key can also come from a `working_copy` root.

`claudep run` passes `--settings '{"autoMemoryDirectory":"<realpath>"}'`, which makes both spellings the same path. See `design-decisions.md`, 2026-10-02.

## 12. Windows Credential Manager (2026-09-30)

Credential stores come in three kinds, `keychain`, `plaintext` and `windows-credman`, and fallback pairs such as `windows-credman-with-plaintext-fallback`. Credential Manager is on when `CLAUDE_CODE_FORCE_WINDOWS_CREDMAN=1`, or when `cachedGrowthBookFeatures.tengu_windows_credman` is true in the config dir's `.claude.json` (`ivr()`), so a server-side flag can switch one profile and not another. The Windows-only code that names the Credential Manager entry is not in the macOS build, so whether it is namespaced per config dir like the Keychain item is not verified. `claudep doctor` on Windows no longer calls a profile without `.credentials.json` logged out when `auth status` says it is logged in. Verify the entry name on a Windows machine when the flag is seen in the wild.

Re-verified on 2.1.311 (2026-10-27). The switch is `tes()`, and it reads `cachedGrowthBookFeatures.tengu_windows_credman` from a legacy `<config dir>/.config.json` when one exists, then from `.claude.json`, so the flag stays per profile. The store kinds and fallback pairs are unchanged. The Linux build lacks the code that names the entry too; `CredWrite` and `wincred` appear only in the sandbox deny list. Still unverified.

## 13. The auto-updater (2026-10-27)

Checked in 2.1.311 (npm-global, Linux x64, embedded Bun 1.4.4). The earlier pass was the 2.1.286 binary (native, macOS) and the upstream CHANGELOG through 2.1.302.

- **Switches**, in the order `Ph()` checks them (reached through `Y$e()` and `PSe()`): `DISABLE_UPDATES`, `DISABLE_AUTOUPDATER` (true for 1/true/yes/on), `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` (true for any non-empty value, even `0` or a space), then `.claude.json` `autoUpdates === false`. That last one is ignored when `installMethod` is `native` and `autoUpdatesProtectedForNative` is true (upstream #91646). A settings `env` block lands in the process environment, so the variables count there too, and `claude doctor` prints "Auto-updates: disabled (set by env: ...)". `DISABLE_AUTOUPDATER` stops only the background check. `DISABLE_UPDATES` also makes `claude update` print "Updates are disabled by your administrator" and exit 0. Each process checks at most once every 300000 ms.
- **Migration**: `xt()` turns `autoUpdates: false` into `env.DISABLE_AUTOUPDATER: "1"` in the user `settings.json` and deletes both `autoUpdates` and `autoUpdatesProtectedForNative`. It does nothing when `autoUpdatesProtectedForNative` is true. Through a symlinked `settings.json` the write lands in the shared file. This is why `autoUpdates` left `SEED_KEYS` in 0.7.0.
- **Lock, npm and bun**: `<CLAUDE_CONFIG_DIR>/.update.lock`, opened with `wx`, pid inside. A lock whose mtime is 300000 ms old or more is stale and is unlinked after a second stat. It is released only when it still holds our pid, and held only while `npm|bun install -g` runs. Contention returns `in_progress` and writes no result. One lock per config dir, so two profiles never see each other's lock.
- **Lock, native**: a per-version lock under `$XDG_STATE_HOME/claude/locks` (default `~/.local/state/claude/locks`), shared by every config dir. Contention is `lockFailed` and writes no result. The earlier "native takes none" was wrong.
- **npm vs native**: npm runs `npm|bun install -g @anthropic-ai/claude-code@<v>`, which moves the package aside while it installs, so the bin link is missing for the duration (upstream #93197). Native stages into `~/.cache/claude/staging/<v>.<pid>.<ts>.<hex>`, moves the result to `versions/<v>`, then swaps the launcher with symlink-to-tmp and rename. On Windows the swap is two renames.
- **Running version**: both paths compare against the running version, so every older session in every profile installs the same release again. Native finds it on disk and only re-points the symlink; npm reinstalls. This is the four reinstalls in bordoni/claudep#7.
- **`.last-update-result.json`**, per config dir, written atomically by `YJe()`. Fields: `timestamp` (ISO), `path` (`npm-global|npm-local|native`), `outcome` (`success|failed`), `status`, `version_from`, `version_to` (nullable), `error_code` (nullable). npm writes it after every attempt that is not `in_progress`, from the background updater and from `claude update`, with `version_to` set to the target even when the attempt failed, and `version_from` set to the installed global version it detected, which may differ from the running one. Native writes it only when it installed something, or with `outcome: failed` and `version_to: null` when the install threw. Nothing is written when there was nothing to update, or in a diskless session. `claude doctor` shows it as "Last update attempt: success → X (date)", or a "failed (status)" line with the date.
- **v5 storage backend**: code exists to move the result and the lock to state keys `last-update-result` and `update-lock`, behind `tengu_hover_rest` / `CLAUDE_CODE_HOVER_REST`. In the external build the backend factory `YYr()` returns nothing, so the files above are always used. Recheck on every catch-up: if it is ever built, the two files stop being updated.
- **Other version records**: `.claude.json` `lastReleaseNotesSeen` and `lastClawdEntranceVersion` rise to the running version when an interactive session starts on a newer one. They never go down, and `-p` does not set them.
- **Forced downgrade**: the updater can install an older version (`tengu_auto_updater_forced_downgrade`), which writes a `version_to` below `version_from`.
- **`claude doctor`** has no JSON output and exits 1 on any warning, so claudep computes the same answers itself.

`claudep doctor` in 0.7.1 follows this. It treats `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` as set on any non-empty value, and keeps the 1/true/yes/on test for the other two. It compares the running version with each config dir's `.last-update-result.json`: a failed record's baseline is `version_from`, not the target that did not land. To tell "updated by another config dir" from "updated outside Claude Code", it compares with the newest successful `version_to` across the base and every profile. When the running version is older than the last successful update, it says so: a downgrade, or another install first on PATH.

## 14. Short commands and the token refresh (2026-10-27)

A short-lived command such as `claude auth status` used to start an OAuth refresh at init and exit before saving it, which spent the refresh token and signed the profile out (anthropics/claude-code#95822, reported on 2.1.283 to 2.1.294). The 2.1.301 changelog: "Fixed sign-in refresh timeouts and unexpected sign-outs after a short command such as `claude auth status` or `claude plugin list` exited in the middle of a token refresh". In 2.1.311 the fix works like this:

- A refresh takes `<dir>/.oauth_refresh.lock` (proper-lockfile, stale 60000 ms, refreshed every 5000 ms), a legacy lock at `<realpath of dir>.lock`, and writes an owner record to `.oauth_refresh.lock.owner`. The dir is `CLAUDE_SECURESTORAGE_CONFIG_DIR`, or the config dir when that is unset.
- While the lock is held, a counter in the process is non-zero. An exit hook waits up to 2000 ms for it to reach zero, then logs "OAuth refresh still in flight after 2000ms; exiting without waiting further".
- `claude auth status` waits on that hook before `process.exit`, and so do the shared exit helpers.

`claudep list`, `status` and `doctor` ran `auth status` once per profile, so below 2.1.301 they read `oauthAccount` from `.claude.json` instead. Its keys include `emailAddress`, `organizationName`, `organizationType`, `billingType` and `accountUuid`; no secrets.

`claude --version` stays safe. The entry point checks raw argv first: exactly `--version`, `-v` or `-V`, optionally followed by `--verbose`, which adds a `Commit:` line. It prints `2.1.311 (Claude Code)` and returns before any setup. Measured on an empty `CLAUDE_CONFIG_DIR`: 0.011 s, no files written. `--version` with any other argument goes through full startup.

## 15. Usage text and the statusline rate_limits (2026-10-27)

`/usage` runs non-interactively. For a subscriber it prints a header, a blank line, then one line per window:

```
<title>: <floor(utilization)>% used · resets <reset text>
```

- **Titles**: `Current session`, `Current week (all models)`, then `Current week (Sonnet only)` (max, team or unknown plans, when the API reports it), then `Current week (<display_name>)` for each model-scoped limit. A window with no utilization is left out, and one with no reset has no ` · resets` part.
- **Reset text**: month, day, hour, and minutes unless they are :00, with am/pm lowercased, the IANA zone in parentheses, and the year only when it differs. On Linux (Bun 1.4.4) the separator is a comma, "Oct 30, 11pm (America/New_York)"; the 2.1.286 macOS output said "Oct 17 at 1:59pm". claudep keeps the text as Claude Code printed it.
- **Behaviours block**: after the windows comes "What's contributing to your limits usage?" with "Last 24h" and "Last 7d" lines. claudep ignores it.
- **Parser**: `parseUsageText` reads every `Current` line and needs no change; "Sonnet only" lands in `models`.

A 2.1.311 sample for a Max plan on Linux. The window lines are exact; the behaviour lines come from the server and are only an example:

```
You are currently using your subscription to power your Claude Code usage

Current session: 7% used · resets Oct 27, 5:59pm (America/New_York)
Current week (all models): 23% used · resets Oct 30, 10:59pm (America/New_York)
Current week (Sonnet only): 4% used · resets Oct 30, 11pm (America/New_York)
Current week (Fable): 0% used · resets Oct 30, 11pm (America/New_York)

What's contributing to your limits usage?
Approximate · sessions on this machine only · shares overlap

Last 24h · 412 requests · 5 sessions
  64%  Subagent-heavy sessions · 3 sessions ran 10+ subagents
```

**Statusline**: the statusline JSON carries `rate_limits.five_hour` and `rate_limits.seven_day`, each `{used_percentage, resets_at}`, with `resets_at` in epoch seconds and `used_percentage` = `min(round(utilization*1000)/10, 100)`. Behind a Claude gateway a third key, `spend_limit`, adds `used_percentage` (which can pass 100), `resets_at`, and optionally `used_usd`, `limit_usd` and `period`. `rate_limits` is present when any of the three is. claudep reads only the first two, so a gateway-only payload has no usage. The payload's `version` field is the running version.

## 16. Credential variables Claude Code reads (2026-10-27)

Checked on 2.1.311 and recorded for 0.8.0; 0.7.1 does not change `AUTH_ENV`. claudep refuses `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` in `claudep.env`. Claude Code's own list of Anthropic credentials, the one it scrubs from subprocess environments (`Pes`), is longer:

```
ANTHROPIC_API_KEY  ANTHROPIC_AUTH_TOKEN  ANTHROPIC_CUSTOM_HEADERS  CLAUDE_CODE_OAUTH_TOKEN
CLAUDE_CODE_SESSIONS_OAUTH_TOKEN  CLAUDE_CODE_OAUTH_REFRESH_TOKEN  CLAUDE_CODE_ARTIFACTS_API_TOKEN
CLAUDE_CODE_MEMORY_API_TOKEN  CLAUDE_CODE_SLACK_TAG_TOKEN  ANTHROPIC_FOUNDRY_API_KEY
ANTHROPIC_FOUNDRY_AUTH_TOKEN  ANTHROPIC_AWS_API_KEY  ANTHROPIC_IDENTITY_TOKEN  ANTHROPIC_IDENTITY_TOKEN_FILE
```

`ANTHROPIC_CUSTOM_HEADERS` is on it because it can carry auth headers. It also reads:

- `CLAUDE_TRUSTED_DEVICE_TOKEN`, which wins over the stored `trustedDeviceToken`;
- `CLAUDE_CODE_SESSION_ACCESS_TOKEN`, `CLAUDE_BRIDGE_OAUTH_TOKEN`, `CLAUDE_CODE_GATEWAY_TOKEN` and `CLAUDE_CODE_CLIENT_KEY_PASSPHRASE`;
- the cloud provider secrets `AWS_BEARER_TOKEN_BEDROCK`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AZURE_CLIENT_SECRET`, `AZURE_PASSWORD`, `GOOGLE_OAUTH_ACCESS_TOKEN` and `CLOUDSDK_AUTH_ACCESS_TOKEN`.

These hold a file descriptor number or a path, not a secret: `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR`, `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`, `CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR`, `CLAUDE_CODE_HOST_CREDS_FILE`, `CLAUDE_SESSION_INGRESS_TOKEN_FILE` and `ANTHROPIC_IDENTITY_TOKEN_FILE`. `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, with `CLAUDE_CODE_OAUTH_SCOPES`, is the one that writes a lasting login into the profile, through `claude auth login`. No older binary was at hand, so which of these appeared after 2.1.286 is not known.

## How to re-verify

The fastest way needs no script: byte offsets from a fixed-string grep, then a bounded slice around each one. `/usr/bin/grep` because the shell's `grep` is ugrep and rejects wide context regexes; `tr` because the slice is binary.

```sh
B=~/.local/share/claude/versions/<version>
/usr/bin/grep -a -b -o -F 'CLAUDE_CONFIG_DIR' "$B" | cut -d: -f1     # one offset per hit
tail -c +$((OFFSET-220)) "$B" | head -c 460 | LC_ALL=C tr -c '[:print:]' '.'
```

The same works for `new Set([".claude.json"` (the runtime-state list), `"teams")`, `case"User":return` and `CLAUDE_SECURESTORAGE_CONFIG_DIR`. Search for `Code-credentials` returns nothing because the service string is assembled at runtime. The earlier `Buffer.indexOf` script in bun works too but must be written to a file; inline scripts lose their braces on this machine (see `tooling-gotchas.md`).

On the npm-global build (2.1.311) `ugrep` and `grep -o` with long contexts both fail. Read the file with `Bun.file(path).text()`, then `indexOf` and `slice` around each hit, from a script file. Search for:

- `.last-update-result.json"` and `".update.lock"` (updater result and lock)
- `function Ph(e){` (update switches)
- `function YYr(){` (the v5 storage backend; it should still return nothing)
- `OAuth refresh still in flight after` (exit wait)
- `(e[0]==="--version"` (version fast path)
- `title:"Current session"` (`/usage` format)
- `rate_limits:wt` (statusline payload)
