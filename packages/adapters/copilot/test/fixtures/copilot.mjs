#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";

const cli = process.env.CERIUM_COPILOT_E2E_CLI;
const trace = process.env.CERIUM_COPILOT_E2E_TRACE;
const modelUrl = process.env.CERIUM_COPILOT_E2E_MODEL_URL;
process.on("uncaughtExceptionMonitor", (error) => {
  appendFileSync(trace, JSON.stringify({ fixtureError: String(error) }) + "\n");
});
const connect = (input, output) =>
  createMessageConnection(new StreamMessageReader(input), new StreamMessageWriter(output));

if (process.argv.includes("--version")) {
  if (!cli) {
    process.stdout.write("GitHub Copilot CLI 1.0.114.\n");
  } else {
    const child = spawn(cli, process.argv.slice(2), { stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 1));
  }
} else {
  assert(process.argv.includes("--headless") && process.argv.includes("--stdio"));
  assert(process.argv.includes("--sync-session=off"));
  assert.equal(process.env.COPILOT_ALLOW_ALL, undefined);

  const adapter = connect(process.stdin, process.stdout);
  const models = {
    models: [
      { id: "fixture/gpt-4o", name: "Fixture 4o" },
      {
        id: "fixture/gpt-4.1",
        name: "Fixture 4.1",
        supportedReasoningEfforts: ["high", "low", "future"],
        defaultReasoningEffort: "high",
      },
      { id: "blocked", name: "Blocked", policy: { state: "disabled" } },
    ],
  };

  // With the real CLI, replace only account and inference. All session, permission, event and
  // filesystem behavior comes from the installed binary and the loopback model.
  let runtime;
  if (cli) {
    const child = spawn(cli, process.argv.slice(2), { stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.on("data", (data) =>
      appendFileSync(trace, JSON.stringify({ cliStderr: data.toString() }) + "\n"),
    );
    runtime = connect(child.stdout, child.stdin);
    runtime.onNotification((method, params) => {
      if (
        method === "session.event" &&
        [
          "assistant.message_delta",
          "assistant.usage",
          "permission.requested",
          "permission.completed",
          "tool.execution_complete",
          "session.idle",
          "session.resume",
        ].includes(params?.event?.type)
      ) {
        appendFileSync(
          trace,
          JSON.stringify({ event: params.event.type, sessionId: params.sessionId, data: params.event.data }) +
            "\n",
        );
      }
      return adapter.sendNotification(method, params);
    });
    runtime.listen();
    process.stdin.on("end", () => child.stdin.end());
    for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
    child.on("close", (code) => process.exit(code ?? 0));
  }

  let opened;
  let prompt;
  let permissionId;
  let sequence = 0;
  const event = (sessionId, type, data = {}) =>
    adapter.sendNotification("session.event", { sessionId, event: { id: String(++sequence), type, data } });
  const end = async (sessionId, aborted = false) => {
    if (!aborted) {
      const messageId = `message-${sequence}`;
      await event(sessionId, "assistant.message_delta", { messageId, deltaContent: "fixture reply" });
      await event(sessionId, "assistant.message", { messageId, content: "fixture reply" });
      await event(sessionId, "assistant.usage", { inputTokens: 24, outputTokens: 3, cacheReadTokens: 4 });
    }
    await event(sessionId, "session.idle", { mode: "interactive", aborted });
  };

  adapter.onRequest(async (method, input) => {
    assert(input && !Array.isArray(input));
    let params = input;
    appendFileSync(trace, JSON.stringify({ method, params }) + "\n");
    const { sessionId } = params ?? {};
    if (method === "auth.getStatus") {
      if (process.env.CERIUM_COPILOT_E2E_LOGOUT !== "true") return { isAuthenticated: true };
      return runtime ? runtime.sendRequest(method, params) : { isAuthenticated: false };
    }
    if (method === "models.list") return models;
    if (runtime) {
      if (method === "session.create" || method === "session.resume") {
        params = Object.assign({}, params, {
          github: { ...params.github, capi: { enabled: false } },
          inference: {
            ...params.inference,
            defaultProvider: "fixture",
            providers: [{ name: "fixture", type: "openai", baseUrl: modelUrl, apiKey: "fixture" }],
            models: models.models
              .slice(0, 2)
              .map(({ id }) => ({ id: id.split("/")[1], provider: "fixture" })),
          },
        });
      }
      return runtime.sendRequest(method, params);
    }

    switch (method) {
      case "connect":
        return { protocolVersion: 4 };
      case "mcp.discover":
      case "session.mcp.listConfigured":
        return { servers: [] };
      case "session.create":
      case "session.resume":
        opened = params;
        return { sessionId };
      case "session.permissions.getMode":
        return { mode: "manual" };
      case "session.permissions.configure":
      case "session.model.switchTo":
        return { success: true, modelId: params.modelId };
      case "session.send": {
        prompt = params.prompt;
        if (prompt.startsWith("write ") && !opened.tools.availableTools) {
          const fileName = resolve(opened.workingDirectory, prompt.slice("write ".length));
          permissionId = `permission-${sequence}`;
          await event(sessionId, "tool.execution_start", {
            toolCallId: "create",
            toolName: "create",
            arguments: { path: fileName },
          });
          await event(sessionId, "permission.requested", {
            requestId: permissionId,
            permissionRequest: {
              kind: "write",
              toolCallId: "create",
              fileName,
              canOfferSessionApproval: true,
            },
          });
        } else {
          await end(sessionId);
        }
        return { messageId: "user-message" };
      }
      case "session.permissions.handlePendingPermissionRequest": {
        assert.equal(params.requestId, permissionId);
        const allowed = params.result.kind === "approve-once";
        await event(sessionId, "permission.completed", {
          requestId: permissionId,
          result: { kind: allowed ? "approved" : "denied-interactively-by-user" },
        });
        const fileName = resolve(opened.workingDirectory, prompt.slice("write ".length));
        if (allowed) writeFileSync(fileName, "fixture");
        await event(sessionId, "tool.execution_complete", {
          toolCallId: "create",
          success: allowed,
          ...(allowed ? { fileEdits: [{ path: fileName, kind: "create" }] } : {}),
        });
        await end(sessionId);
        return { success: true };
      }
      case "session.abort":
        await end(sessionId, true);
        return {};
      case "session.detach":
      case "session.delete":
        return { success: true };
      default:
        throw new Error(`Unexpected RPC method ${method}`);
    }
  });
  adapter.listen();
}
