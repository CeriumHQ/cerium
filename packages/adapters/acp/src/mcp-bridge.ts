// An MCP server on stdio that forwards to one over Streamable HTTP, for agents that start only stdio
// MCP servers (all that ACP requires of them) while Cerium's bus speaks HTTP:
//   node mcp-bridge.ts <url>        with the server's headers as a JSON object in CERIUM_MCP_HEADERS
// Each JSON-RPC message read from stdin is POSTed to the server, and what it answers, as JSON or as
// server-sent events, goes back to stdout a message per line. It uses Node's own modules only: the
// packaged app runs it from the bundle beside its backend, with Cerium's Electron as Node.

import { createInterface } from "node:readline";

const url = process.argv[2];
if (url === undefined || url === "") {
  process.stderr.write("Usage: mcp-bridge <url>, with headers as JSON in CERIUM_MCP_HEADERS\n");
  process.exit(2);
}
const headers = JSON.parse(process.env["CERIUM_MCP_HEADERS"] || "{}") as Record<string, string>;
/** The session the server gave at `initialize`, sent with every message after it. */
let session: string | undefined;

const writeLines = (text: string) => {
  for (const line of text.split("\n")) {
    if (line.trim() !== "") process.stdout.write(`${line.trim()}\n`);
  }
};

/** Answers a request the server couldn't, so the agent isn't left waiting on it. */
const failed = (id: unknown, message: string) => {
  if (typeof id === "string" || typeof id === "number") {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } })}\n`);
  }
};

/** The data of each server-sent event, as it arrives. */
async function* eventData(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffered = "";
  const take = function* (final: boolean) {
    buffered = buffered.replaceAll("\r\n", "\n");
    let end = buffered.indexOf("\n\n");
    while (end !== -1 || (final && buffered.trim() !== "")) {
      const event = end === -1 ? buffered : buffered.slice(0, end);
      buffered = end === -1 ? "" : buffered.slice(end + 2);
      const data = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5));
      if (data.length > 0) yield data.join("\n");
      end = buffered.indexOf("\n\n");
    }
  };
  for await (const chunk of body) {
    buffered += decoder.decode(chunk, { stream: true });
    yield* take(false);
  }
  buffered += decoder.decode();
  yield* take(true);
}

const forward = async (line: string) => {
  let id: unknown;
  try {
    id = (JSON.parse(line) as { readonly id?: unknown }).id;
  } catch {
    return;
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session === undefined ? {} : { "mcp-session-id": session }),
      },
      body: line,
    });
    session = response.headers.get("mcp-session-id") ?? session;
    // A notification or an answer the server took in.
    if (response.status === 202 || response.body === null) return;
    const type = response.headers.get("content-type") ?? "";
    if (type.startsWith("text/event-stream")) {
      for await (const data of eventData(response.body)) writeLines(data);
      return;
    }
    const text = await response.text();
    // A refusal comes as a JSON-RPC error too, whatever its status.
    if (type.startsWith("application/json") && text.trim() !== "") return writeLines(text);
    failed(id, `Cerium's MCP server answered ${response.status} ${response.statusText}`.trim());
  } catch (cause) {
    failed(
      id,
      `Cerium's MCP server is unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
};

/** Settles once `initialize` has been answered: the session it opens goes with what follows. */
let opened: Promise<void> = Promise.resolve();
createInterface({ input: process.stdin })
  .on("line", (line) => {
    const sent = opened.then(() => forward(line));
    if (/"method"\s*:\s*"initialize"/.test(line)) opened = sent;
  })
  .on("close", () => {
    // The agent is done with the server: end the session, where the server keeps one.
    const end =
      session === undefined
        ? Promise.resolve()
        : fetch(url, {
            method: "DELETE",
            headers: { ...headers, "mcp-session-id": session },
            signal: AbortSignal.timeout(2000),
          }).then(
            () => undefined,
            () => undefined,
          );
    void end.then(() => process.exit(0));
  });
