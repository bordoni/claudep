# Windows

What claudep relies on when it runs on Windows, and what the Windows CI job proves. Facts about Claude Code were checked against the docs at code.claude.com on 2026-09-06; facts about bun against the oven-sh/bun source on the same day.

## Targets

PowerShell 5.1 and PowerShell 7 with a native `claude.exe`, and Git Bash (MSYS2). cmd.exe is not a target: it has no per-prompt hook, so pins cannot follow `cd` there. WSL is Linux and needs nothing from this file.

## What Claude Code does on Windows

- The native installer (`irm https://claude.ai/install.ps1 | iex`) puts `claude.exe` in `%USERPROFILE%\.local\bin` and versions under `%USERPROFILE%\.local\share\claude`. WinGet installs the same binary. An npm install leaves `claude.cmd` and `claude.ps1` shims in npm's global bin.
- There is no keychain. Credentials are `<CLAUDE_CONFIG_DIR>\.credentials.json`, plain JSON with the user profile's ACL. `CLAUDE_CONFIG_DIR` is honoured exactly as on macOS and `.claude.json` moves inside it; the JS bundle is the same on every platform.
- `claudep doctor` checks that the file exists and never reads it. The macOS Keychain service hash does not apply, but `canon()` still produces one spelling per profile because Claude Code compares the literal `CLAUDE_CONFIG_DIR` string in places.
- Never symlink `claude.exe` itself. The auto-updater replaces it.

## Symlinks and Developer Mode

- bun's `fs.symlink` on Windows goes through libuv, which passes `SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE`. A normal user can create file and directory symlinks once Developer Mode is on (Settings > For developers > Developer Mode). With it off, the call fails with `EPERM`.
- `link()` returns `"denied"` for `EPERM` and `init` stops with the Developer Mode instruction. There is no junction or copy fallback; see `design-decisions.md`.
- The third argument to `symlink` (`"file"` or `"dir"`) is load-bearing on Windows. `link()` always passes the item's kind.
- `readlinkSync` returns libuv's substitute name. It can carry a `\\?\` prefix or a different drive-letter case, so `link()` and `linkState()` compare with `samePath()`.
- GitHub's `windows-latest` runner is elevated with UAC off, so symlinks succeed there without Developer Mode. The `EPERM` branch is covered by an injected failure in `test/fs.test.ts`.

## Paths

- `homeDir()` prefers `USERPROFILE`. Under Git Bash `HOME` is `/c/Users/me`, which `claude.exe` cannot use.
- `canon()` rewrites `/c/x` to `C:\x`, drops `\\?\`, upper-cases the drive letter and returns backslashes. Comparisons are case-insensitive on win32 only.
- The bash hook walks the POSIX `$PWD` Git Bash gives it but exports `<root>\<name>` with the root and separator the native bun embedded at `shell-init` time. No `cygpath`, no path rewriting in shell.

## Launching claude

- `Bun.which` honours `PATHEXT`, so it can answer `claude.cmd`. `Bun.spawn` runs `.exe` files directly; a `.cmd` needs `cmd.exe`. `findClaude()` walks `PATH` one directory at a time, prefers `claude.exe` inside a directory, runs `claude.cmd` as `cmd.exe /d /s /c "..."` with cross-spawn quoting and `windowsVerbatimArguments`, and refuses a directory that has only `claude.ps1`.
- Ctrl+C in a `.cmd` launch may show cmd's "Terminate batch job (Y/N)?" prompt. The native `claude.exe` avoids the hop, and `doctor` says so.
- Windows has no `SIGHUP`; `wrapperSignals()` forwards only `SIGTERM` there.

## Installing claudep

`bun add -g @bordoni/claudep` writes `claudep.exe` (a copy of bun's shim) plus `claudep.bunx` into `%USERPROFILE%\.bun\bin`. The shim reads the `#!/usr/bin/env bun` line and launches bun. `Bun.main` is a backslash path. The `ln -s` install in the README is for macOS and Linux.

## What the Windows job proves, and what still needs a person

The job runs the whole suite with a fake `claude.cmd`, so it exercises: symlinks with explicit types, `readlinkSync` folding, the `cmd.exe` launcher and its quoting, `PATH` splitting on `;`, `.cmd` alias shims, `rm` unlinking shared items, and the bash hook under Git for Windows.

Still needs a Windows machine: logging in with a real `claude.exe` under a profile and seeing `.credentials.json` land in the profile directory; the `init` failure text with Developer Mode off; Ctrl+C behaviour through the `cmd.exe` hop.
