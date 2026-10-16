# Changelog

All notable changes to Cerium are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Bun workspace with Vite+ for build, lint, format and test, TypeScript 7, and Effect language service diagnostics.
- LF line endings enforced for every checkout via `.gitattributes`.
- Apache-2.0 license.
- Agent skills for design grilling, retros, wizards and writing agent docs.
- `bun run vendor:effect` fetches the pinned Effect source as a reference for coding agents.
- Architecture decision record and auto-router design in `docs/`.
- Agent guidelines in `AGENTS.md`, including git and changelog rules.
- `@cerium/protocol`: canonical agent events, capability manifests and harness status schemas.
- `@cerium/harness`: the adapter contract every provider implements, plus version range checks.
- Claude adapter: translates Claude Agent SDK messages into canonical events, tested against a recorded session.
- Claude adapter: detects the installed Claude Code version and login status, and runs live sessions with approvals, file change tracking, per-turn usage, and mid-session model and effort switching.
- `@cerium/protocol`: orchestration events (turn inputs, spawned agents, agent state, spawn approvals) and the rule that a child's access only narrows.
- Claude adapter: reports completed reasoning blocks alongside streamed reasoning.
- `@cerium/protocol`: thread and agent record schemas.
- `@cerium/store`: SQLite persistence for threads, agents and the append-only event log, using Drizzle on Node's built-in `node:sqlite` with generated migrations and an FTS5 startup check.
- `@cerium/harness`: sessions can mark injected MCP servers as trusted so their tools skip approval prompts.

### Changed

- `@cerium/harness` takes `AccessMode` from `@cerium/protocol` instead of defining its own.
