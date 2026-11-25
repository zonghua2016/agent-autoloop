// A separate data directory must not break Feishu's read-only work-item view.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

test("loads the work-item reader using a config file outside the repository", { timeout: 10000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "autoloop-dashboard-"));
  const hub = createServer((req, res) => {
    assert.equal(req.url, "/v1/state");
    assert.equal(req.headers.authorization, "Bearer example-owner-key");
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"seq":17,"runs":[]}');
  });
  let child, exit;
  t.after(async () => {
    if (child?.exitCode === null) child.kill();
    if (exit) await exit;
    hub.closeAllConnections();
    await new Promise((resolve) => hub.close(resolve));
    await rm(home, { recursive: true, force: true });
  });
  const hubPort = await listen(hub);
  const spare = createServer();
  const port = await listen(spare);
  await new Promise((resolve) => spare.close(resolve));
  const config = join(home, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      url: `http://127.0.0.1:${hubPort}`,
      owner: "example-owner-key",
      channels: { feishu: { tasks: { personal: { owner: "ou_example" }, senders: ["ou_example"] } } },
    }),
    { mode: 0o600 },
  );
  child = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url)), config, String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  exit = new Promise((resolve) => child.once("close", resolve));
  await Promise.race([
    once(child.stdout, "data", { signal: AbortSignal.timeout(4000) }),
    exit.then(() => {
      throw new Error("看板在监听前退出");
    }),
  ]);
  const url = `http://127.0.0.1:${port}`;
  assert.match(await (await fetch(url)).text(), /任务管理看板/);
  const login = await fetch(url + "/api/login", {
    method: "POST",
    headers: { Origin: url },
    body: JSON.stringify({ key: "example-owner-key" }),
  });
  const items = await (
    await fetch(url + "/api/work-items", { headers: { Cookie: login.headers.get("set-cookie").split(";", 1)[0] } })
  ).json();
  assert.deepEqual(items, { available: true, hubReachable: true, items: [] });
});
