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
claudep init <name> [options]        create/update a profile and log in
claudep list [--json]                every profile and who it is logged in as
claudep status <name> [--json]       login state for one profile ("default" = ~/.claude)
claudep env <name> [--shell <sh>]    print the CLAUDE_CONFIG_DIR pin for eval, source or Invoke-Expression
claudep alias <name> <command>       write a shim so "<command>" == "claudep <name>"
claudep current [--json|--name]      which profile this shell is on, and why
claudep doctor [name]                verify symlinks, keychain entry, unclassified files, Claude Code version
claudep rm <name> [--keep-login]     log out and delete a profile (base is never touched)
claudep local <name> | --remove      pin the current directory tree to a profile (see below)
claudep resolve [dir]                print the profile pinned for a directory
claudep shell-init [zsh|bash|fish|powershell]   print the hook that applies pins on cd
claudep --version
```

`init` options: `--sso`, `--email <addr>`, `--console`, `--copy-mcp`, `--alias <command>`, `--no-login`, `--force`. Run `claudep help` for the full text.

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

From then on, `cd` into a pinned tree sets `CLAUDE_CONFIG_DIR` for that profile and `cd` out of it returns the shell to `~/.claude`. The hook is pure shell with no subprocess (builtins in fish, cmdlets only in PowerShell), so it costs nothing at the prompt. The rules:

- The nearest `.claudep` file upward from the current directory wins. An empty one cancels a parent pin.
- The hook only changes a `CLAUDE_CONFIG_DIR` it set itself. It tracks that in `CLAUDEP_AUTO`, so a manual pin from `eval "$(claudep env work)"` (`claudep env work | source` in fish, `claudep env work | Invoke-Expression` in PowerShell) or a plain `export` stays put until you `eval "$(claudep env --unset)"`.
- A pin that names a profile you have not created prints one warning per directory change and sets nothing.

`claudep env` prints the syntax of the shell it runs in: it looks at its parent process (fish, pwsh, or an sh-like shell) and falls back to your login shell. Pass `--shell sh|fish|powershell` when neither answer fits, for example from a script or a Makefile.

`claudep current` tells you which profile the shell is on and how it got there (hook, manual pin, or nothing). `claudep list` adds the same line at the bottom.

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
- Background sessions and the daemon are tied to `~/.claude`. As of Claude Code 2.1.263, `claude daemon install` refuses to run with `CLAUDE_CONFIG_DIR` set, and `claude --bg` under a profile runs without the daemon.
- Set `CLAUDE_PROFILES_DIR` to move the profiles root. Keep it out of iCloud or Dropbox; `.claude.json` is rewritten constantly and sync tools create conflict copies.
- Never put `CLAUDE_CONFIG_DIR` in a `settings.json` `env` block. Claude Code detects that mismatch and disables features; `claudep doctor` reports it.
- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` override the login in any config dir, always in `-p` mode. `claudep <name>` and `claudep doctor` warn when one is set and leave it alone.
- `claudep doctor` fails on macOS when Claude Code is older than 2.1.144, the first build whose Keychain item is namespaced per config dir.

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
