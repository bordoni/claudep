#!/usr/bin/env bun
/**
 * Keep a Changelog helpers for CHANGELOG.md.
 *
 *   bun scripts/changelog.ts extract <version>        print the section for a version (exit 1 if missing)
 *   bun scripts/changelog.ts unreleased               print the Unreleased body (empty output when empty)
 *   bun scripts/changelog.ts promote <version> [date] move Unreleased under a new version heading, in place
 */

const HEADING = /^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?\s*$/;
const LINK = /^\[([^\]]+)\]: \S+/;

export type Section = { version: string; date: string | undefined; body: string };

/** Every `## [x]` section in order, with its body trimmed. */
export function sections(md: string): Section[] {
  const out: Section[] = [];
  let current: { version: string; date: string | undefined; lines: string[] } | undefined;
  for (const line of md.split("\n")) {
    const h = line.match(HEADING);
    if (h) {
      if (current) out.push({ version: current.version, date: current.date, body: current.lines.join("\n").trim() });
      current = { version: h[1] as string, date: h[2], lines: [] };
      continue;
    }
    if (current) {
      if (LINK.test(line)) {
        out.push({ version: current.version, date: current.date, body: current.lines.join("\n").trim() });
        current = undefined;
        continue;
      }
      current.lines.push(line);
    }
  }
  if (current) out.push({ version: current.version, date: current.date, body: current.lines.join("\n").trim() });
  return out;
}

/** Body of one version's section. Throws when the heading is missing. */
export function extract(md: string, version: string): string {
  const s = sections(md).find((x) => x.version === version);
  if (!s) throw new Error(`CHANGELOG.md has no "## [${version}]" section`);
  return s.body;
}

/** Body of the Unreleased section. Empty string when there is nothing pending. */
export function unreleased(md: string): string {
  return extract(md, "Unreleased");
}

/** Released version headings, newest first. */
export function versions(md: string): string[] {
  return sections(md)
    .map((s) => s.version)
    .filter((v) => v !== "Unreleased");
}

/**
 * Move the Unreleased body under `## [version] - date` and rewrite the link
 * references. Throws when Unreleased is empty or the version already exists.
 */
export function promote(md: string, version: string, date: string, repo: string): string {
  const body = unreleased(md);
  if (!body) throw new Error("CHANGELOG.md has nothing under [Unreleased]");
  if (versions(md).includes(version)) throw new Error(`CHANGELOG.md already has a section for ${version}`);
  const prev = versions(md)[0];

  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.match(HEADING)?.[1] === "Unreleased");
  let end = start + 1;
  while (end < lines.length && !HEADING.test(lines[end] as string) && !LINK.test(lines[end] as string)) end++;
  const rebuilt = [
    ...lines.slice(0, start),
    "## [Unreleased]",
    "",
    `## [${version}] - ${date}`,
    "",
    body,
    "",
    ...lines.slice(end),
  ];

  const links = rebuilt.filter((l) => LINK.test(l) && !l.startsWith("[Unreleased]:"));
  const withoutLinks = rebuilt.filter((l) => !LINK.test(l));
  while (withoutLinks.length && (withoutLinks[withoutLinks.length - 1] as string).trim() === "") withoutLinks.pop();
  const newLinks = [
    `[Unreleased]: ${repo}/compare/v${version}...HEAD`,
    prev ? `[${version}]: ${repo}/compare/v${prev}...v${version}` : `[${version}]: ${repo}/releases/tag/v${version}`,
    ...links,
  ];
  return `${[...withoutLinks, "", ...newLinks].join("\n")}\n`;
}

/** Repository URL from package.json, without the git+ prefix and .git suffix. */
export async function repoUrl(): Promise<string> {
  const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
    repository?: string | { url?: string };
  };
  const raw = typeof pkg.repository === "string" ? pkg.repository : (pkg.repository?.url ?? "");
  const m = raw.match(/github\.com[/:]([^/]+\/[^/.]+)/);
  if (!m) throw new Error("package.json repository must point at github.com");
  return `https://github.com/${m[1]}`;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

if (import.meta.main) {
  const file = new URL("../CHANGELOG.md", import.meta.url);
  const [cmd, arg, dateArg] = Bun.argv.slice(2);
  const md = await Bun.file(file).text();
  try {
    switch (cmd) {
      case "extract": {
        if (!arg) throw new Error("usage: changelog.ts extract <version>");
        console.log(extract(md, arg));
        break;
      }
      case "unreleased":
        process.stdout.write(unreleased(md) ? `${unreleased(md)}\n` : "");
        break;
      case "promote": {
        if (!arg) throw new Error("usage: changelog.ts promote <version> [date]");
        const next = promote(md, arg, dateArg ?? today(), await repoUrl());
        await Bun.write(file, next);
        console.log(extract(next, arg));
        break;
      }
      default:
        throw new Error("usage: changelog.ts extract <version> | unreleased | promote <version> [date]");
    }
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
