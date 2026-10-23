# Security policy

## Reporting a vulnerability

Please don't report security problems in public issues, discussions or pull requests. Report them
privately through GitHub's private vulnerability reporting:
[**Report a vulnerability**](https://github.com/CeriumHQ/cerium/security/advisories/new).

Include what you can of what the problem is and what an attacker could do with it, the steps or a
proof of concept to reproduce it, and your Cerium version, operating system and the harnesses
involved.

## Scope

- **The desktop app**: the Electron shell, its local backend and the MCP bus agents use, including
  anything that lets another program or website reach them, an agent get more access than its thread
  or its lead allows, or Cerium read, store or send a harness's credentials.
- **The relay** at `cerium.nonlooped.xyz`: accounts, device sign-in, the cloud copy of your threads,
  and the web client it serves.
- **The website**, served by the relay.

Only the latest release, stable or nightly, gets fixes, so please check you're on it. Problems in a
harness itself (Claude Code, Codex, Muse Code, Cursor or OpenCode) belong to its vendor; if you're
unsure where one belongs, report it here and it will be passed on.

## What to expect

An acknowledgement within a few days, then word on whether the problem is confirmed. A confirmed
problem is fixed privately and released, and the advisory is published once the fix is out, with
credit to you unless you'd rather stay anonymous. Cerium is a small project with no bug bounty.
