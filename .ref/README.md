# .ref — on-demand reference for claudep

Notes an agent or developer fetches **on demand**, not read end to end. [`AGENTS.md`](../AGENTS.md) is the working agreement and tells you when to open each file; [`README.md`](../README.md) at the root is for users of the tool.

| File | Read it when |
|---|---|
| [`claude-code-internals.md`](./claude-code-internals.md) | Debugging login isolation, a Claude Code update moved files, or you need to re-verify a claim against the binary. |
| [`shared-vs-private.md`](./shared-vs-private.md) | Changing `SHARED_FILES`, `SHARED_DIRS`, `KNOWN_PRIVATE`, `SEED_KEYS`, or `doctor` reported an unclassified file. |
| [`testing.md`](./testing.md) | You changed `claudep.ts`. Typecheck recipe, smoke cycle, install check, and the gotcha log. |
| [`design-decisions.md`](./design-decisions.md) | Considering a restructure, rename, or a feature that may already have been weighed and rejected. |

## Tiers

- `README.md` (root): what the tool is and how to use it.
- `AGENTS.md`: rules that apply while changing code, plus the index above.
- `.ref/`: topic detail, one subject per file, fetched when the index says so.

## Adding a file

Give it a lowercase kebab-case topic noun, keep it under about 120 lines, and add a row here **and** in `AGENTS.md` with a "read it when" hook. A reference doc nobody knows to fetch is a reference doc nobody reads. Every behavioural claim about Claude Code should say which version it was verified against.
