---
name: retro
description: "Conduct a retrospective on a coding session."
disable-model-invocation: true
---

The user has asked for a **retrospective**: improvements to the coding agent's **environment** (steering files, skills, checks, tooling, access) so future runs go better. The writing rules for anything you propose changing are in the `writing-for-agents` skill; load it before drafting an edit.

## Steps

1. Read the primary sources for the session the user names: the transcript, its session logs on this machine, the diff it produced. With no session named, use the current one.

2. Work through every category below and collect candidates. Done when each category has been checked against the session and either yields a candidate or is ruled out.

- **Navigation**: time lost finding a file or a hidden dependency between files. The fix is a **navigation pointer** in the steering file, worded with the situation it applies to, not a standing order to read it.
- **Automated checks**: a mistake a linter, type check, test or filesystem rule could have caught. Read the repo's own check command first (`package.json` scripts, the CI workflow), so a check that exists but sits unwired or silently broken is the finding, not a reinvention. A repo with no **guardrail** (no CI job running its lint/typecheck/test command) is itself a finding.
- **Standards**: a convention the agent broke. Classify first: a **mechanical** rule (a syntactic pattern, a banned API, an import shape, a file location) becomes a deterministic check in the repo's own linter or CI, whichever is cheapest; a **judgement call** (cross-file consistency, "matches the surrounding style") becomes a line in the steering file. Build the check over writing the rule.
- **Steering drift**: a line in `AGENTS.md`, `CLAUDE.md` or a skill written to restrain an earlier model that now costs more than it steers: an ask-first clause that halted work the user wanted finished, a "run the tests" the agent does unprompted, a step-by-step recipe where a completion criterion would do, a doc the agent is told to read before every edit. Also the reverse: a routine action the agent stopped to ask about, which a one-line grant would have cleared.
- **No-ops**: an instruction in a steering file that did not change what the agent did. The fix is deleting the sentence.
- **Tool economy**: an expensive tool call that a cheaper one, a batch, or a script would have replaced; a custom tool (CLI, MCP) whose output is token-heavy.
- **Information access**: a crucial fact the agent could not reach: dev server logs, a third-party service it had no read access to, a doc that was not in the repo.

3. Present the candidates to the user in order of severity, each with its evidence from the session and the concrete edit or check proposed.

## Reference

- `AGENTS.md` (imported by `CLAUDE.md`) is pushed into the context of every agent in this repo, so each line pays on every turn: it holds the conventions the code cannot show and pointers to what to read when, and nothing a one-command lookup would answer.
- Skills carry reference and user-invoked commands; a model-invoked skill's description is always in context, a user-invoked skill's is not.
- `CHANGELOG.md` and the code's comments are the project's record; there is no separate architecture document to update.
