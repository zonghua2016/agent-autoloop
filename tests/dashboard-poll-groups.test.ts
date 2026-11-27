// Equal titles on distinct business events must never hide a task; routine ticks retain individual history.
import assert from "node:assert/strict";
import { test } from "node:test";
test("only equivalent successful scheduled runs share a group", async () => {
  const { scheduledGroup } = await import(
    new URL("../examples/recipes/live-dashboard/public/poll-groups.js", import.meta.url).href
  );
  const run = {
    rule: "poll",
    agent: "poller",
    state: "done",
    summary: "checked",
    events: [{ source: "schedule", type: "schedule.tick" }],
  };
  assert.equal(scheduledGroup({ ...run, id: 1 }), scheduledGroup({ ...run, id: 2 }));
  assert.notEqual(scheduledGroup(run), scheduledGroup({ ...run, summary: "claimed a bug" }));
  assert.equal(scheduledGroup({ ...run, error: "stale" }), null);
  assert.equal(scheduledGroup({ ...run, events: [{ source: "external", type: "schedule.tick" }] }), null);
});
