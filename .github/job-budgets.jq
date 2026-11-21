# GitHub reports integral UTC seconds. Compare completed jobs from this attempt only.
def seconds($start; $end): ($end | fromdateiso8601) - ($start | fromdateiso8601);
def check($phase; $duration; $limit):
  if $duration < 0 then error("invalid " + $phase + " timestamps for " + .name)
  elif $duration >= $limit then "\(.name) • \($phase) took \($duration)s (budget <\($limit)s)"
  else empty end;

if any(.[]; .name == "Plan" and .status == "completed") then .
else error("missing Plan execution in this workflow attempt") end |
.[] | select(.name != "Full merge suite" and .name != "Nightly deployment" and .name != "Publish the nightly") |
  if .status != "completed" then error("missing completion for " + .name) else . end |
  select(.conclusion != "skipped" and (.steps | length) > 0) |
  .name as $job |
  # Include runner initialization, checkout, the workspace action and browser prerequisites.
  ([.steps[] | select(.conclusion != "skipped" and .started_at != null) |
    select(.name | test("^(Set up job$|Run actions/(checkout|setup-node)@|Run \\.\/\\.github/actions/setup$|Let Edge sandbox itself$|Post |Complete job$)") | not)
  ][0].started_at // .completed_at) as $work |
  check("waiting"; seconds(.created_at; .started_at); 5),
  check("setup"; seconds(.started_at; $work); 15),
  check("assigned job"; seconds(.started_at; .completed_at); 35),
  (.steps[] | select(.conclusion == "success" or .conclusion == "failure") |
    if .name == "Test" then check($job + " execution"; seconds(.started_at; .completed_at); 30)
    elif .name == "Run bun run typecheck" or .name == "Typecheck" then
      check($job + " execution"; seconds(.started_at; .completed_at); 5)
    else empty end)
