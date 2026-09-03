# Writing for humans in this repo

Everything a person reads here, the README, `AGENTS.md`, this folder, `test/README.md`, `CHANGELOG.md` and the `help()` text and messages in `claudep.ts`, was passed through the author's `voice` skill. These are the rules that pass applied, so new prose can follow them without the skill. They are about register, not content: tables, code blocks, headings and the `.ref/` index rows stay.

## Always

- Answer first, context second. The fact or the decision opens the paragraph; the reasoning follows.
- Say each thing once, in its strongest form, then move on. A restatement, a summarising sentence and a consequence-of-the-consequence are the same point in a different coat.
- Stay at the size of what happened. "This fix" not "fixes like this"; "on the author's machine" not "on every Mac". A flat statement about a specific fact stays definite.
- Name the mechanism: a version, a file, a command, a number. "Verified against Claude Code 2.1.259", not "verified recently".
- Plain engineer register. Short words, concrete nouns and verbs, no executive vocabulary.
- "I am", "I have", never "I'm" or "I've" in the author's own voice. "I" only where it carries ownership: a verification claim, a decision, an apology.

## Never

- No em dash as a connector. Use a period, a comma or a colon. Headings and titles included: `# .ref: on-demand reference`, `## 2026-09-03: Releases`.
- No curly quotes. Straight quotes only.
- No clever closers, aphorisms or callbacks at the end of a section. When the content stops, stop.
- No reader-directed question whose only job is to invite a reply. A question survives only when something concrete will act on the answer.
- No "not just X, it is Y" framing. Say what it is.
- No hedges that carry no information: "it is important to note", "arguably", "generally speaking".
- No banned generic vocabulary: delve, leverage, utilize, robust, comprehensive, streamline, seamless, foster, unlock, elevate, "at the end of the day".
- No tricolons for rhythm, no thesis-first openers, no second-beat fragment that restates the opening sentence.

## Checks that catch most of it

```bash
/usr/bin/grep -nE "—|[’“”]|\bI'm\b|\bI've\b" README.md AGENTS.md .ref/*.md test/README.md CHANGELOG.md claudep.ts
llmstrip --mode text --report README.md   # deterministic de-AI pass, if installed
```

## Structure that stays

The `.ref/` convention needs its index tables with a "read it when" column, code blocks for anything a person types, and numbered Never lists in `AGENTS.md`. Bullets are fine when the items are parallel. Prose is for argument and explanation.
