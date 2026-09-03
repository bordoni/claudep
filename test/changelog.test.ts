import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { extract, promote, sections, unreleased, versions } from "../scripts/changelog.ts";
import { REPO } from "./lib/cli.ts";

const REPO_URL = "https://github.com/bordoni/claudep";

const FIRST = `# Changelog

Intro text.

## [Unreleased]

### Added

- Something new.

[Unreleased]: ${REPO_URL}/compare/HEAD...HEAD
`;

const LATER = `# Changelog

## [Unreleased]

### Fixed

- A bug.

## [0.1.0] - 2026-09-03

### Added

- Initial release.

[Unreleased]: ${REPO_URL}/compare/v0.1.0...HEAD
[0.1.0]: ${REPO_URL}/releases/tag/v0.1.0
`;

describe("sections", () => {
  test("parses headings, dates and bodies, stopping at the link block", () => {
    expect(sections(LATER)).toEqual([
      { version: "Unreleased", date: undefined, body: "### Fixed\n\n- A bug." },
      { version: "0.1.0", date: "2026-09-03", body: "### Added\n\n- Initial release." },
    ]);
  });
});

describe("extract and unreleased", () => {
  test("returns the body for a version", () => {
    expect(extract(LATER, "0.1.0")).toBe("### Added\n\n- Initial release.");
  });

  test("throws for a missing version", () => {
    expect(() => extract(LATER, "9.9.9")).toThrow('no "## [9.9.9]" section');
  });

  test("unreleased is empty when the section has no body", () => {
    expect(unreleased(LATER.replace("### Fixed\n\n- A bug.\n", ""))).toBe("");
  });

  test("versions lists released headings newest first", () => {
    expect(versions(LATER)).toEqual(["0.1.0"]);
    expect(versions(FIRST)).toEqual([]);
  });
});

describe("promote", () => {
  test("first release links to the tag page", () => {
    const out = promote(FIRST, "0.1.0", "2026-09-03", REPO_URL);
    expect(out).toBe(`# Changelog

Intro text.

## [Unreleased]

## [0.1.0] - 2026-09-03

### Added

- Something new.

[Unreleased]: ${REPO_URL}/compare/v0.1.0...HEAD
[0.1.0]: ${REPO_URL}/releases/tag/v0.1.0
`);
  });

  test("later release links to a compare range and keeps older links", () => {
    const out = promote(LATER, "0.2.0", "2026-10-01", REPO_URL);
    expect(unreleased(out)).toBe("");
    expect(extract(out, "0.2.0")).toBe("### Fixed\n\n- A bug.");
    expect(extract(out, "0.1.0")).toBe("### Added\n\n- Initial release.");
    expect(out.trimEnd().split("\n").slice(-3)).toEqual([
      `[Unreleased]: ${REPO_URL}/compare/v0.2.0...HEAD`,
      `[0.2.0]: ${REPO_URL}/compare/v0.1.0...v0.2.0`,
      `[0.1.0]: ${REPO_URL}/releases/tag/v0.1.0`,
    ]);
    expect(versions(out)).toEqual(["0.2.0", "0.1.0"]);
  });

  test("refuses an empty Unreleased and a duplicate version", () => {
    const empty = LATER.replace("### Fixed\n\n- A bug.\n", "");
    expect(() => promote(empty, "0.2.0", "2026-10-01", REPO_URL)).toThrow("nothing under [Unreleased]");
    expect(() => promote(LATER, "0.1.0", "2026-10-01", REPO_URL)).toThrow("already has a section");
  });

  test("promoting twice is stable", () => {
    const once = promote(LATER, "0.2.0", "2026-10-01", REPO_URL);
    const twice = promote(
      `${once.replace("## [Unreleased]\n", "## [Unreleased]\n\n- More.\n")}`,
      "0.3.0",
      "2026-11-01",
      REPO_URL,
    );
    expect(versions(twice)).toEqual(["0.3.0", "0.2.0", "0.1.0"]);
    expect(twice).toContain(`[0.3.0]: ${REPO_URL}/compare/v0.2.0...v0.3.0`);
  });
});

describe("the real CHANGELOG.md and the CLI", () => {
  test("has an Unreleased section and a 0.1.0 section that the CLI can extract", async () => {
    const md = await Bun.file(join(REPO, "CHANGELOG.md")).text();
    expect(sections(md)[0]?.version).toBe("Unreleased");
    expect(versions(md)).toContain("0.1.0");
    const ok = Bun.spawnSync([process.execPath, join(REPO, "scripts", "changelog.ts"), "extract", "0.1.0"]);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.toString()).toContain("### Added");
    const missing = Bun.spawnSync([process.execPath, join(REPO, "scripts", "changelog.ts"), "extract", "9.9.9"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr.toString()).toContain('no "## [9.9.9]" section');
  });
});
