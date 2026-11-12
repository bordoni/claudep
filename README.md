# claudep

[![CI](https://github.com/bordoni/claudep/actions/workflows/ci.yml/badge.svg)](https://github.com/bordoni/claudep/actions/workflows/ci.yml)

Run [Claude Code](https://code.claude.com) under separate accounts on one machine, for example a company Enterprise org and a personal Max plan, with fully isolated logins and shared configuration.

Claude Code has no account switching of its own. `claudep` is one [bun](https://bun.sh) script with no dependencies. It manages named **profiles** and points Claude Code at them through `CLAUDE_CONFIG_DIR`.

```
claudep init enterprise --sso --email you@company.com --alias eclaude
eclaude          # Claude Code as the enterprise account
claude           # Claude Code as whatever ~/.claude is logged in as
```

## Not affiliated with Anthropic

claudep is an independent, unofficial tool written by me, Gustavo Bordoni. I have no affiliation with Anthropic. Anthropic has not endorsed, sponsored, reviewed or supported this project in any way. "Claude" and "Claude Code" are Anthropic's names and trademarks and appear here only to describe what the tool works with. Use it at your own risk and under the terms of your own Claude account.

## Install

Requires [bun](https://bun.sh) and an existing Claude Code install (`claude` on your PATH).

```sh
bun add -g @bordoni/claudep        # or: npm install -g @bordoni/claudep  (bun is still what runs it)
bunx @bordoni/claudep --help       # try it without installing
```

The package name is `@bordoni/claudep` and the command it installs is `claudep`. The same package is mirrored to GitHub Packages, which needs a token with `read:packages` even for public installs; `.ref/releasing.md` has the `.npmrc` lines.

Or clone and symlink it anywhere on your PATH:

```sh
git clone git@github.com:bordoni/claudep.git ~/workspace/claudep
ln -s ~/workspace/claudep/claudep.ts ~/.local/bin/claudep
```

### Windows

claudep runs natively on Windows from PowerShell 5.1, PowerShell 7 and Git Bash. Install it with bun, which writes `claudep.exe` into `%USERPROFILE%\.bun\bin`:

```powershell
bun add -g @bordoni/claudep
```

Two things differ from macOS:

- Profiles share configuration through symlinks, and Windows lets a normal user create symlinks only with Developer Mode on (Settings > For developers > Developer Mode). `claudep init` stops and says so when it is off. Turn it on, open a new terminal and run the same command again.
- There is no keychain. Claude Code keeps each profile's login in `<profile>\.credentials.json`, and `claudep doctor` checks that the file is there.

`claudep env` prints PowerShell syntax when run from PowerShell and sh syntax from Git Bash, so `claudep env work | Invoke-Expression` and `eval "$(claudep env work)"` both work. Git Bash otherwise behaves like bash elsewhere: put `eval "$(claudep shell-init bash)"` in `~/.bashrc`. An npm-installed `claude.cmd` runs through cmd.exe; the native installer's `claude.exe` avoids that hop and is what `claudep doctor` recommends. cmd.exe itself is not supported.

## Usage

```
claudep <name> [claude args…]        run claude with profile <name>
claudep init <name> [options]        create/update a profile; logs in when it has no login yet
claudep list [--json] [--live]       every profile and who it is logged in as
claudep status <name> [--json] [--live]   login state for one profile ("default" = ~/.claude)
claudep env <name> [--shell <sh>]    print the CLAUDE_CONFIG_DIR pin for eval, source or Invoke-Expression
claudep vars <name> [KEY=VALUE…]     list or set the variables a profile exports (see below)
claudep alias <name> <command>       write a shim so "<command>" == "claudep <name>"; rewrites one claudep wrote
claudep alias [--json]               list every shim on PATH and its state
claudep settings <name> [key=value…] settings one profile gets on top of the shared settings.json (see below)
claudep handoff <name> [session-id]  carry this directory's latest session on under another profile
claudep usage [name…] [--json]       five-hour and weekly usage for every profile
claudep statusline                   statusline segment with the profile and its usage (reads stdin)
claudep current [--json|--name]      which profile this shell is on, and why
claudep doctor [name] [--json]       verify symlinks, keychain entry, unclassified files, shims, Claude Code version
claudep doctor --accept <name> <item>   stop counting one shared item as a problem; --unaccept undoes it
claudep rm <name> [--keep-login]     log out and delete a profile (base is never touched)
claudep local <name> | --remove      pin the current directory tree to a profile (see below)
claudep resolve [dir]                print the profile pinned for a directory
claudep shell-init [zsh|bash|fish|powershell]   print the hook that applies pins on cd
claudep completion [zsh|bash|fish|powershell]   print tab completions for commands, flags and profile names
claudep --version
```

`init` options: `--sso`, `--email <addr>`, `--console`, `--copy-mcp`, `--alias <command>`, `--env KEY=VALUE` (repeatable), `--no-login`, `--force`. Run `claudep help` for the full text.

`claudep init` on a profile that is already signed in does not start a login. Pass `--sso`, `--console` or `--email` to log in again, or run `claudep <name> auth login`. Login flags are saved in `<profile>/claudep.login`, even with `--no-login`, so the next `init` logs in the same way and `claudep status`, `doctor` and `init --no-login` print the full command.

## Keeping profiles in sync

`claudep <name>`, `claudep run` and alias commands link any shared file or directory the profile is missing before they start claude, and say so on stderr: `claudep: linked CLAUDE.md into work`. That covers `CLAUDE.md`, `settings.json`, `keybindings.json`, `statusline-command.sh` and the shared directories when they appear in `~/.claude` after `init`. Other top-level `*.md` files wait for `claudep init <name>`, because a new one could be per-instance state. A launch never replaces a real file or directory, and a failed link never stops claude from starting. It adds no links when your shell sets `CLAUDE_CONFIG_DIR` to a directory outside the profiles root, or when every shared link in the profile points at another base.

`claudep doctor` explains a real item that hides the shared one. For a directory it counts what links into the base and names what only the profile has. For `settings.json` it lists the top-level keys that differ, by name only, and which ones `claudep settings` can carry. Both print the commands that share it:

```sh
mv ~/.claudep/work/skills ~/.claudep/work/skills.old && claudep init work --no-login
```

When the difference is what you want, say so and doctor stops counting it. The choice lives in `<profile>/claudep.doctor`:

```sh
claudep doctor --accept work settings.json     # shown as info, exit 0
claudep doctor --unaccept work settings.json   # a problem again
```

A launch and `claudep init` leave an accepted item as it is; `claudep init --force` links it anyway.

`claudep doctor --json` prints `{schemaVersion, claude, base, profiles, aliases, problems}`, each check as `{item, state, level, message, fix?, problem}`, with the same exit code as the text output: 1 when `problems` is above zero.

`claudep alias` lists every shim on PATH with its profile, target and state: `ok`, `missing-target`, `other-target`, `missing-profile` or `shadowed`. `claudep alias <name> <command>` rewrites a shim claudep wrote, in the directory it already sits in, and leaves any other file alone, including a symlink. The names `claude` and `claudep` are refused. `claudep doctor` fails on a shim that cannot start and warns on one that runs another claudep, with the command that fixes it. After switching how claudep is installed, run the `claudep alias` line it prints for each one.

## Pin a profile to a directory

A file named `.claudep` at the top of a repo names the profile every hooked shell should use inside that tree, the way `.nvmrc` names a Node version. Commit it and the whole team inherits the pin.

```sh
cd ~/work/acme
claudep local enterprise          # writes ./.claudep containing "enterprise"
```

Shells apply pins through a hook. Add one line to `~/.zshrc` (or `~/.bashrc` with `bash`, including Git Bash on Windows):

```sh
eval "$(claudep shell-init zsh)"
```

In fish the line goes in `~/.config/fish/config.fish`, and in PowerShell in `$PROFILE`:

```fish
claudep shell-init fish | source
```

```powershell
claudep shell-init powershell | Out-String | Invoke-Expression
```

From then on, `cd` into a pinned tree sets `CLAUDE_CONFIG_DIR` for that profile, plus the profile's own variables, and `cd` out of it returns the shell to `~/.claude`. The hook is pure shell with no subprocess (builtins in fish, cmdlets only in PowerShell), so it costs nothing at the prompt. The rules:

- The nearest `.claudep` file upward from the current directory wins. An empty one cancels a parent pin.
- The hook only changes a `CLAUDE_CONFIG_DIR` it set itself. It tracks that in `CLAUDEP_AUTO`, so a manual pin from `eval "$(claudep env work)"` (`claudep env work | source` in fish, `claudep env work | Invoke-Expression` in PowerShell) or a plain `export` stays put until you `eval "$(claudep env --unset)"`.
- `claudep <name>`, `claudep run`, `claudep handoff` and alias commands put `CLAUDEP_RUN=<profile dir>` in claude's environment and drop an inherited `CLAUDEP_AUTO`, so inside that session `claudep current` says `set by: claudep run` and the hook leaves the session's profile alone.
- A pin that names a profile you have not created prints one warning per directory change and sets nothing.

`claudep env` prints the syntax of the shell it runs in: it looks at its parent process (fish, pwsh, or an sh-like shell) and falls back to your login shell. Pass `--shell sh|fish|powershell` when neither answer fits, for example from a script or a Makefile.

`claudep current` tells you which profile the shell is on and how it got there (hook, manual pin, or nothing). `claudep list` adds the same line at the bottom.

## Per-profile variables

A profile can carry environment variables that go with its account, such as a Bedrock or Vertex setup, or the Console sign-in Claude Code should use:

```sh
claudep vars bedrock CLAUDE_CODE_USE_BEDROCK=1 AWS_PROFILE=bedrock AWS_REGION=us-east-1
claudep vars work ANTHROPIC_PROFILE=work      # pick a Console sign-in from ~/.config/anthropic
claudep vars work                             # list them
claudep vars work --unset ANTHROPIC_PROFILE   # remove one
claudep init vertex --env CLAUDE_CODE_USE_VERTEX=1 --env CLOUD_ML_REGION=us-east5
```

They live in `~/.claudep/<name>/claudep.env`, one `KEY=VALUE` per line. `claudep <name>` and alias commands pass them to Claude Code, `claudep env <name>` prints them with the pin, and the shell hook exports them while you are inside a pinned tree and clears them when you leave. The file is read as data and never run, by claudep and by every hook.

- A variable you set yourself always wins. The hook and `claudep env` leave it alone, and `claudep <name>` passes your value.
- `CLAUDEP_ENV_KEYS` lists what a `claudep.env` put in the shell, so moving to another pinned profile or running `claudep env --unset` clears exactly those.
- `CLAUDE_CONFIG_DIR`, `CLAUDE_SECURESTORAGE_CONFIG_DIR`, `CLAUDEP_*` and the credential variables in `CREDENTIAL_ENV` are refused, including `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, `MCP_CLIENT_SECRET`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` and `AWS_BEARER_TOKEN_BEDROCK`. claudep does not store Claude Code's credentials. General-purpose tokens such as `GITHUB_TOKEN` are not on the list. Variables that hold a path or a profile name, such as `AWS_PROFILE` or `ANTHROPIC_IDENTITY_TOKEN_FILE`, are fine. A refused line in an existing file is skipped, and `claudep <name>`, `claudep env`, `claudep vars` and `claudep doctor` name its line number.
- Values are one line, not empty, with no spaces at either end. `claudep vars` edits the file in place and keeps your comments. `claudep doctor` lists each profile's variable names and reports lines nothing reads.
- A shell that is already inside a pinned tree picks up a change on the next `cd`.

## Per-profile settings

`settings.json` is shared. For the few settings one account needs differently, give the profile its own:

```sh
claudep settings work model=opus                 # values are JSON when they parse, otherwise a string
claudep settings work syncClaudeAiSkills=false   # stop syncing this account's claude.ai skills
claudep settings work                            # list them
claudep settings work --unset model              # remove one
```

They live in `~/.claudep/<name>/claudep.settings.json`. `claudep <name>`, `claudep run` and alias commands pass them to Claude Code with `--settings`, which ranks above your user and project settings and below managed ones. Plain `claude` in a shell the hook or `claudep env` set up does not see them, and neither does a run where you pass your own `--settings`. `env` is refused here; use `claudep vars`. `claudep doctor` lists the keys and fails on a file that is not a JSON object.

## Tab completion

One line in your rc file completes subcommands, their flags, the values `--shell`, `shell-init` and `completion` take, and your profile names:

```sh
eval "$(claudep completion zsh)"      # ~/.zshrc, after compinit
eval "$(claudep completion bash)"     # ~/.bashrc
```

```fish
claudep completion fish | source      # ~/.config/fish/config.fish
```

```powershell
claudep completion powershell | Out-String | Invoke-Expression   # $PROFILE, pwsh or Windows PowerShell 5.1
```

Windows PowerShell 5.1 does not hand a bare `-` or `--` to a completer, so type the first letter of a flag there: `claudep init --e<Tab>`. pwsh completes `--<Tab>` too.

Profile names come from a directory listing of `~/.claudep` at the moment you press Tab (`Get-ChildItem` in PowerShell), so the script never runs claudep and a new profile shows up without reloading anything. In zsh the same output also works as a file: `claudep completion zsh > ~/.zfunc/_claudep` with `~/.zfunc` on `fpath` before `compinit`, if you prefer autoloading over `eval`.

## Show the profile in your prompt or statusline

In a shell prompt use the variable itself; no command runs:

```sh
# zsh or bash: the last path segment is the profile name when a profile is active
PROMPT='${CLAUDE_CONFIG_DIR:+[${CLAUDE_CONFIG_DIR##*/}] }'"$PROMPT"
```

```fish
# fish
function fish_prompt; set -q CLAUDE_CONFIG_DIR; and echo -n "[$(string replace -r '.*/' '' -- $CLAUDE_CONFIG_DIR)] "; ...; end
```

In scripts, and in the shared `statusline-command.sh`, `claudep current --name` prints exactly one word: the profile name, `default` for `~/.claude`, or `custom` for a `CLAUDE_CONFIG_DIR` outside the profiles root. The statusline script inherits Claude Code's environment, so it sees the profile the session was started with.

To show usage too, pipe the statusline input to `claudep statusline`. It prints `work · 5h 23% · 7d 41%` from the `rate_limits` Claude Code hands every statusline, and remembers the numbers for `claudep usage`:

```sh
# in statusline-command.sh
input=$(cat)
segment=$(printf '%s' "$input" | claudep statusline)
```

It starts bun on every render, about 30 ms here, and writes `~/.claudep/.usage/<name>.json` only when the numbers change. API-key, Bedrock and Vertex sessions get no `rate_limits`, so the segment is just the name.

## Usage limits per profile

```sh
claudep usage                # every profile: five-hour and weekly use, when each resets, how fresh
claudep usage work --json    # one profile, with the per-model weekly windows
```

From Claude Code 2.1.301 on, `claudep usage` asks each profile with `claude -p /usage`, which reports usage without running the model and, with `--no-session-persistence`, writes no transcript. Older versions can sign a profile out on a short command like that ([anthropics/claude-code#95822](https://github.com/anthropics/claude-code/issues/95822)), so there it shows the numbers last seen by `claudep statusline` or an earlier run instead. `--live` asks anyway, `--cached` never asks. claudep never reads a token: Claude Code makes every request.

## Hand a session to another profile

When one account hits its limit, carry on in another:

```sh
claudep handoff personal                # newest session in this directory, resumed under "personal"
claudep handoff personal <session-id>   # a specific one
claudep handoff work -- -p "go on"      # anything after -- goes to claude
```

`projects/` is shared, so every profile can read every transcript. `handoff` finds the newest one for the current directory and runs `claude --resume <id> --fork-session` under the other profile. The fork gets a new session id, so the original session can keep running without two processes writing one file. The first reply is slower and costs more than usual: the prompt cache belongs to the account that built it.

## Exit codes

`claudep <name>`, `claudep run`, `claudep handoff` and alias commands exit with claude's own code. When claudep itself stops before claude starts, it uses a code from sysexits.h, so a script can tell the two apart:

| Code | Meaning |
|---|---|
| 64 | Usage error or an invalid profile name |
| 67 | The profile does not exist |
| 69 | `claude` is not on PATH, is still missing after an update, or only a `.ps1` was found |
| 75 | In print mode (`-p`), claude stopped on a usage limit or billing error: `rate_limit`, `billing_error` |
| 77 | In print mode, claude stopped because the login no longer works: `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `verification_required`, `cloud_credential_error` |
| 78 | The profile's `claudep.settings.json` cannot be read, or `CLAUDE_CONFIG_DIR` is set but empty |

Other commands exit 0 on success and 1 on failure, except that an invalid profile name is 64 everywhere.

### Login markers

Every `claudep <name>`, `run`, `handoff` and alias command adds a StopFailure hook to the `--settings` it passes. When a turn ends on one of the errors above, Claude Code runs `claudep hook stop-failure`, which writes the error's name and the time to `~/.claudep/.health/<name>.json`. It reads no token and prints nothing. From then on:

- a print-mode run that recorded the error exits 77 or 75 instead of claude's 1, with the login command on stderr;
- `claudep list` and `status` show `needs login` and when it was seen, `--json` adds `failure: {error, at}`, and `doctor` fails the profile with the login command;
- the next run that exits 0 clears the marker.

`claude auth status` reports a login whose refresh token has stopped working as logged in, so the marker is the only place that failure shows. Passing your own `--settings` leaves the hook out. For shells that start plain `claude`, `claudep hook --print` prints the settings block that calls the hook; add it to a `settings.json` yourself, since claudep never writes one.

## Claude Code updates

Install Claude Code with the native installer when you use profiles. Each profile is its own config dir, so each runs its own auto-updater. With the native installer an update unpacks a new version and swaps one symlink, so `claude` is always there. With an npm or bun global install every profile reinstalls the same package, and `claude` is gone while the reinstall runs ([anthropics/claude-code#93197](https://github.com/anthropics/claude-code/issues/93197)). Move with `claude install`.

- `claudep <name>`, `claudep run` and alias commands wait when `claude` is missing: up to five minutes while any config dir holds a fresh `.update.lock`, five seconds otherwise.
- `claudep doctor` names the install method, every `claude` on PATH, whether each config dir runs the updater and why, including `env` in managed settings (`managed-settings.json` and `managed-settings.d/`), and each one's last update. On npm or bun it warns when more than one config dir updates. Leave one on and turn the rest off with `claudep vars <name> DISABLE_AUTOUPDATER=1`.
- `DISABLE_AUTOUPDATER=1` in the shared `settings.json` `env` turns the updater off in every profile at once. `claude update` still works by hand.

## How it works

`~/.claude` is left exactly as it is and stays the **default** profile. Each named profile is a thin directory under `~/.claudep/<name>`. Inside it, shared configuration is a symlink back into `~/.claude`:

| Shared (symlinked) | Per profile (real files) |
|---|---|
| `CLAUDE.md` and other top-level `*.md` | `.claude.json` (login identity, user-scope MCP servers, folder trust) |
| `settings.json`, `keybindings.json`, `statusline-command.sh` | org-pushed `remote-settings.json`, `policy-limits.json` |
| `hooks/`, `skills/`, `commands/`, `agents/`, `rules/`, `output-styles/`, `themes/`, `workflows/` | `history.jsonl`, `todos/`, `sessions/`, `teams/`, caches, telemetry |
| `plugins/`, `plans/`, `projects/` (session transcripts and auto-memory) | credentials |

On macOS, credentials never touch the profile directory: Claude Code stores them in the Keychain under `Claude Code-credentials-<sha256(CLAUDE_CONFIG_DIR)[0:8]>`, so every profile has its own login and refresh token and they cannot overwrite each other. I verified this against Claude Code 2.1.259. An older bug where every config dir shared one Keychain entry no longer applies. On Linux and Windows the login is `<profile>/.credentials.json`, a real file inside the profile that is never shared.

The shared list is an allowlist, so an account-specific file cannot leak across profiles by accident. `claudep doctor` reports any base file that is neither shared nor known-private. That is how you notice when a new Claude Code version adds something.

## Notes

- The first time you open a repository under a new profile you will re-accept folder trust, and claude.ai connectors need their OAuth redone in that profile.
- Two profiles running at the same time write the same `settings.json` and `plugins/`. That is the same situation as two terminals today.
- In Claude Code 2.1.311, background sessions (`claude --bg`) under a profile get their own on-demand supervisor, which keeps its files in the profile. `claude daemon install` still refuses a profile, and a server flag currently turns it off for every config dir, `~/.claude` included.
- Since Claude Code 2.1.280, every auto-memory write in a profile asks for approval, and auto mode cannot give it. The memory directory sits under the shared `projects/` symlink, and Claude Code now checks a write at the path it lands on, `~/.claude/projects/...`, which it treats as sensitive. This is [anthropics/claude-code#98044](https://github.com/anthropics/claude-code/issues/98044), open upstream. `claudep <name>`, `claudep run` and alias commands avoid it: they pass the real memory path with `--settings`, unless you pass your own `--settings`. Plain `claude` in a shell the hook or `claudep env` set up still asks. `claudep doctor` warns while your Claude Code is affected. The default profile is not.
- Skills and plugins synced from claude.ai land in the shared `skills/synced/` and `plugins/synced/`, in one folder per account, so profiles do not mix them. The `syncClaudeAiSkills` and `syncClaudeAiPlugins` switches live in the shared `settings.json`; to change one for a single profile, use `claudep settings <name> syncClaudeAiSkills=false`.
- Console sign-ins made without an API key live in `~/.config/anthropic`, outside every config dir, so all profiles see the same ones. `ANTHROPIC_PROFILE` picks which one Claude Code uses; set it per profile with `claudep vars <name> ANTHROPIC_PROFILE=<sign-in>`.
- In VS Code, `CLAUDE_CONFIG_DIR` in `claudeCode.environmentVariables` must be an absolute path. The session list ignores it when `claudeProcessWrapper` is set.
- `claudep list`, `status`, `usage` and `doctor` give each `claude` they start 30 seconds. One that has not answered by then is stopped (SIGTERM, then SIGKILL three seconds later) and its row shows `timeout` with what `.claude.json` or the last `usage` run recorded; `--json` adds `"timedOut": true`. Set `CLAUDEP_TIMEOUT=<seconds>` to change it, `0` to wait forever. `claudep <name>`, `run` and `handoff` are never stopped.
- Set `CLAUDE_PROFILES_DIR` to move the profiles root. Keep it out of iCloud or Dropbox; `.claude.json` is rewritten constantly and sync tools create conflict copies.
- Never put `CLAUDE_CONFIG_DIR` in a `settings.json` `env` block. Claude Code detects that mismatch and disables features; `claudep doctor` reports it.
- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` override the login in any config dir, always in `-p` mode. `claudep <name>` and `claudep doctor` warn when one is set and leave it alone. `claudep doctor` also names the key source Claude Code reports, and fails when Claude Code reports a config dir other than the profile's.
- `CLAUDE_SECURESTORAGE_CONFIG_DIR` moves Claude Code's credential store away from the config dir, so one inherited value puts every profile on one login. `claudep <name>`, `claudep run`, alias commands and `claudep doctor` warn when it is set to anything but the profile dir.
- An empty `CLAUDE_CONFIG_DIR` makes Claude Code use the current directory as its config dir ([anthropics/claude-code#104629](https://github.com/anthropics/claude-code/issues/104629)). `claudep current`, `claudep run default` and `claudep doctor` stop on it and tell you to run `unset CLAUDE_CONFIG_DIR`. Running a named profile still works, because claudep sets the variable itself.
- With `--add-dir ~/.claude/projects`, Claude Code also loads `~/.claude/CLAUDE.md` as project instructions through the parent walk. Once `CLAUDE.md` is linked into a profile, that session loads it twice. Narrow the `--add-dir` to the folder you need.
- `claudep doctor` fails on macOS when Claude Code is older than 2.1.144, the first build whose Keychain item is namespaced per config dir.
- Before Claude Code 2.1.301 a short `claude auth status` can spend a profile's refresh token and sign it out ([anthropics/claude-code#95822](https://github.com/anthropics/claude-code/issues/95822)). On those versions `claudep list`, `status` and `doctor` show the account recorded in the profile's `.claude.json`, marked `*`, and do not ask Claude Code. `--live` asks anyway. Update Claude Code to get live answers back.

## Releases

Versions, dates and changes are in [`CHANGELOG.md`](./CHANGELOG.md). Releases are tagged with the bare version, `0.1.0`, and published to npm with provenance by GitHub Actions.

## Development

```sh
bun install        # dev tooling only; nothing ships with the tool
bun run check      # typecheck, lint, tests. Same as CI
```

To work on the script, start with [`AGENTS.md`](./AGENTS.md). The detail lives in [`.ref/`](./.ref/).

## License

MIT
