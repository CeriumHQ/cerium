// An ACP agent that plays back a recorded session:
//   node replay-agent.mjs <recording.jsonl> [initialize.json]
// where each line is `{ "dir": "in" | "out", "msg": … }` as a fixture recorder wrote it ("in" came from
// the agent, "out" from the client). Each request the client sends is matched to the next recorded one
// of the same method, and what the agent sent after it plays back until the recording waits on the
// client again: for its next request, or for its answer to one of the agent's own. `initialize` is
// answered with the second file, where the recording leaves the agent's own answer out. Requests the
// recording doesn't hold (a session closing) are answered with an empty result.

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const initialized =
  process.argv[3] === undefined ? undefined : JSON.parse(readFileSync(process.argv[3], "utf8"));
const recording = readFileSync(process.argv[2], "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line));

let cursor = 0;
/** Recorded request ids of the client's, by the ids this client gave them. */
const ids = new Map();

const write = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);

const isAgentRequest = (msg) => msg.method !== undefined && msg.id !== undefined;

/** Plays the agent's side on from the cursor until the recording waits on the client. */
const play = () => {
  while (cursor < recording.length) {
    const { dir, msg } = recording[cursor];
    if (dir === "out") return;
    cursor++;
    if (msg.method === undefined && msg.id !== undefined) {
      // An answer to one of the client's requests, under the id this client gave it.
      write({ ...msg, id: ids.get(msg.id) ?? msg.id });
      continue;
    }
    write(msg);
    // The agent asked something: the recording goes on once the client answers.
    if (isAgentRequest(msg)) return;
  }
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === undefined) {
    // The client answered the agent: past the recorded answer, and on.
    const at = recording.findIndex(
      (entry, index) => index >= cursor && entry.dir === "out" && entry.msg.method === undefined,
    );
    if (at !== -1) cursor = at + 1;
    play();
    return;
  }
  const at = recording.findIndex(
    (entry, index) => index >= cursor && entry.dir === "out" && entry.msg.method === msg.method,
  );
  if (at === -1) {
    if (msg.id !== undefined) write({ id: msg.id, result: {} });
    return;
  }
  const recorded = recording[at].msg;
  if (recorded.id !== undefined && msg.id !== undefined) ids.set(recorded.id, msg.id);
  cursor = at + 1;
  if (msg.method === "initialize" && initialized !== undefined) write({ id: msg.id, result: initialized });
  play();
});
