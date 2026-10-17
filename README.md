<div align="center">

<img src=".github/media/banner.png" alt="Cerium: one thread, every agent" width="100%" />

<p>
  <a href="https://github.com/nonlooped/cerium/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/nonlooped/cerium?include_prereleases&style=flat-square&label=release&color=f2f2f2&labelColor=1c1c1c" /></a>
  <a href="https://github.com/nonlooped/cerium/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/nonlooped/cerium/ci.yml?branch=main&style=flat-square&label=CI&labelColor=1c1c1c" /></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-f2f2f2?style=flat-square&labelColor=1c1c1c" /></a>
  <img alt="Platform: Windows" src="https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square&labelColor=1c1c1c&logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0wIDBoMTEuNHYxMS40SDB6TTEyLjYgMEgyNHYxMS40SDEyLjZ6TTAgMTIuNmgxMS40VjI0SDB6TTEyLjYgMTIuNkgyNFYyNEgxMi42eiIvPjwvc3ZnPg==" />
  <img alt="Price: free forever" src="https://img.shields.io/badge/price-free%20forever-3fb950?style=flat-square&labelColor=1c1c1c" />
</p>

<p>
  <img alt="Works with Claude Code" src="https://img.shields.io/badge/Claude%20Code-D97757?style=for-the-badge&logo=claude&logoColor=white" />
  <img alt="Works with Codex" src="https://img.shields.io/badge/Codex-111111?style=for-the-badge&logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik05LjIwNSA4LjY1OHYtMi4yNmMwLS4xOS4wNzItLjMzMy4yMzgtLjQyOGw0LjU0My0yLjYxNmMuNjE5LS4zNTcgMS4zNTYtLjUyMyAyLjExNy0uNTIzIDIuODU0IDAgNC42NjIgMi4yMTIgNC42NjIgNC41NjYgMCAuMTY3IDAgLjM1Ny0uMDI0LjU0N2wtNC43MS0yLjc1OWEuNzk3Ljc5NyAwIDAwLS44NTYgMGwtNS45NyAzLjQ3M3ptMTAuNjA5IDguOFYxMi4wNmMwLS4zMzMtLjE0My0uNTctLjQyOS0uNzM3bC01Ljk3LTMuNDczIDEuOTUtMS4xMThhLjQzMy40MzMgMCAwMS40NzYgMGw0LjU0MyAyLjYxN2MxLjMwOS43NiAyLjE4OSAyLjM3OCAyLjE4OSAzLjk0OCAwIDEuODA4LTEuMDcgMy40NzMtMi43NiA0LjE2M3pNNy44MDIgMTIuNzAzbC0xLjk1LTEuMTQyYy0uMTY3LS4wOTUtLjIzOS0uMjM4LS4yMzktLjQyOFY1Ljg5OWMwLTIuNTQ1IDEuOTUtNC40NzIgNC41OTEtNC40NzIgMSAwIDEuOTI3LjMzMyAyLjcxMi45MjhMOC4yMyA1LjA2N2MtLjI4NS4xNjYtLjQyOC40MDQtLjQyOC43Mzd2Ni44OTh6TTEyIDE1LjEyOGwtMi43OTUtMS41N3YtMy4zM0wxMiA4LjY1OGwyLjc5NSAxLjU3djMuMzNMMTIgMTUuMTI4em0xLjc5NiA3LjIzYy0xIDAtMS45MjctLjMzMi0yLjcxMi0uOTI3bDQuNjg2LTIuNzEyYy4yODUtLjE2Ni40MjgtLjQwNC40MjgtLjczN3YtNi44OThsMS45NzQgMS4xNDJjLjE2Ny4wOTUuMjM4LjIzOC4yMzguNDI4djUuMjMzYzAgMi41NDUtMS45NzQgNC40NzItNC42MTQgNC40NzJ6bS01LjYzNy01LjMwM2wtNC41NDQtMi42MTdjLTEuMzA4LS43NjEtMi4xODgtMi4zNzgtMi4xODgtMy45NDhBNC40ODIgNC40ODIgMCAwMTQuMjEgNi4zMjd2NS40MjNjMCAuMzMzLjE0My41NzEuNDI4LjczOGw1Ljk0NyAzLjQ0OS0xLjk1IDEuMTE4YS40MzIuNDMyIDAgMDEtLjQ3NiAwem0tLjI2MiAzLjljLTIuNjg4IDAtNC42NjItMi4wMjEtNC42NjItNC41MTkgMC0uMTkuMDI0LS4zOC4wNDctLjU3bDQuNjg2IDIuNzFjLjI4Ni4xNjcuNTcxLjE2Ny44NTYgMGw1Ljk3LTMuNDQ4djIuMjZjMCAuMTktLjA3LjMzMy0uMjM3LjQyOGwtNC41NDMgMi42MTZjLS42MTkuMzU3LTEuMzU2LjUyMy0yLjExNy41MjN6bTUuODk5IDIuODNhNS45NDcgNS45NDcgMCAwMDUuODI3LTQuNzU2QzIyLjI4NyAxOC4zMzkgMjQgMTUuODQgMjQgMTMuMjk2YzAtMS42NjUtLjcxMy0zLjI4Mi0xLjk5OC00LjQ0OC4xMTktLjUuMTktLjk5OS4xOS0xLjQ5OCAwLTMuNDAxLTIuNzU5LTUuOTQ3LTUuOTQ2LTUuOTQ3LS42NDIgMC0xLjI2LjA5NS0xLjg4LjMxQTUuOTYyIDUuOTYyIDAgMDAxMC4yMDUgMGE1Ljk0NyA1Ljk0NyAwIDAwLTUuODI3IDQuNzU3QzEuNzEzIDUuNDQ3IDAgNy45NDUgMCAxMC40OWMwIDEuNjY2LjcxMyAzLjI4MyAxLjk5OCA0LjQ0OC0uMTE5LjUtLjE5IDEtLjE5IDEuNDk5IDAgMy40MDEgMi43NTkgNS45NDYgNS45NDYgNS45NDYuNjQyIDAgMS4yNi0uMDk1IDEuODgtLjMwOWE1Ljk2IDUuOTYgMCAwMDQuMTYyIDEuNzEzeiIvPjwvc3ZnPg==" />
  <img alt="Works with Muse Code" src="https://img.shields.io/badge/Muse%20Code-0467DF?style=for-the-badge&logo=meta&logoColor=white" />
  <img alt="Works with Cursor" src="https://img.shields.io/badge/Cursor-1c1c1c?style=for-the-badge&logo=cursor&logoColor=white" />
