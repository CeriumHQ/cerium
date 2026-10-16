# Changelog

All notable changes to Cerium are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Bun workspace with Vite+ for build, lint, format and test, TypeScript 7, and Effect language service diagnostics.
- Apache-2.0 license.
- Agent skills for design grilling, retros, wizards and writing agent docs.
- `bun run vendor:effect` fetches the pinned Effect source as a reference for coding agents.
- Architecture decision record and auto-router design in `docs/`.
- Agent guidelines in `AGENTS.md`, including git and changelog rules.
- `@cerium/protocol`: canonical agent events, capability manifests and harness status schemas.
- `@cerium/harness`: the adapter contract every provider implements, plus version range checks.
- Claude adapter: translates Claude Agent SDK messages into canonical events, tested against a recorded session.
