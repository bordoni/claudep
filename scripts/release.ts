#!/usr/bin/env bun
/**
 * Cut a release: promote the changelog, bump package.json, commit, tag.
 *
 *   bun run release <patch|minor|major|x.y.z> [--dry-run] [--push]
 *
 * The tag (bare version, e.g. 0.2.0) push is what triggers .github/workflows/release.yml, which publishes
 * to npm through trusted publishing and creates the GitHub Release from the
 * changelog section. Nothing here talks to a registry.
 */
import { $ } from "bun";
import { extract, promote, repoUrl, today, unreleased, versions } from "./changelog.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const CHANGELOG = `${ROOT}CHANGELOG.md`;
const PACKAGE = `${ROOT}package.json`;

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function bump(current: string, how: string): string {
  if (/^\d+\.\d+\.\d+$/.test(how)) return how;
  const [maj, min, pat] = current.split(".").map(Number) as [number, number, number];
  if (how === "major") return `${maj + 1}.0.0`;
  if (how === "minor") return `${maj}.${min + 1}.0`;
  if (how === "patch") return `${maj}.${min}.${pat + 1}`;
  return fail(`unknown bump "${how}". Use patch, minor, major or x.y.z`);
}

const args = Bun.argv.slice(2);
const dryRun = args.includes("--dry-run");
const push = args.includes("--push");
const how = args.find((a) => !a.startsWith("--"));
if (!how) fail("usage: bun run release <patch|minor|major|x.y.z> [--dry-run] [--push]");

const pkg = (await Bun.file(PACKAGE).json()) as { version: string };
const md = await Bun.file(CHANGELOG).text();
const version = bump(pkg.version, how);
// Tags and GitHub Releases are the bare version, no v prefix.
const tag = version;

$.cwd(ROOT);
const dirty = (await $`git status --porcelain`.text()).trim();
if (dirty) fail(`working tree is not clean:\n${dirty}`);
const branch = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim();
if (branch !== "main") fail(`releases are cut from main, not ${branch}`);
if ((await $`git tag -l ${tag}`.text()).trim()) fail(`tag ${tag} already exists`);

// Bootstrap case: package.json and the changelog already carry this version and
// nothing is pending. Only the tag is missing.
const tagOnly = version === pkg.version && versions(md).includes(version) && !unreleased(md);

let section: string;
let next = md;
if (tagOnly) {
  section = extract(md, version);
} else {
  if (version === pkg.version) fail(`package.json is already ${version}; pick a new version`);
  if (!unreleased(md)) fail("nothing under [Unreleased] in CHANGELOG.md");
  next = promote(md, version, today(), await repoUrl());
  section = extract(next, version);
}

console.log(`${tagOnly ? "Tagging" : "Releasing"} ${tag}${dryRun ? " (dry run)" : ""}\n`);
console.log(section);
console.log();
if (dryRun) {
  console.log("dry run: nothing written, nothing committed");
  process.exit(0);
}

console.log("running checks");
await $`bun run check`.quiet();
await $`bun pm pack --dry-run`.quiet();

if (!tagOnly) {
  await Bun.write(CHANGELOG, next);
  const raw = await Bun.file(PACKAGE).text();
  await Bun.write(PACKAGE, raw.replace(/"version": "[^"]+"/, `"version": "${version}"`));
  await $`git add CHANGELOG.md package.json`;
  await $`git commit -q -m ${`Release ${tag}`}`;
}
await $`git tag -a ${tag} -m ${`${tag}\n\n${section}`}`;
console.log(`tagged ${tag}`);

if (push) {
  await $`git push --follow-tags`;
  console.log("pushed. Watch the release workflow: gh run watch");
} else {
  console.log(`next: git push --follow-tags   (this triggers the release workflow)`);
}
