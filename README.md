# claudep

Run [Claude Code](https://code.claude.com) under separate accounts on one machine, for example a company Enterprise org and a personal Max plan, with fully isolated logins and shared configuration.

Claude Code has no built-in account switching. `claudep` is a single dependency-free [bun](https://bun.sh) script that manages named **profiles**, each pointed at Claude Code through `CLAUDE_CONFIG_DIR`.

```
claudep init enterprise --sso --email you@company.com --alias eclaude
eclaude          # Claude Code as the enterprise account
claude           # Claude Code as whatever ~/.claude is logged in as
```

## Install

Requires bun and an existing Claude Code install (`claude` on your PATH).

```sh
bun install -g github:bordoni/claudep
```

Or clone and symlink it anywhere on your PATH:

```sh
git clone git@github.com:bordoni/claudep.git ~/workspace/claudep
ln -s ~/workspace/claudep/claudep.ts ~/.local/bin/claudep
```

## Usage

```
claudep <name> [claude args…]        run claude with profile <name>
claudep init <name> [options]        create/update a profile and log in
claudep list                         every profile and who it is logged in as
claudep status <name> [--json]       login state for one profile ("default" = ~/.claude)
claudep env <name>                   print "export CLAUDE_CONFIG_DIR=…" for eval
claudep alias <name> <command>       write a shim so "<command>" == "claudep <name>"
claudep doctor [name]                verify symlinks, keychain entry, unclassified files
claudep rm <name> [--keep-login]     log out and delete a profile (base is never touched)
```

`init` options: `--sso`, `--email <addr>`, `--console`, `--copy-mcp`, `--alias <command>`, `--no-login`, `--force`. Run `claudep help` for the full text.

## How it works

`~/.claude` is left exactly as it is and stays the **default** profile. Each named profile is a thin directory under `~/.claudep/<name>`. Inside it, shared configuration is a symlink back into `~/.claude`:

| Shared (symlinked) | Per profile (real files) |
|---|---|
| `CLAUDE.md` and other top-level `*.md` | `.claude.json` (login identity, user-scope MCP servers, folder trust) |
| `settings.json`, `keybindings.json`, `statusline-command.sh` | org-pushed `remote-settings.json`, `policy-limits.json` |
| `hooks/`, `skills/`, `commands/`, `agents/`, `plugins/`, `plans/` | `history.jsonl`, `todos/`, `sessions/`, caches, telemetry |
| `projects/` (session transcripts and auto-memory) | credentials |

Credentials never touch the profile directory. On macOS, Claude Code stores them in the Keychain under `Claude Code-credentials-<sha256(CLAUDE_CONFIG_DIR)[0:8]>`, so every profile has its own login and refresh token and they cannot overwrite each other. This was verified against Claude Code 2.1.259; an older bug where all config dirs shared one Keychain entry no longer applies.

The shared list is an explicit allowlist, so account-specific files can never leak across profiles by accident. `claudep doctor` reports any base file that is neither shared nor known-private, which is how you notice when a new Claude Code version adds something.

## Notes

- The first time you open a repository under a new profile you will re-accept folder trust, and claude.ai connectors need their OAuth redone in that profile.
- Two profiles running at the same time write the same `settings.json` and `plugins/`. That is the same situation as two terminals today.
- Set `CLAUDE_PROFILES_DIR` to move the profiles root. Keep it out of iCloud or Dropbox; `.claude.json` is rewritten constantly and sync tools create conflict copies.
- Never put `CLAUDE_CONFIG_DIR` in a `settings.json` `env` block. Claude Code detects that mismatch and disables features.

## Contributing

Working on the script? Start with [`AGENTS.md`](./AGENTS.md); the detail lives in [`.ref/`](./.ref/).

## License

MIT
