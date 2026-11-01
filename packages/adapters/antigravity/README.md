# Antigravity

Cerium uses Google's official **Antigravity ACP runtime**, distributed through the
[ACP Registry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json).
Google's [release notes](https://antigravity.google/docs/changelog) document support for custom ACP
clients. This is the route T3 Code uses. Cerium implements its own adapter and identifies itself as
Cerium; it does not impersonate Zed to obtain models Google's runtime restricts to other clients.

This runtime is separate from `agy` (Antigravity CLI), with its own sign-in and conversation history.
No Gemini CLI, hidden `agy acp`, community wrapper, conversation SQLite parser, subscription token
forwarding, or Python API-key SDK is involved. Provider executables are never bundled in Cerium.

Download the archive for your OS/architecture, extract the ACP executable and matching
`localharness_external` helper into the same folder, and make them executable on macOS/Linux. Put
`agy_acp_server.exe` (Windows), `agy_acp_server.par` or `agy_acp_server` (macOS/Linux) on PATH, or set
`CERIUM_ANTIGRAVITY_PATH` to its absolute path. Sign in using Settings → Harnesses in Cerium. The
runtime opens and handles Google's sign-in itself and stores its own credentials. Cerium only reads
the result of a session access check. Existing native API-key/enterprise settings remain native;
Cerium's browser button starts personal Google OAuth and never accepts a provider key.

## Capabilities and evidence

`initialize` was run live against the Windows x64 official runtime **1.4.5**. It reports image input,
HTTP/SSE MCP, session load/resume/list, and appending system instructions. Starting a session returns
ACP `-32000 Authentication required`; no account is selected on this machine. The initialize fixture
is captured from that response; all signed-in session fixtures are explicitly **hand-built**.

| Capability                       | Adapter behavior                                                                        | Verification                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| MCP and computer use             | Per-session ACP `mcpServers`; Cerium's computer tools use that same bus                 | Negotiated live; calls fixture-tested, signed-in runtime unverified     |
| Approvals                        | Reset native mode to `default`, then route requests through Cerium's access policy      | Fixture-tested; live approvals unverified                               |
| Read only                        | Default native mode, deny requested edits/commands; trusted bus tools still run         | Fixture-tested; live enforcement unverified                             |
| Model listing/switching          | Native config options, one query per model for its own thinking choices                 | Fixture-tested; account/model access unverified                         |
| Effort                           | `thought_level` config option; only levels reported for each model                      | Fixture-tested; live switching/cache behavior unverified                |
| Images                           | ACP image content blocks                                                                | Negotiated live; fixture-tested                                         |
| Resume and import                | ACP `session/resume`, `session/list`, `session/load` replay                             | Negotiated live; fixture-tested; ACP history only, not CLI DB           |
| Skills                           | Native project/global skill directories and `$name` path references                     | File discovery; native execution unverified                             |
| Tokens/context                   | Standard ACP usage fields when supplied; missing usage stays unreported                 | Fixture-tested; actual runtime token reporting unverified               |
| Dollar cost, subscription meters | Unavailable: no implemented official reporting interface                                | No estimates presented as actual usage                                  |
| Fork / side question             | Unavailable: no supported conversation rewind or disposable copy                        | Manifest/methods omit support                                           |
| Manual compaction                | Unavailable: ACP runtime doesn't expose the CLI's `/compact`                            | Manifest false                                                          |
| Small helper completions         | Unavailable: no tool-free, unsaved session primitive                                    | `complete()` fails with a clear explanation; not in default title picks |
| Native subagents                 | Cannot disable using a supported option; instructions ask it to delegate through Cerium | Manifest `notDisableable`; instruction alone isn't enforcement          |
| Sign-in                          | Native ACP `authenticate` (`oauth-personal`) and browser URL notice                     | Signed-out status live; browser flow unverified                         |

Native choice questions use `session/request_permission` too. They are cancelled rather than
silently selecting an arbitrary option in full access; system instructions direct questions through
Cerium's `ask_user` MCP tool. That behavior is fixture-tested; the live question flow is unverified.

The native runtime loads `GEMINI_HOME/config/mcp_config.json` (`~/.gemini` by default), with no
documented per-session exclusion switch. If that file contains servers and the Cerium agent excludes
user MCP, startup **fails closed**, explaining how to enable inclusion. Cerium never edits that file
or copies credentials into another profile. Project hooks and native permission rules remain the
runtime's responsibility; signed-in smoke checks must confirm that its default mode requests all
risky actions. Installing an untested runtime does not establish that behavior.

Native tool field aliases, the system-instruction `_meta` extension and Google's out-of-band OAuth
URL notice are isolated in `src/harness.ts` and `src/probe.ts`. Tool fields and the URL text are vendor
details outside ACP's stable schema and can change. No undocumented headless JSON format is used.

## Owner checks

After installing and signing in to the official ACP runtime:

```sh
node packages/adapters/antigravity/scripts/smoke.ts
node packages/adapters/antigravity/scripts/record-fixture.ts
```

Both have deadlines. The smoke script exercises actual MCP injection, editing approval, rejection,
read-only policy, model/effort switching, resume and history import. The recorder writes sanitized
ACP traffic into a new scratch recording, never overwriting the hand-built tests. Review it before
promoting it to a fixture. OAuth and authentication traffic are excluded. Google account eligibility,
native permission inheritance, trusted MCP tool identity, and cancellation still require a signed-in
live pass before claiming production verification.
