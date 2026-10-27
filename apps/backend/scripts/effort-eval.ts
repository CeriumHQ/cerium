// Offline policy evaluation; never reads credentials or calls a model.
// bun run effort:eval --database=<cerium.db> > traces.jsonl
// Label representative traces with acceptable: [efforts]. Optional outcomes: { effort: { success,
// costUsd, ms } } must come from executions from the same starting state, not inferred token prices.
// bun run effort:eval --cases=<labelled.jsonl>
// Keep entire threads in either the tuning set or held-out set; do not split adjacent turns.
import { selectEffort, POLICY_VERSION } from "@cerium/orchestrator";
import { ReasoningEffort } from "@cerium/protocol";
import { Schema } from "effect";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const Probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const Case = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  question: Schema.Struct({
    levels: Schema.NonEmptyArray(ReasoningEffort),
    state: Schema.Struct({
      turn: Schema.Struct({ from: Schema.Literals(["user", "agent"]), text: Schema.String }),
      recent: Schema.Array(Schema.Struct({ sent: Schema.String, replied: Schema.String })),
      previousTurn: Schema.optionalKey(
        Schema.Struct({
          toolCalls: Schema.Finite,
          seconds: Schema.Finite,
          failed: Schema.Boolean,
          filesChanged: Schema.Finite,
          toolErrors: Schema.optionalKey(Schema.Finite),
          stopReason: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  }),
  answer: Schema.Struct({
    probabilities: Schema.Array(Probability),
    confidence: Probability,
    contextSufficient: Schema.optionalKey(Probability),
  }),
  current: Schema.optionalKey(ReasoningEffort),
  baseline: ReasoningEffort,
  acceptable: Schema.NonEmptyArray(ReasoningEffort),
  outcomes: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        success: Schema.Boolean,
        costUsd: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
        ms: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
      }),
    ),
  ),
});
const flag = (name: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const database = flag("database");
const cases = flag("cases");
if (database && !cases) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    for (const row of db
      .prepare("SELECT id, thread_id, payload FROM events WHERE tag='EffortRouted' ORDER BY at")
      .all()) {
      const trace = JSON.parse(String(row.payload)) as Record<string, unknown>;
      if (!trace.question || !trace.probabilities || !trace.baselineEffort) continue;
      console.log(
        JSON.stringify({
          id: row.id,
          threadId: row.thread_id,
          question: trace.question,
          answer: {
            probabilities: trace.probabilities,
            confidence: trace.confidence,
            contextSufficient: trace.contextSufficient,
          },
          current: trace.beforeEffort,
          baseline: trace.baselineEffort,
          acceptable: [],
          outcomes: {},
          recordedEffort: trace.effort,
          policyVersion: trace.policyVersion,
        }),
      );
    }
  } finally {
    db.close();
  }
} else if (cases && !database) {
  const rows = readFileSync(cases, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => Schema.decodeUnknownSync(Case)(JSON.parse(line)));
  if (!rows.length) throw new Error("No labelled cases supplied.");
  const report = ["router", "default", "high"].map((policy) => {
    let accepted = 0;
    let under = 0;
    let measured = 0;
    let succeeded = 0;
    let costUsd = 0;
    let ms = 0;
    for (const row of rows) {
      const levels = row.question.levels;
      if (!row.acceptable.every((level) => levels.includes(level)) || !levels.includes(row.baseline))
        throw new Error(`Unsupported label or baseline in ${row.id}`);
      const effort =
        policy === "router"
          ? selectEffort(row.question, row.answer, row.current, row.baseline).effort
          : policy === "default"
            ? row.baseline
            : (levels.find((level) => level === "high") ?? levels.at(-1)!);
      if (row.acceptable.includes(effort)) accepted++;
      if (levels.indexOf(effort) < Math.min(...row.acceptable.map((level) => levels.indexOf(level)))) under++;
      const outcome = row.outcomes?.[effort];
      if (outcome) {
        measured++;
        if (outcome.success) succeeded++;
        costUsd += outcome.costUsd;
        ms += outcome.ms;
      }
    }
    return {
      policy,
      cases: rows.length,
      acceptable: accepted,
      underEffort: under,
      measured,
      succeeded,
      costUsd,
      ms,
    };
  });
  console.log(JSON.stringify({ policyVersion: POLICY_VERSION, report }, null, 2));
} else {
  throw new Error(
    "Use --database=<cerium.db> to export traces, or --cases=<labelled.jsonl> to evaluate. Outcomes require real executions; missing outcomes are not counted as successes.",
  );
}
