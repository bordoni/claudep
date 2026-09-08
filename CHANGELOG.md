# Changelog

All notable changes to claudep are recorded here. Add a line under **Unreleased** in the same change that a user could notice; `bun run release` moves that block under a version heading and tags it.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the version numbers follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- fish support: `claudep shell-init fish` prints a hook for `config.fish` that follows `.claudep` pins on `cd` using builtins only, and `claudep env` prints `set -gx` and `set -e` lines when run from fish. Load both with `| source`. Needs fish 3.0 or later.
- `claudep env` looks at the shell it runs in (fish, pwsh, or an sh-like shell) before falling back to `$SHELL`, and `--shell sh|zsh|bash|fish|powershell` overrides both. `claudep env <name> | Invoke-Expression` works in pwsh on macOS and Linux as a result.
- `claudep current --name` prints only the profile name (`default` for `~/.claude`, `custom` for a config dir outside the profiles root), for prompts, scripts and the statusline.
- `claudep list --json` prints the same flat objects as `claudep status --json`, one per profile.
- `claudep doctor` fails when the shared `settings.json` sets `env.CLAUDE_CONFIG_DIR`, and on macOS when Claude Code is older than 2.1.144, the first build whose Keychain item is namespaced per config dir.
- `claudep doctor` and `claudep <name>` warn when `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN` is set, because Claude Code uses it instead of the profile's login. The variable is left alone.
- `claudep rm` says when the shell is on the profile being removed or the current directory pins it, and names the command that clears each.
- CI runs the shell hook in fish on macOS and Linux.

## [0.2.1] - 2026-09-08

### Changed

- `rules/`, `output-styles/`, `themes/` and `workflows/` are shared with every profile, matching what Claude Code 2.1.263 reads from the user config directory. A custom theme named in the shared `settings.json` now resolves inside a profile. Existing profiles pick the links up on their next `claudep init <name>`.
- `teams/`, `uploads/`, `usage-data/`, `mcp-discovery-cache/`, `mcp-skill-archives/`, `daemon.json`, `launch.json`, `scheduled_tasks.json` and `seed-admin` are known-private, so `claudep doctor` no longer reports them as unclassified.
- The README notes that `claude --bg` sessions and `claude daemon install` do not work under a profile in Claude Code 2.1.263.

## [0.2.0] - 2026-09-07

### Added

- Windows support, from PowerShell 5.1, PowerShell 7 and Git Bash, with a native `claude.exe` or an npm-installed `claude.cmd`. Install with `bun add -g @bordoni/claudep`. cmd.exe is not a target. The README has a Windows section.
- `claudep init` on Windows stops with instructions to turn on Developer Mode when Windows refuses to create a symlink, and finishes the profile on the next run. Symlinks are always created with their kind, which Windows needs and other systems ignore.
- `claudep shell-init powershell` prints a hook for `$PROFILE` that follows `.claudep` pins by wrapping `prompt`. `shell-init` with no argument picks the shell from `$SHELL`, or PowerShell on Windows outside Git Bash.
- `claudep env` prints `$env:` syntax when run from PowerShell, so `claudep env work | Invoke-Expression` works there and `eval "$(claudep env work)"` keeps working in Git Bash and elsewhere.
- `claudep alias` on Windows writes `<command>.cmd`, which PowerShell finds through `PATHEXT`, next to the sh shim Git Bash runs.
- An npm-installed `claude.cmd` is launched through cmd.exe; `claude.exe` is preferred when both are on PATH, and `claudep doctor` says which one it found.
- `claudep current` and `claudep doctor` warn on Windows when `CLAUDE_CONFIG_DIR` is a POSIX-style path that `claude.exe` cannot read.
- CI runs the suite on Windows as well as macOS and Linux, including the shell hook under Git Bash, `pwsh` and Windows PowerShell 5.1.

### Changed

- `claudep doctor` on Linux and Windows checks that the profile has a `.credentials.json` instead of printing `keychain check skipped`. `Thumbs.db` and `desktop.ini` are known-private.
- Path comparisons for pins, the `claudep rm` safety check and `~` shortening accept `~\`, drive letters and MSYS `/c/` paths, and are case-insensitive on Windows only. No behaviour change on macOS or Linux.
- `claudep rm` unlinks the shared items itself before deleting the profile directory.
- The bash hook under Git Bash exports the native `C:\` path for the pinned profile while still walking the POSIX `$PWD`.

### Fixed

- The shell hook reads `.claudep` pin files with CRLF line endings. The `\r` used to become part of the profile name.

## [0.1.1] - 2026-09-03

### Fixed

- The 0.1.0 tarball on npm was published by hand from a commit that predates the notice that claudep is independent and not affiliated with Anthropic. This release is the same code with the notice in the README, in `claudep help` and in the package description.

## [0.1.0] - 2026-09-03

### Added

- Profiles under `~/.claudep/<name>`, each a thin directory Claude Code is pointed at through `CLAUDE_CONFIG_DIR`. `~/.claude` stays untouched and remains the default.
- Shared configuration through a symlink allowlist: `CLAUDE.md` and other top-level `*.md`, `settings.json`, `keybindings.json`, `statusline-command.sh`, `hooks/`, `skills/`, `commands/`, `agents/`, `plugins/`, `plans/` and `projects/`. Login identity, `.claude.json`, org-pushed settings and runtime state stay per profile.
- `claudep init <name>` with `--sso`, `--email`, `--console`, `--copy-mcp`, `--alias`, `--no-login` and `--force`. Seeds `.claude.json` so first-run onboarding does not repeat.
- `claudep <name> [args]` and `claudep run` to launch Claude Code under a profile, `claudep list`, `claudep status --json`, `claudep env <name>` and `claudep env --unset`.
- `claudep alias <name> <command>` writes a shim such as `eclaude` next to the `claudep` on PATH.
- `claudep doctor` checks every symlink, reports base files that are neither shared nor known-private, and confirms the macOS Keychain item for each profile.
- `claudep rm` logs out first so the token is revoked and the Keychain item removed, then deletes only what lives under the profiles root.
- `claudep current` reports which profile the shell is on and how it was set.
- Directory pins: a `.claudep` file names the profile for a directory tree. `claudep local`, `claudep resolve` and `claudep shell-init zsh|bash` manage and apply pins; the hook only touches a `CLAUDE_CONFIG_DIR` it set itself.
- `claudep --version`.
- Published as `@bordoni/claudep` on npm and GitHub Packages; the installed command is `claudep`.
- A clear notice in the README, in `claudep help` and in the package description that this is an independent tool with no affiliation to Anthropic.
- Keychain isolation per config dir verified against Claude Code 2.1.259: the service name is `Claude Code-credentials-<sha256(dir)[0:8]>`.
- Test suite with `bun test`, a sandboxed `$HOME`, a fake `claude` and `security` on PATH, and a real-shell test for the hook. CI runs typecheck, lint and tests on macOS and Linux.

[Unreleased]: https://github.com/bordoni/claudep/compare/0.2.1...HEAD
[0.2.1]: https://github.com/bordoni/claudep/compare/0.2.0...0.2.1
[0.2.0]: https://github.com/bordoni/claudep/compare/0.1.1...0.2.0
[0.1.1]: https://github.com/bordoni/claudep/compare/0.1.0...0.1.1
[0.1.0]: https://github.com/bordoni/claudep/releases/tag/0.1.0
