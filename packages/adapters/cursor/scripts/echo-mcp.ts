// A minimal stdio MCP server with one tool, `echo`, for the live scripts: it shows that a server
// Cerium injects reaches the Cursor agent and runs without an approval prompt.
//
// Usage: node packages/adapters/cursor/scripts/echo-mcp.ts (spoken to over stdin/stdout)

import { createInterface } from "node:readline";

interface Request {
  readonly id?: number | string;
  readonly method: string;
  readonly params?: {
    readonly protocolVersion?: string;
    readonly arguments?: { readonly text?: unknown };
  };
}

const reply = (id: number | string, result: unknown) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

const results: Record<string, (request: Request) => unknown> = {
  // Agrees to whichever protocol version the client asks for; the one tool works the same in all.
  initialize: (request) => ({
    protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
    capabilities: { tools: {} },
    serverInfo: { name: "cerium-echo", version: "0.0.0" },
  }),
  ping: () => ({}),
  "tools/list": () => ({
    tools: [
      {
        name: "echo",
        description: "Returns the given text, JSON-quoted and prefixed with 'echo:'.",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      },
    ],
  }),
  "tools/call": (request) => ({
    content: [{ type: "text", text: `echo:${JSON.stringify(request.params?.arguments?.text ?? "")}` }],
  }),
};

for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim() === "") continue;
  const request = JSON.parse(line) as Request;
  const result = results[request.method];
  // Notifications (no id) need no answer.
  if (request.id === undefined) continue;
  if (result === undefined) {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } })}\n`,
    );
  } else {
    reply(request.id, result(request));
  }
}
