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
- `@cerium/store`: per-thread event history, and stopping agents a previous run left live.
- `@cerium/harness`: sessions can mark injected MCP servers as trusted so their tools skip approval prompts.
- Claude adapter: trusted MCP servers' tools run without permission prompts.
- `@cerium/orchestrator`: threads with a lead and depth-1 children; inbox delivery that batches notices into one turn and never interrupts a running turn; per-provider and global concurrency caps; catalog spawns with access narrowing and user approval for other models; lead/child/cross-thread messaging rules with per-pair budgets; child results delivered to the lead; persisted, live-streamed event log.
- `@cerium/orchestrator`: tracks which threads wait on the user's approval, serves thread history, and stops agents left live by a previous run at startup.
- `@cerium/bus`: Cerium's MCP server on a loopback port, injected into every session with its own bearer token, exposing `list_models`, `spawn_agent`, `list_agents`, `list_threads`, `send_message` and `kill_agent`.
- `@cerium/rpc`: the RPC contract between the UI and the backend: thread overviews, thread history, a live event stream, harness status, and actions to create threads, send messages, answer approvals and spawn requests, and interrupt or stop agents.
- `@cerium/backend`: composes the store, orchestrator, Claude adapter and MCP bus into one layer, with a live check where a Claude lead spawns a Claude child through the bus and relays its answer.
- `@cerium/backend`: an entry point serving the MCP bus and the UI's RPC endpoint on one loopback port; the RPC WebSocket only upgrades for this launch's token. `bun run dev:backend` runs it with a development data folder and writes the connection details for the UI.
- `@cerium/ui`: React app with Cerium's design tokens (monochrome translucent glass over Acrylic, with colour reserved for status and provider logos; dark and light themes) and the window frame: a titlebar over the thread sidebar and the transcript, with the agent inspector opening beside it on demand from a titlebar control that shows the thread's agents.
- UI: thread sidebar with collapsible project groups, colour-coded thread status, official provider logos (in their own colours where available) for active multi-agent threads, relative times, and harness status in the footer.
- UI: thread transcript built from canonical events: user messages and markdown replies (streaming-safe) under one header per response, collapsible reasoning, compact grouped tool calls with inputs and outputs, chips for spawned agents, child results inline in the lead's response, inline approval cards, and per-turn usage.
- UI: composer floating over the transcript, with grouped model picker (provider logos), reasoning effort and access mode pickers, Enter to send and a stop button while a turn runs.
- UI: separate Work and Chat modes, switched from the titlebar; the sidebar lists only the active mode's threads, work grouped by project and chats by recency.
- UI: agent inspector: the lead and its children as a tree with colour-coded state, the selected agent's model, effort, access, tokens, cost and latest message, actions to open, message, interrupt or stop it, and the thread's usage per provider.
- `@cerium/desktop`: Electron shell with Windows Acrylic behind the UI, Windows' own caption buttons over the custom titlebar, a sandboxed preload, and links opening in the browser. `bun run dev:desktop` runs it against the UI dev server.
- UI: inside the Electron shell the titlebar reserves exactly the caption-button area Windows reports, and the window tint is lighter so the real Acrylic shows.
- UI: Cerium's "Prism C" mark in the titlebar and as the favicon.
- Desktop: the UI can open Windows' folder picker to choose where a work thread runs.
- UI: an Effect RPC client for the backend, wired into atoms: thread overviews and harness status that refresh as agents work, and each thread's history merged with its live events. In development the UI dev server hands the page the backend's connection; after a backend restart the client reconnects and picks the live feeds back up.
- UI: runs on live backend data: the sidebar lists real threads with their status and the installed harnesses; the transcript streams the open thread's lead and answers its approval cards; the composer starts new threads in a chosen folder with the picked model, effort and access (unavailable harnesses greyed out) and then messages the thread's lead; the inspector interrupts or stops agents; a slim notice reports a lost connection or a failed action. The hand-written fixtures are gone.
- UI: the transcript follows new output while you're at the end, stays put while you scroll back to read, and returns to the end when you send a message.
- UI: a shimmering "Working…" line shows the lead is busy while nothing else on screen moves: before its first output and between steps. A reasoning block shimmers while it streams.
- UI: the composer keeps a draft per thread (and per mode for a new one), puts the cursor in the message box when a thread opens, gives back a message that failed to send, and stops a running turn with Esc. The access menu shows each mode's icon, and the placeholder no longer promises @ mentions that don't exist yet.
- UI: the sidebar folds away from the titlebar or with Ctrl B (remembered across launches), leaving a new-thread button in the titlebar; Ctrl N opens a new thread and Ctrl J toggles the agent inspector, as their tooltips promised.

### Changed

- `@cerium/harness` takes `AccessMode` from `@cerium/protocol` instead of defining its own.
- The scripted fake harness adapter used in tests is shared from `@cerium/harness/testing`.
- `@cerium/store` applies its own bundled migrations unless given another folder.
- UI: agent markdown is sized for the conversation: compact headings, hanging list markers, inline code at the text's size, quiet blockquotes and links, and code blocks and tables as single cards with a copy button, without line numbers or download buttons.

### Fixed

- Desktop: Acrylic now shows through the window (the window is transparent), with edge resizing, Snap and Windows 11 rounded corners restored natively since Electron removes them from transparent windows.
- Claude adapter: trusted bus tools are approved inside the permission callback instead of through `allowedTools`, which bypassed the callback and triggered an SDK warning.
- `@cerium/rpc`: events reach the UI without the provider's original message, which isn't always strict JSON and ended the live event stream.
- UI: the message box no longer draws a second focus outline inside the composer's own focus border; components with their own focus style can opt out of the global ring.
- UI: picker labels in the composer stay on one line when space is tight.
- UI: logos of harnesses that can't run dim the same way whether the logo is in colour or not, in the sidebar and the model picker.
- UI: costs under a cent read "<$0.01" instead of "$0.00", and the inspector's latest message preview is plain text instead of raw markdown.
- UI: a thread whose lead has stopped or failed no longer offers a message box that can only fail; the composer says so and offers to start a new thread. Approval cards it left unanswered read as expired instead of offering buttons, and tool calls cut off mid-run read as interrupted instead of spinning forever.
- UI: the inspector only offers what an agent can do: "Message" moves to the composer for a live lead, "Interrupt turn" is only enabled mid-turn, and an agent that has stopped or failed has no actions. The "Open" button, which did nothing, is gone until agents get their own views.
- UI: stopping an agent from the inspector asks first, and says what stopping costs: a stopped lead ends its thread.
- UI: an empty sidebar explains where threads or chats will appear, and project groups use a plain folder icon, since a work folder needn't be a git repository.
- UI: the thread title in the titlebar is plain text instead of a button that opened nothing, so it drags the window like the rest of the titlebar.
- UI: the browser preview stands a light backdrop behind the light theme instead of the dark one.
