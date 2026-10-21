# Security policy

## Supported versions

Cerium is in early development. Only the **latest release** (stable or nightly) gets security
fixes; please update before reporting.

## Reporting a vulnerability

**Please don't report security problems in public issues, discussions or pull requests.**

Report them privately through GitHub instead:
[**Report a vulnerability**](https://github.com/nonlooped/cerium/security/advisories/new).

Include what you can of:

- what the problem is and what an attacker could do with it,
- the steps or a proof of concept to reproduce it,
- your Cerium version, operating system (Windows version, or Linux distribution and desktop), and
  the harnesses and versions involved.

You'll get an acknowledgement within a few days. Once the problem is confirmed, a fix is prepared
privately and released, and the advisory is published with credit to you unless you'd rather stay
anonymous.

## Scope

Things that are especially in scope, because Cerium is built to guarantee them:

- Cerium reading, storing or sending a harness's credentials (tokens, keys, cookies).
- An agent getting more access than its thread or its lead allows: writing in read-only mode, running
  commands without approval in modes that ask, or a child's access widening past its lead's.
- Another program or website reaching the local backend or the MCP bus without the launch token.
- Agent-drawn artifacts running scripts or loading anything from the network.

Problems inside a harness itself (Claude Code, Codex, Muse Code, Cursor or OpenCode) belong to its vendor.
If you're unsure where one belongs, report it here and we'll help route it.
