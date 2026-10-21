# Contributing to Cerium

Thanks for wanting to help. Cerium is early, so the most useful contributions right now are bug
reports with clear steps, harness versions that misbehave, and small, focused fixes.

- **Questions and ideas:** open a [discussion](https://github.com/nonlooped/cerium/discussions).
- **Bugs:** open an [issue](https://github.com/nonlooped/cerium/issues/new/choose) with the bug
  template.
- **Security problems:** follow [SECURITY.md](SECURITY.md). Please don't file them as issues.

Before starting on anything larger than a small fix, open an issue or discussion first so we can
agree on the approach. Cerium ships one feature at a time, each finished before the next, so a pull
request that adds an unplanned feature may be held back even when the code is good.

## Setting up

You need **Node.js 24.11+** and **Bun 1.4+**, on Windows or Linux (the shipping platforms) or any OS
for the backend and UI. Install at least one harness (Claude Code, Codex, Cursor or OpenCode) and sign in
to it if you want to run real agents; OpenCode's free models need no sign-in.

```sh
bun install
bun run dev              # backend, UI and desktop window together
bun run dev --browser    # backend and UI only, in your browser
```

The development backend keeps its data in `.cerium-dev/`, apart from an installed Cerium. The UI is
served on the first free port from 5173, written to `.cerium-dev/ui-url`; running `bun run dev` again
reuses the servers already running.

| Command                 | What it does                                                            |
| ----------------------- | ----------------------------------------------------------------------- |
| `bun run verify`        | Format check, lint, typecheck and tests: run it before you push         |
| `bun run fix`           | Apply formatting and lint fixes                                         |
| `bun run test`          | Tests in watch mode (`bun run test --run` for a single pass)            |
| `bun run typecheck`     | `tsc -b`, the authoritative type gate                                   |
| `bun run package`       | Build this OS's package (installer or AppImage) into `apps/desktop/out` |
| `bun run vendor:effect` | Fetch the pinned Effect source into `vendor/effect` for reference       |
| `bun run ui`            | Drive a web UI from the shell: open, act, screenshot, inspect           |
| `bun run live-check`    | Run a short real turn on each installed harness and report it           |

## Toolchain

- **Bun** is the package manager only. Code runs on **Node 24** (Electron's bundled Node in the
  packaged app).
- **Vite+** (`vp`) builds, tests, lints and formats. Call it through the root `package.json` scripts.
- **TypeScript 7** via `tsc -b` decides whether the types are right.
- Dependencies are pinned to **exact versions** and upgraded on purpose, one package family at a
  time. Dependabot only updates the CI workflow actions.

## Project layout

| Path                    | What lives there                                                         |
| ----------------------- | ------------------------------------------------------------------------ |
| `apps/backend`          | Composes everything below into the backend process                       |
| `apps/ui`               | The React UI                                                             |
| `apps/desktop`          | The Electron shell and installer                                         |
| `packages/protocol`     | Canonical event, capability and settings schemas shared by every package |
| `packages/harness`      | The adapter contract every provider implements                           |
| `packages/adapters/*`   | One adapter per harness: Claude, Codex, Cursor, OpenCode and Muse (off)  |
| `packages/orchestrator` | Threads, leads and children, delivery, limits and approvals              |
| `packages/bus`          | The MCP server injected into every session (spawn, message, stop)        |
| `packages/store`        | SQLite persistence: threads, agents and the append-only event log        |
| `packages/rpc`          | The RPC contract between the UI and the backend                          |
| `packages/artifacts`    | The building blocks agents use to draw inline visuals                    |
| `packages/browser`      | `bun run ui`: drives Edge or Chrome over the DevTools protocol, plain TS |

## How the code is written

**Backend** (`packages/*`, `apps/backend`) is written in **Effect 4**. Effect 4 differs from Effect
3 in many places, so read the module you're about to use in `vendor/effect` rather than relying on
memory.

- Services are `Context.Service` classes with a static `layer`, built with `X.of({...})` and
  consumed with `yield* X`.
- Errors are `Schema.TaggedError` (or `Data.TaggedError` when no schema is needed). Use `Result`, not
  `Either`.
- Use `Effect.fn("name")` for reusable effectful functions and `Effect.gen` inline.
- Keep pure logic as plain TypeScript. Effect owns effects, resources, concurrency and errors at the
  boundaries.

**UI** (`apps/ui`) uses the **React Compiler**: write plain components and hooks and let the compiler
memoise. Manual `useMemo`, `useCallback` or `memo` needs a profiler trace that justifies it.

- Style only with the semantic design tokens (the Tailwind theme variables), never raw colours.
- Use the **Base UI** primitive whenever one exists (menus, dialogs, popovers, selects, tabs,
  tooltips, …) and style it, instead of hand-rolling the behaviour.
- For any visible change, include before and after screenshots in the pull request.

## Product rules

These hold for every change, and pull requests that break them can't be merged:

- **Credentials belong to the harnesses.** Cerium reads auth _status_ only and starts each harness's
  own login. It never reads, stores or forwards tokens or keys.
- **Official SDKs and vendor protocols only.** New adapters use the vendor's own SDK or documented
  protocol. ACP-based adapters need the maintainer's approval before any work starts.
- **Provider CLIs are never bundled.** Adapters detect the installed version against a tested range.
- **Competitors are references for ideas, never sources of code.**

## Commits and pull requests

- Each commit message is a single [Conventional Commits](https://www.conventionalcommits.org) subject
  line, `type(scope): summary`, with **no body and no trailers** (including `Co-Authored-By`). CI
  checks this with `scripts/check-commits.ts`, which you can also run locally:
  `node scripts/check-commits.ts origin/main HEAD`.
- The type decides releases, so pick the one that says what the change does to the app: `feat` bumps
  the minor version; `fix`, `perf`, `refactor`, `style`, `build` and `revert` ship a patch; `docs`,
  `test`, `ci` and `chore` don't ship at all.
- Keep commits focused, one concern each, and leave the repo building after every one.
- Add a line for every user-visible change under `Unreleased` in [CHANGELOG.md](CHANGELOG.md), in the
  same commit as the change. Release notes quote it as written.
- Pull requests run CI: commit messages, then format, lint, types and tests on Linux, then an
  AppImage build on Linux and tests and an installer build on Windows. Make sure `bun run verify`
  passes before you push.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same license as the project.
