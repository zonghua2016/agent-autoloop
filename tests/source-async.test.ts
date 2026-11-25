// Asynchronous translators must commit their events before acknowledging the webhook, including rejected signatures.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup, beforeCleanup } from "./helpers.ts";
const home = setup("async-source");
const rules = JSON.parse(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"));
rules.sources.sample = { name: "Sample", adapter: "sample" };
writeFileSync(join(home, "rules.json"), JSON.stringify(rules));
process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
const hub = await import("./hub.ts");
const { makeHandler } = await import("../host/server.ts");
mkdirSync(join(home, "plugins", "sample"), { recursive: true });
writeFileSync(
  join(home, "plugins", "sample", "source.ts"),
  `export default async ({body}) => {await Promise.resolve();if(body==='bad')throw Error('bad signature');return [{id:'one',type:'sample.ready'}];};`,
);
const handler = makeHandler();
beforeCleanup.unshift(() => handler.close());
hub.reloadRules(join(home, "rules.json"));
test("an asynchronous webhook translator is awaited before the success response", async () => {
  const response = await handler.handle(new Request("http://localhost/v1/in/sample", { method: "POST", body: "ok" }));
  assert.equal(response.status, 200);
  const result = (await response.json()) as any;
  assert.equal(result.events.length, 1);
  const bad = await handler.handle(new Request("http://localhost/v1/in/sample", { method: "POST", body: "bad" }));
  assert.equal(bad.status, 401);
});
