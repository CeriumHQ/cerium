import assert from "node:assert/strict";

import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { accessPolicy } from "../src/config.ts";
import { connect } from "../src/rpc.ts";

// Exercise the actual stdio handshake against Codex's capability gate without a login or inference.
const serverScript = `
  const readline = require('node:readline');
  let experimental = false;
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const { id, method, params } = JSON.parse(line);
    if (method === 'initialize') {
      experimental = params.capabilities?.experimentalApi === true;
      console.log(JSON.stringify({ id, result: { codexHome: '/test' } }));
    } else if (method === 'thread/start') {
      const error = params.approvalPolicy?.granular && !experimental;
      console.log(JSON.stringify(error
        ? { id, error: { code: -32600, message: 'askForApproval.granular requires experimentalApi capability' } }
        : { id, result: { thread: { id: 'read-only-thread' } } }));
    }
  });
`;

it.live("negotiates the capability required to start read-only Codex threads", () =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const server = yield* connect("codex").pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          spawner.spawn(ChildProcess.make(process.execPath, ["-e", serverScript])),
        ),
      ),
    );
    const policy = accessPolicy("readOnly");
    assert.equal(policy.sandbox, "read-only");
    assert.deepEqual(policy.approvalPolicy, {
      granular: {
        sandbox_approval: false,
        rules: false,
        skill_approval: false,
        request_permissions: false,
        mcp_elicitations: true,
      },
    });
    const response = yield* server.request("thread/start", {
      sandbox: policy.sandbox,
      approvalPolicy: policy.approvalPolicy,
      approvalsReviewer: policy.approvalsReviewer,
    });
    assert.equal(response.thread.id, "read-only-thread");
  }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.provide(NodeServices.layer)),
);
