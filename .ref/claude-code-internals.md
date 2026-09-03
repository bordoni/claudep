# Claude Code internals that claudep depends on

Verified against the native macOS binary **Claude Code 2.1.259** (`~/.local/share/claude/versions/2.1.259`, arm64, ~200 MB) on 2026-09-02 by extracting minified source around known strings. Re-verify after major updates; the "How to re-verify" section shows how.

## 1. `.claude.json` moves inside the config dir

```js
function yYt(){let t=`.claude${b4()}.json`;return p(process.env.CLAUDE_CONFIG_DIR||J(),t)}
```

`J()` is `homedir()`. So with `CLAUDE_CONFIG_DIR` unset the global state file is `~/.claude.json`; with it set, it is `$CLAUDE_CONFIG_DIR/.claude.json`. This file holds `oauthAccount`, user-scope `mcpServers`, per-cwd `projects[...]` trust and allowed tools, and onboarding flags. Older docs saying it always stays in `$HOME` are wrong for this version. `b4()` is an empty suffix in normal builds.

## 2. Keychain service name is namespaced per config dir

```js
function Gx(n=""){let e=process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
  t=e!==void 0?!e:!process.env.CLAUDE_CONFIG_DIR,
  r=e!==void 0?e.normalize("NFC"):ye(),
  c=t?"":`-${a("sha256").update(r).digest("hex").substring(0,8)}`;
  return`Claude Code${Jt().OAUTH_FILE_SUFFIX}${n}${c}`}
```

- `ye()` is `(CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")).normalize("NFC")`.
- Result: `Claude Code-credentials` for the default dir, `Claude Code-credentials-<sha256(dir)[0:8]>` otherwise. The hash is over the **literal env string**, so `/a/b` and `/a/b/` are different accounts. claudep's `canon()` exists for this reason; `keychainService()` mirrors the formula.
- `CLAUDE_SECURESTORAGE_CONFIG_DIR` overrides which directory is hashed without moving files. Not used by claudep.
- The item is stored with `security add-generic-password -U -a <username> -s <service>`, so `doctor` checks with `-a $USER`.
- GitHub issue #20553 (all config dirs sharing one Keychain entry) describes older builds and does not apply.

## 3. Claude Code's own runtime-state list

When Claude Code snapshots a host config dir into a sandbox it excludes this set (`var Fi=new Set([...])`):

```
.claude.json  .claude.json.backup  .credentials.json  projects  sessions  todos
shell-snapshots  statsig  file-history  history.jsonl  ide  logs  backups
.session_ingress_token
```

This is Anthropic's own boundary between config and per-instance state and is the backbone of `KNOWN_PRIVATE`. claudep deliberately shares `projects/` anyway; see `shared-vs-private.md`.

## 4. `CLAUDE_CONFIG_DIR` inside settings `env` is rejected

The binary scans `projectSettings` and `localSettings` for an `env.CLAUDE_CONFIG_DIR` that differs from the active dir and, if found, returns `null` from the function that gates certain features. Never recommend that pattern.

## 5. `claude auth` subcommands

```
claude auth login [--claudeai|--console] [--sso] [--email <addr>]
claude auth logout
claude auth status [--json|--text]
```

`auth status --json` fields: `loggedIn, authMethod, apiProvider, analyticsDisabled, projectsDirectory, email, orgId, orgName, subscriptionType`. No secrets. Exit code is 1 when not logged in. claudep's `authStatus()` parses this.

## How to re-verify

`grep -aoE` with context on the 200 MB binary exceeds two minutes; `Buffer.indexOf` finishes in seconds:

```ts
const buf = Buffer.from(await Bun.file(BIN).arrayBuffer());
const show = (needle: string, before: number, after: number, max = 4) => {
  let i = 0, n = 0;
  while ((i = buf.indexOf(needle, i)) !== -1 && n < max) {
    console.log(buf.subarray(Math.max(0, i - before), i + needle.length + after).toString("latin1").replace(/[^\x20-\x7e]/g, "."));
    i += needle.length; n++;
  }
};
show("process.env.CLAUDE_CONFIG_DIR", 200, 200, 8);
show("var Fi=new Set([\".claude.json\"", 0, 400);
```

Search for `Code-credentials` returns nothing because the service string is assembled at runtime; search for `CLAUDE_SECURESTORAGE_CONFIG_DIR` instead.