</p>

**A desktop harness of harnesses.** Cerium drives Claude Code, Codex, Muse Code and Cursor through
their own official SDKs, and lets one conversation coordinate agents from all of them at once.

[**Download**](https://github.com/nonlooped/cerium/releases) ·
[Features](#features) ·
[How it works](#how-it-works) ·
[Build from source](#build-from-source) ·
[Contributing](CONTRIBUTING.md)

</div>

<br />

<p align="center">
  <img src=".github/media/hero.png" alt="A Claude lead working on a repo while a Codex agent writes tests and a Cursor agent reviews the code, with the agent inspector open" width="100%" />
</p>

## Why Cerium

Every lab now ships a great coding agent, and each one is best at something different. Cerium lets
you stop choosing. Ask one lead agent for something, and it can hand pieces of the job to agents
from other providers: Codex writes the tests while Cursor reviews the change and Claude implements
it, all in one thread you can follow, steer and stop.

- **The real harnesses, not imitations.** Cerium runs no agent loop of its own. Each agent is the
  harness you already use, with its own tools, models, prompts and behaviour.
- **Your logins stay yours.** Cerium never reads, stores or forwards tokens or keys. It only checks
  whether each harness is signed in, and starts that harness's own login when it isn't.
- **Nothing to configure.** Install the harnesses you want, sign in to them as usual, and Cerium
  finds them.

## Features

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>🧵 One thread, many providers</h3>
      A lead agent spawns children from any signed-in harness through Cerium's built-in MCP bus. They
      work in parallel, message each other within limits, and report back inline.
    </td>
    <td width="50%" valign="top">
      <h3>🔍 Agent inspector</h3>
      See every agent in the thread as a tree: its model, effort, access, tokens, cost and latest
      message. Open, message, interrupt or stop any of them.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>🛡️ Access you control</h3>
      Read only, ask first, accept edits or full access, per agent. A child's access can only narrow
      its lead's. Approvals arrive as cards with diffs, and children's requests gather in a tray.
    </td>
    <td valign="top">
      <h3>💬 Work and Chat</h3>
      Work threads run in a folder and are grouped by project. Chat threads have no folder and keep
      agents to read-only tools like web search.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>📊 Usage at a glance</h3>
      Tokens and cost per turn, per agent and per provider, straight from each harness's own
      reporting.
    </td>
    <td valign="top">
      <h3>🎨 Native on Windows</h3>
      Translucent Acrylic, Windows' own caption buttons, dark and light themes, keyboard shortcuts
      throughout, and inline visual artifacts agents can draw in a sandboxed frame.
    </td>
  </tr>
</table>

<table>
  <tr>
    <td width="50%" valign="top">
      <img src=".github/media/approval.png" alt="An approval card asking to run a command, with Allow once, Allow for session and Deny" />
      <p align="center"><sub>Approve commands and edits as they come up</sub></p>
    </td>
    <td width="50%" valign="top">
      <img src=".github/media/result.png" alt="The lead's summary table of what changed and which agent did it" />
      <p align="center"><sub>The lead pulls everyone's work together</sub></p>
    </td>
  </tr>
</table>

<p align="center">
  <img src=".github/media/light.png" alt="The same thread in Cerium's light theme, with the agent inspector open" width="100%" />
  <br />
  <sub>Light and dark themes, following Windows or your choice</sub>
</p>

## Supported harnesses

| Harness         | Provider  | How Cerium drives it                                                | Sign-in                  |
| --------------- | --------- | ------------------------------------------------------------------- | ------------------------ |
| **Claude Code** | Anthropic | Claude Agent SDK, running your installed `claude`                   | `claude` login           |
| **Codex**       | OpenAI    | `codex app-server` JSON-RPC, with types generated from your install | `codex login`            |
| **Muse Code**   | Meta      | `@muse-code/sdk` over `muse serve`                                  | `muse login`             |
| **Cursor**      | Cursor    | `@cursor/sdk`, running Cursor's agent locally                       | Cursor's browser sign-in |

Cerium never bundles a provider's CLI. Each adapter checks your installed version against the range
it was tested with: newer versions run and are marked untested, and only versions that are too old
are blocked, with upgrade instructions.

<p align="center">
  <img src=".github/media/harnesses.png" alt="Harnesses settings showing each installed harness, its version, whether Cerium has tested it and how it's signed in" width="62%" />
</p>

Cerium is an independent project and is not affiliated with or endorsed by Anthropic, OpenAI, Meta
or Anysphere. Product names are the trademarks of their owners.

## How it works

```mermaid
flowchart LR
  UI["Cerium UI<br/>(React)"] <-- "RPC over WebSocket" --> Backend["Cerium backend<br/>(Effect)"]
  Backend --> Store[("SQLite<br/>event log")]
  Backend --> Claude["Claude Code"]
  Backend --> Codex["Codex"]
  Backend --> Muse["Muse Code"]
  Backend --> Cursor["Cursor"]
  Claude & Codex & Muse & Cursor <-. "MCP bus:<br/>spawn, message, stop" .-> Backend
```

- **Adapters** translate each harness's own stream into one canonical event schema. The UI, the
  store and the orchestrator only ever see those events.
- **The orchestration bus** is an MCP server Cerium injects into every session. It's the only way an
  agent spawns another: each harness's native subagents are turned off, so every agent stays
  visible in the thread.
- **Everything is an event.** Threads persist as an append-only log in SQLite, so a stopped lead can
  pick its harness session back up when you message it again, even after a restart.

## Install

1. Install at least one harness and sign in to it the way you normally would.
2. Download the latest installer from [Releases](https://github.com/nonlooped/cerium/releases) and
   run it.
3. Open Cerium. It finds your harnesses on its own; **Settings → Harnesses** shows what it found.

> [!NOTE]
> Cerium is in early development and currently ships **nightly** builds for **Windows**. macOS and
> Linux are planned. Nightlies install beside stable releases and keep their own data.

## Build from source

Requires [Node.js](https://nodejs.org) 24.11+ and [Bun](https://bun.sh) 1.4+.

```sh
git clone https://github.com/nonlooped/cerium.git
cd cerium
bun install
bun run dev          # backend, UI and desktop window in one terminal
```

| Command                 | What it does                                                |
| ----------------------- | ----------------------------------------------------------- |
| `bun run dev`           | Backend, UI dev server and Electron window together         |
| `bun run dev --browser` | The same, in your browser at `localhost:5173`               |
| `bun run verify`        | Format, lint, typecheck and test, as CI does                |
| `bun run package`       | Build an unsigned Windows installer into `apps/desktop/out` |

See [CONTRIBUTING.md](CONTRIBUTING.md) for the project layout and how changes land.

## Built with

<p>
  <img alt="Electron" src="https://img.shields.io/badge/Electron-1c1c1c?style=flat-square&logo=electron&logoColor=9FEAF9" />
  <img alt="React" src="https://img.shields.io/badge/React-1c1c1c?style=flat-square&logo=react&logoColor=61DAFB" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-1c1c1c?style=flat-square&logo=typescript&logoColor=3178C6" />
  <img alt="Effect" src="https://img.shields.io/badge/Effect-1c1c1c?style=flat-square&logo=effect&logoColor=white" />
  <img alt="Tailwind CSS" src="https://img.shields.io/badge/Tailwind%20CSS-1c1c1c?style=flat-square&logo=tailwindcss&logoColor=06B6D4" />
  <img alt="Vite" src="https://img.shields.io/badge/Vite+-1c1c1c?style=flat-square&logo=vite&logoColor=A855F7" />
  <img alt="Bun" src="https://img.shields.io/badge/Bun-1c1c1c?style=flat-square&logo=bun&logoColor=FBF0DF" />
</p>

## Contributing

Bug reports, ideas and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md),
and please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues go through
[SECURITY.md](SECURITY.md), not public issues.

## License

Cerium is free and open source under the [Apache License 2.0](LICENSE).
