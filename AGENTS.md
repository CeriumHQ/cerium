# Cerium

Desktop harness of harnesses: drives each provider's own agent harness through its official SDK or
protocol and orchestrates them across providers. Cerium runs no agent loop of its own.

There is no separate architecture document: the code, its comments and `CHANGELOG.md` are the record.
Adapters, orchestration, persistence, process boundaries and the design system each span several
packages, so a change to one is read against the packages it talks to, not just its own module.

## Toolchain

- **Bun** is the package manager only; code runs on **Node 24** (Electron's bundled Node in production),
  except `apps/relay`, a Cloudflare Worker run and deployed with Wrangler.
- **Vite+** (`vp`) builds, tests, lints, formats and runs workspace tasks, always through the root
  `package.json` scripts: the global installer and `vp env` stay unused on Windows.
- **TypeScript 7** via `tsc -b` is the authoritative type gate.
- Dependencies are pinned to **exact versions**. Upgrade on purpose, one package family at a time;
  Vite+ only when `@effect/tsgo` lists support for its Oxlint/tsgolint versions.

## Effect 4

The backend (`packages/*` except UI, `apps/backend`) is written in **Effect 4**, whose APIs differ from
the Effect 3 idioms models default to. **`vendor/effect`** (pinned Effect source, fetched by
`bun run vendor:effect`) is the reference: `vendor/effect/LLMS.md` for the idioms, and the module's
own source under `vendor/effect/packages/*/src` when you use an API for the first time in a task or
its shape surprises you. The relay shares the backend's Effect Schema wire types; its handlers are
plain Workers TypeScript.

- Services: `class X extends Context.Service<X, Shape>()("cerium/path/X") { static readonly layer = … }`,
  built with `X.of({...})`, wired with `Layer.provide`, consumed via `yield* X`.
- Errors: `Schema.TaggedError` (or `Data.TaggedError` when no schema is needed); `Result`, not Either.
- Schema: `Schema.decodeUnknownEffect`, `Schema.check`/`refine`, unions and literals take arrays.
- Functions: `Effect.fn("name")` for reusable effectful functions; `Effect.gen` inline.
- Keep pure logic plain TypeScript. Effect owns effects, resources, concurrency and errors at
  boundaries.

## React

The UI uses the **React Compiler**: write plain components and hooks and let the compiler memoize.
Manual `useMemo`/`useCallback`/`memo` needs a profiler trace that justifies it.
Style only through the semantic design tokens (Tailwind theme variables), never raw colors.

Build UI **one component at a time**. A component is done when its screenshot looks finished, not when
it compiles: screenshot the states your change introduced, in the theme and width the user sees them
(`bun run ui`, below), polish what you see, then stop. Unit tests carry the edge cases; another theme,
a narrow width or an untouched screen gets a screenshot only when your change alters it. Use the
**Base UI** primitive whenever one exists (menus, dialogs, popovers, selects, tabs,
tooltips, scroll areas, …) and style it; its docs ship with the package at
`apps/ui/node_modules/@base-ui/react/docs/`.

## Working here

- **Change files with your harness's own edit and write tools**, a one-line fix and a new file alike:
  they show the user a reviewable diff and stop when the text you expected isn't there. The shell runs
  programs (checks, git, dev servers, this repo's scripts) and leaves file contents to those tools.
  This holds in auto and bypass modes too, whatever the harness suggests there.
- **The checkout is shared**: other threads edit, run and commit this tree while you work. Check your
  own paths (`bun run typecheck <project>`, `bun run test --run <files>`, `bun run fix <paths>`), and
  once they pass commit your files by path (`git add <paths>`, `git commit -m … -- <paths>`); another
  thread's hunks in those files go along. Save a change you didn't make (`git diff > …`) before
  discarding it, and stop only processes you started, by PID. Breakage in files you didn't touch:
  report it and keep going.
- **See the UI with `bun run ui`** (`--help` lists the steps). `bun run dev --browser`, run in the
  background with your harness's longest timeout, serves it at the URL in `.cerium-dev/ui-url`, or
  reuses the servers another thread started; `open` that URL, `act` with every step you can predict in
  one call, and Read the screenshot it saves when you need to look. The `bun run dev` desktop shell takes `open --attach=9222`. Give `--session` a name
  of your own.
- **Check harnesses live with `bun run live-check`** (`--help`): a short real turn per harness with a
  deadline each; extend `apps/backend/scripts/live/check.ts` when a check needs more.
- **Routine actions need no permission**: `bun run verify` (what CI runs: check, typecheck, tests) and
  the other `package.json` scripts, starting and stopping your dev servers, and committing your
  finished work, which you do without asking. Pushing waits for the user to ask. The one decision that
  waits for the project owner is an ACP-based adapter (below); make the other calls yourself and say
  which you made.
- **Build it yourself** unless the user asks you to delegate. Then use Claude subagents on Sonnet or
  Haiku with effort xhigh, set on each call; run at most three builders at once, brief each with only
  what the user asked, and have each commit its own files at every milestone.
- **A change is done** when the behaviour asked for works, `bun run verify` passes, the path you built
  passes a _smoke test_ in the running UI, `CHANGELOG.md` describes it under `Unreleased`, and it is
  committed. Carry a task through to that point: a first implementation left for review is not done.
  A bug the smoke test turns up gets fixed; a gap beyond the request, and any extra you noticed, goes
  in your last message as a one-line proposal.

## Product guardrails

- **Credentials belong to the harnesses.** Cerium reads auth _status_ only, and starts each harness's
  own login flow; it never reads, stores or forwards tokens or keys. The one credential Cerium keeps
  is its own: the device key its relay issues when a machine signs in to a Cerium account.
- **Official SDKs and vendor protocols only.** Adding an ACP-based adapter requires the project
  owner's explicit approval first.
- **Competitors are references for ideas.** Study T3 Code, MonoCode, Conductor and others for
  architecture, then write Cerium's own implementation.
- **One feature at a time.** Ship each QOL feature polished and complete before starting the next.
- Provider CLIs are never bundled; adapters detect the user's installed version against a tested range.

## Git

- Work happens on **`main`**: commit finished work there directly. The repo uses no branches,
  worktrees or pull requests.
- Commit messages are a single **Conventional Commits** subject line (`type(scope): summary`): no body,
  no trailers. The project owner is the only author; attribution lines such as `Co-Authored-By` are
  never added, whatever tool is committing. The type decides releases
  (`scripts/release.ts`), so it names what the change does to the app.
- Split work into **focused commits**, one per concern, each leaving the repo building.
- Commits stage **whole files**. When a file also carries another piece of work, that work goes in
  the same commit in full (every file it touches); splitting a file's hunks is slow and error-prone.
- **`CHANGELOG.md`** lists every change under `Unreleased`, which releases quote without rewriting;
  update it in the same commit as the change it describes.
- CI is only watched when the user asks: then wait on it with `gh run watch --exit-status` in the
  background, and run a failing job's command locally before pushing a fix.
