# Releasing claudep

Releases go to npm as `claudep`, to GitHub Packages as `@bordoni/claudep`, and to a GitHub Release whose notes are the changelog section. One command cuts a release; a tag push publishes it.

## The routine

1. While working, add a line under `## [Unreleased]` in `CHANGELOG.md` for anything a user could notice. CI fails a pull request that changes `claudep.ts` without one, unless the PR carries the `skip-changelog` label.
2. On a clean `main`: `bun run release minor --push` (or `patch`, `major`, or an exact `x.y.z`). The script refuses a dirty tree, another branch, an existing tag or an empty Unreleased block. It runs `bun run check` and `bun pm pack --dry-run`, moves the Unreleased block under `## [x.y.z] - date`, fixes the compare links, bumps `package.json`, commits `Release vx.y.z`, creates an annotated tag whose message is the changelog section, and pushes with `--follow-tags`.
3. `gh run watch` and wait for `.github/workflows/release.yml`.

`bun run release minor --dry-run` prints the section and version without touching anything.

## What the workflow does on a `v*` tag

| Job | Needs | What it does |
|---|---|---|
| `verify` | | `bun run check`, `bun run pack:check`, tag equals `package.json` version, changelog section exists for that version. |
| `npm` | verify | `id-token: write`, npm CLI 11.5.1 or newer from Node 24. Skips when `npm view claudep@<version>` already answers, otherwise `npm publish --access public`. No token; provenance is attached automatically by trusted publishing. |
| `github-packages` | verify | Rewrites the name to `@bordoni/claudep`, publishes to `npm.pkg.github.com` with `GITHUB_TOKEN`. `continue-on-error`, so it can never fail a release that reached npm. |
| `github-release` | npm | `gh release create v<version>` with `--notes-file` from `bun scripts/changelog.ts extract`. |

The npm skip rule is what makes retagging or re-running safe, and it is how 0.1.0 works at all (see below).

## One-time bootstrap for 0.1.0

npm trusted publishing cannot create a package that does not exist yet (npm/cli#8544), so the first publish is manual:

```bash
bun run release 0.1.0            # package.json and CHANGELOG.md already say 0.1.0: this only tags
npm publish --access public      # from the repo root; enter your 2FA code when asked
npm view claudep version         # 0.1.0
```

Then, on npmjs.com, open the package, Settings, **Trusted Publisher**, and add GitHub Actions with owner `bordoni`, repository `claudep`, workflow filename `release.yml`, no environment. Each package holds one trusted publisher; the fields must match the workflow run exactly or the publish fails with a misleading `E404`.

Then push the tag: `git push origin v0.1.0`. The workflow verifies, sees 0.1.0 on npm and skips that job, publishes the GitHub Packages mirror and creates the GitHub Release.

Optional: turn on Immutable Releases in the repository settings so tags and assets cannot be moved after publication.

## GitHub Packages for consumers

GitHub Packages needs a token even for public packages. A consumer adds to `.npmrc`:

```ini
@bordoni:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

with a token that has `read:packages`. npm is the main channel; this is a mirror for anyone already wired to GitHub Packages.

## Recovery

- A job failed after `verify`: fix nothing in git, re-run the failed jobs from the Actions page. `npm` is idempotent through the skip rule; `github-release` refuses to create a release that exists.
- The tag is wrong and nothing was published yet: `git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`, then `git revert` the release commit if it was pushed. Never move a tag that npm has already published.
- The version is on npm but the GitHub Release is missing: re-run `github-release`.
- To check where things stand: `npm view claudep versions`, `gh release list`, `git tag`.

## Why it is shaped this way

`bun publish` has no trusted-publishing support (oven-sh/bun#22423), so the publish step uses the npm CLI. Everything else, including the release script, runs on bun. The changelog is written by hand and promoted by `scripts/changelog.ts` because a CLI's changelog is a product surface, and the script is thirty lines with no dependencies. release-please reads this exact format if the team ever outgrows the manual routine.
