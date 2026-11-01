# Grok Build

Cerium runs the user's installed `grok agent --no-leader stdio` on xAI's official ACP interface.
It never bundles the CLI or reads provider credentials. Install Grok Build and run `grok login`;
Cerium checks `_x.ai/auth/check_subscription`. Reference:
[headless and ACP](https://docs.x.ai/build/cli/headless-scripting),
[CLI reference](https://docs.x.ai/build/cli/reference),
[MCP](https://docs.x.ai/build/features/mcp-servers).

The Windows installation used for this implementation was **1.0.70**. Its real ACP session is
recorded in `test/fixtures/session.jsonl`; replay tests use the same Effect session runner as live
sessions. A fresh `bun run live-check --providers=grok --access=ask --approvals=allow` passed a real
write approval and checked the resulting file and reply (use `--include-user-mcp` when native servers
are configured). The fixture records reads, edits, commands,
injected MCP, denial, session import and compaction. These are real runtime observations; an image,
computer interaction and every model/account combination were not separately exercised.

| Capability         | Status / implementation                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP / computer use | Supported: per-session MCP, with the bundled stdio-to-HTTP bridge when needed. Computer use uses that bus; a real desktop action remains unverified.                          |
| Approvals          | Supported: ACP requests route to Cerium; live write approval passed. `yoloMode` is explicitly false outside full access; Grok's reviewer handles auto mode.                   |
| Read only          | Supported by rejecting requested edits/commands; the model is told that a refusal ends its turn. Enforcement still depends on Grok requesting risky tools in non-yolo mode.   |
| Models / effort    | Native initialized model state; live config switching, with only each model's listed efforts. Effort changes were observed to miss the cache, so cache-safe effort is false.  |
| Images             | Advertised by ACP and translated as image blocks; live image comprehension unverified.                                                                                        |
| Resume / import    | Native resume/list/load; recorded session replay is tested.                                                                                                                   |
| Fork               | Unsupported: native whole-session fork cannot rewind to the requested turn over ACP.                                                                                          |
| Side questions     | Native `/btw`; implementation uses the running session, with its own answer and usage, outside saved history.                                                                 |
| Compaction         | Supported via `_x.ai/compact_conversation`, including native automatic compaction notices.                                                                                    |
| Usage / cost       | Native per-turn tokens/cache/cost; partial costs are omitted. Native weekly credit meter is available.                                                                        |
| Skills             | Native session commands; `$skill` selections become native slash commands.                                                                                                    |
| Helper completions | One headless JSON turn with tools/subagents disabled; its temporary saved session is deleted. Instructions open the prompt because 1.0.70 ignores the system-prompt override. |
| Native subagents   | Disabled with Grok's `GROK_SUBAGENTS=0`.                                                                                                                                      |
| Speed              | No separate speed switch; Fast is a model variant at a different price.                                                                                                       |

Vendor ACP extensions live in `src/harness.ts`, `models.ts`, `usage.ts` and `aside.ts`. They include
`_x.ai/*` methods/notifications, `_meta.modelState`, `_meta.usage`, and Grok tool metadata; they are
outside the base ACP schema and may change independently. There is no undocumented headless
stream parser: helper jobs use the documented `--output-format json`.

Grok loads its own configured MCP servers alongside injected ones, with no supported per-session
exclusion switch. Before starting a session that excludes user MCP, Cerium checks `grok inspect
--json`; if it lists servers, startup fails with an explanation and the user must explicitly enable
inclusion. Cerium never edits that configuration. Native hooks and permission rules remain the
harness's responsibility. The broader smoke script explicitly includes native MCP for this reason.

To repeat the broader subscription-backed checks and regenerate native fixtures:

```sh
node packages/adapters/grok/scripts/smoke.ts
node packages/adapters/grok/scripts/record-fixture.ts
```

The broad smoke covers tools/MCP, effort, a side question during a turn, interruption, compaction,
resume, a helper completion and history import. Review fixture changes before committing them.
