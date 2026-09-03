# Directory pins: the .claudep file and the shell hook

A `.claudep` file names the profile every hooked shell should use inside that directory tree. This file explains the mechanics so a change to one half is mirrored in the other.

## Two implementations that must agree

- `resolvePin(startDir)` in `claudep.ts` is the TypeScript version. `claudep resolve`, `claudep local` and `claudep current` use it.
- The hook printed by `claudep shell-init zsh|bash` is the shell version. It runs on every directory change (zsh `chpwd`) or prompt (bash `PROMPT_COMMAND`), so it uses parameter expansion and builtins only. No subprocess, ever.

`test/shell.test.ts` runs the real hook in bash, and in zsh when present, and checks it lands on the same answer as `claudep resolve`.

## Resolution rules

1. Walk upward from the current directory to `/`. The first **regular file** named `.claudep` wins. A directory with that name is skipped, which is how `~/.claudep` (the profiles root) never counts as a pin.
2. The pin is the first line that is not empty and does not start with `#`, trimmed.
3. An empty pin file, or one with only comments, means "no pin here". That is how a subtree cancels a parent's pin.
4. A pin naming a profile directory that does not exist sets nothing and prints one warning per directory change.

## The CLAUDEP_AUTO marker

The hook exports `CLAUDEP_AUTO` next to `CLAUDE_CONFIG_DIR` with the same value. Before touching anything it checks: if `CLAUDE_CONFIG_DIR` is set and differs from `CLAUDEP_AUTO`, someone else set it and the hook returns. That covers `eval "$(claudep env work)"`, a plain `export`, and a parent shell.

`claudep env <name>` prints `unset CLAUDEP_AUTO` after the export so the pin it creates is manual even when the hook had set the same directory a moment earlier. `claudep env --unset` clears both variables and hands the shell back to the hook.

Leaving every pinned tree unsets both variables, so the shell returns to `~/.claude`. A stale profile that silently followed you out of a repo was judged worse than a visible fall back to the default.

## What `claudep current` reports

| State | `kind` | `setBy` |
|---|---|---|
| No `CLAUDE_CONFIG_DIR` | `base` | `none` |
| `CLAUDE_CONFIG_DIR` under the profiles root, equal to `CLAUDEP_AUTO` | `profile` | `hook` |
| `CLAUDE_CONFIG_DIR` under the profiles root, `CLAUDEP_AUTO` absent or different | `profile` | `manual` |
| `CLAUDE_CONFIG_DIR` anywhere else | `custom` | `manual` |

It also runs `resolvePin` on the current directory and, when the pinned name differs from the active profile, says so and suggests loading the hook.

## Layout consequences

`layout()` treats a `CLAUDE_CONFIG_DIR` inside the profiles root as an active profile, not as a custom base. Without this, `claudep init` from inside a pinned repo would link the new profile into the pinned one, and the `default` row in `claudep list` would show the pinned login. `baseEnv()` strips both variables before running `claude` for the base, so `claudep default` really is `~/.claude`.

## Testing the hook by hand

```bash
zsh -c 'eval "$(claudep shell-init zsh)"; cd /path/to/pinned/tree; claudep current; cd ~; claudep current'
```

In the test suite the same is done with two helper functions defined after the hook is loaded: `tick` calls `_claudep_auto`, `show` prints `CLAUDE_CONFIG_DIR|CLAUDEP_AUTO`.
