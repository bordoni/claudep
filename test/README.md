# test/

Run `bun run check` from the repo root. Details, fixtures and the human-only checks are in [`.ref/testing.md`](../.ref/testing.md).

Short version:

- `preload.ts` sandboxes `$HOME` before anything loads. Nothing here can touch your real `~/.claude`.
- `lib/home.ts` builds a fake `~/.claude`; `lib/cli.ts` runs `claudep.ts` against it with a fake `claude` and `security` on PATH.
- `unit.test.ts` and `fs.test.ts` import helpers straight from `claudep.ts`. `cli.test.ts` spawns the CLI. `keychain.test.ts` covers the macOS check with an injected spawner.

Adding a test: if it is about a command, it goes in `cli.test.ts` and uses `runCli`. If it is about a helper, export the helper from `claudep.ts` and test it in process. Never call the real `claude` or `security`.
