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
- Claude adapter: trusted MCP servers' tools run without permission prompts.
- `@cerium/orchestrator`: threads with a lead and depth-1 children; inbox delivery that batches notices into one turn and never interrupts a running turn; per-provider and global concurrency caps; catalog spawns with access narrowing and user approval for other models; lead/child/cross-thread messaging rules with per-pair budgets; child results delivered to the lead; persisted, live-streamed event log.
- `@cerium/bus`: Cerium's MCP server on a loopback port, injected into every session with its own bearer token, exposing `list_models`, `spawn_agent`, `list_agents`, `list_threads`, `send_message` and `kill_agent`.
- `@cerium/backend`: composes the store, orchestrator, Claude adapter and MCP bus into one layer, with a live check where a Claude lead spawns a Claude child through the bus and relays its answer.
- `@cerium/ui`: React app with Cerium's design tokens (monochrome translucent glass over Acrylic, with colour reserved for status and provider logos; dark and light themes) and the window frame: a titlebar over the thread sidebar and the transcript, with the agent inspector opening beside it on demand from a titlebar control that shows the thread's agents.
- UI: thread sidebar with collapsible project groups, colour-coded thread status, official provider logos (in their own colours where available) for active multi-agent threads, relative times, and harness status in the footer.
- UI: thread transcript built from canonical events: user messages and markdown replies (streaming-safe) under one header per response, collapsible reasoning, compact grouped tool calls with inputs and outputs, chips for spawned agents, child results inline in the lead's response, inline approval cards, and per-turn usage.
- UI: composer floating over the transcript, with grouped model picker (provider logos), reasoning effort and access mode pickers, Enter to send and a stop button while a turn runs.
- UI: separate Work and Chat modes, switched from the titlebar; the sidebar lists only the active mode's threads, work grouped by project and chats by recency.
- UI: agent inspector: the lead and its children as a tree with colour-coded state, the selected agent's model, effort, access, tokens, cost and latest message, actions to open, message, interrupt or stop it, and the thread's usage per provider.
- UI: Cerium's "Prism C" mark in the titlebar and as the favicon.

### Changed

- `@cerium/harness` takes `AccessMode` from `@cerium/protocol` instead of defining its own.
- The scripted fake harness adapter used in tests is shared from `@cerium/harness/testing`.
- `@cerium/store` applies its own bundled migrations unless given another folder.

### Fixed

- Claude adapter: trusted bus tools are approved inside the permission callback instead of through `allowedTools`, which bypassed the callback and triggered an SDK warning.
