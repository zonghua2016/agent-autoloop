// Failure modes: management is accidentally readonly; cross-origin writes reach the owner API;
// tabs multiply upstream streams; card lookup guesses a run from timestamps; transient secrets leak.
// Failed upstream refreshes must not look online; writes must invalidate in-flight snapshots and retain validation errors.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
const modulePath = "../examples/recipes/live-dashboard/server.mjs";
const { startDashboard } = await import(modulePath);

async function client(app: any) {
  const login = await fetch(app.origin + "/api/login", {
    method: "POST",
    headers: { Origin: app.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ key: "secret" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";", 1)[0];
  return (url: string, init: RequestInit = {}) => fetch(url, { ...init, headers: { Cookie: cookie, ...init.headers } });
}

test("work items report an upstream outage after a successful snapshot", async () => {
  let online = true;
  const hub = createServer((_req, res) => {
    res.writeHead(online ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify(online ? { seq: 1, runs: [] } : { error: "offline" }));
  }).listen(0, "127.0.0.1");
  await once(hub, "listening");
  const app = await startDashboard(
    {
      url: `http://127.0.0.1:${(hub.address() as any).port}`,
      owner: "secret",
      channels: {
        feishu: { tasks: { database: "/missing/review-tasks.db", personal: { owner: "owner" }, senders: ["owner"] } },
      },
    },
    { port: 0 },
  );
  try {
    const request = await client(app);
    assert.equal(((await (await request(app.origin + "/api/work-items")).json()) as any).hubReachable, true);
    online = false;
    await new Promise((resolve) => setTimeout(resolve, 1050));
    assert.equal(((await (await request(app.origin + "/api/work-items")).json()) as any).hubReachable, false);
  } finally {
    await app.close();
    hub.closeAllConnections();
    await new Promise<void>((resolve) => hub.close(() => resolve()));
  }
});

test("management retains actionable upstream validation errors", async () => {
  const hub = createServer((_req, res) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "subject 只能用字母、数字和 # . _ : / @ -" }));
  }).listen(0, "127.0.0.1");
  await once(hub, "listening");
  const app = await startDashboard(
    { url: `http://127.0.0.1:${(hub.address() as any).port}`, owner: "secret" },
    { port: 0 },
  );
  try {
    const request = await client(app);
    const session = (await (await request(app.origin + "/api/session")).json()) as any;
    const response = await request(app.origin + "/api/rules/demo/run", {
      method: "POST",
      headers: { Origin: app.origin, "X-Autoloop-CSRF": session.csrf },
      body: JSON.stringify({ subject: "中文" }),
    });
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as any).error, /subject 只能用字母/);
  } finally {
    await app.close();
    hub.closeAllConnections();
    await new Promise<void>((resolve) => hub.close(() => resolve()));
  }
});

test("a read after a write does not join the snapshot captured before the write", async () => {
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  let seq = 1,
    reads = 0;
  const hub = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST") {
      seq++;
      res.end('{"changed":true}');
      return;
    }
    const captured = seq;
    if (++reads === 1) {
      entered();
      await gate;
    }
    res.end(JSON.stringify({ seq: captured, runs: [] }));
  }).listen(0, "127.0.0.1");
  await once(hub, "listening");
  const app = await startDashboard(
    { url: `http://127.0.0.1:${(hub.address() as any).port}`, owner: "secret" },
    { port: 0 },
  );
  try {
    const request = await client(app);
    const session = (await (await request(app.origin + "/api/session")).json()) as any;
    const first = request(app.origin + "/api/state");
    await waiting;
    await request(app.origin + "/api/runs/1/cancel", {
      method: "POST",
      headers: { Origin: app.origin, "X-Autoloop-CSRF": session.csrf },
      body: "{}",
    });
    const after = request(app.origin + "/api/state");
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    await first;
    assert.equal(((await (await after).json()) as any).seq, 2);
  } finally {
    release();
    await app.close();
    hub.closeAllConnections();
    await new Promise<void>((resolve) => hub.close(() => resolve()));
  }
});

test("an idle coding station never borrows the last thinking-station mascot", async () => {
  const path = "../examples/recipes/live-dashboard/public/roles.js";
  const { agentRole } = await import(path);
  const role = agentRole(
    undefined,
    [
      {
        station: "result",
        workStation: "think",
        scheduled: false,
        brand: "deepseek",
        agent: "DeepSeek",
        run: { claimedAt: "2026-11-23T00:00:00Z" },
      },
    ],
    false,
  );
  assert.equal(role.brand, null);
});
test("dashboard defaults to write, gates requests and shares one stream", async () => {
  let streams = 0;
  const writes: string[] = [];
  const hub = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer secret");
    if (req.url?.startsWith("/v1/stream")) {
      streams++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": ready\n\n");
      return;
    }
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST") {
      writes.push(req.url!);
      res.end('{"changed":true}');
      return;
    }
    res.end(JSON.stringify(req.url?.endsWith("/why") ? [] : { seq: 1, cards: [{ id: 4, runId: 7 }], runs: [] }));
  }).listen(0, "127.0.0.1");
  await once(hub, "listening");
  const app = await startDashboard(
    { url: `http://127.0.0.1:${(hub.address() as any).port}`, owner: "secret" },
    { port: 0 },
  );
  try {
    const request = await client(app);
    const session = (await (await request(app.origin + "/api/session")).json()) as any;
    assert.equal(session.writable, true);
    assert.match(session.csrf, /^[a-f0-9]{64}$/);
    const write = (headers: Record<string, string>, path = "/api/runs/7/cancel") =>
      request(app.origin + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: "{}",
      });
    assert.equal((await write({})).status, 403);
    assert.equal((await write({ Origin: "https://evil.test", "X-Autoloop-CSRF": session.csrf })).status, 403);
    assert.equal((await write({ Origin: app.origin, "X-Autoloop-CSRF": session.csrf })).status, 200);
    assert.equal((await write({ Origin: app.origin, "X-Autoloop-CSRF": session.csrf }, "/api/keys")).status, 404);
    assert.deepEqual(writes, ["/v1/runs/7/cancel"]);
    const card = (await (await request(app.origin + "/api/cards/4")).json()) as any;
    assert.equal(card.runId, 7);
    const abort = new AbortController();
    await Promise.all([1, 2].map(() => request(app.origin + "/api/changes?after=1", { signal: abort.signal })));
    for (let i = 0; i < 100 && !streams; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(streams, 1);
    abort.abort();
    const page = await request(app.origin);
    assert.ok(!page.headers.get("Content-Security-Policy")?.split(";")[1].includes("unsafe-inline"));
    assert.equal((await request(app.origin, { headers: { "If-None-Match": page.headers.get("ETag")! } })).status, 304);
  } finally {
    await app.close();
    hub.closeAllConnections();
    await new Promise<void>((resolve) => hub.close(() => resolve()));
  }
});
test("readonly is explicit and cannot write with a valid token", async () => {
  const app = await startDashboard({ url: "http://127.0.0.1:1", owner: "secret" }, { port: 0, readonly: true });
  try {
    const request = await client(app);
    const session = (await (await request(app.origin + "/api/session")).json()) as any;
    assert.equal(session.writable, false);
    assert.equal(
      (
        await request(app.origin + "/api/runs/1/cancel", {
          method: "POST",
          headers: { Origin: app.origin, "X-Autoloop-CSRF": session.csrf },
          body: "{}",
        })
      ).status,
      403,
    );
  } finally {
    await app.close();
  }
});

test("draft cancellation survives stale saves and never cancels a pending dispatch", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { TaskStore } = await import("../plugins/feishu-tasks/inbox.ts");
  const workPath = "../plugins/feishu-tasks/work-items.ts";
  const { cancelDraft } = await import(workPath);
  const dir = mkdtempSync(join(tmpdir(), "dashboard-cancel-")),
    file = join(dir, "tasks.db"),
    store = new TaskStore(file);
  try {
    const task: any = {
      id: "draft1",
      state: "draft",
      refs: [],
      history: [],
      origin: { sender_id: "owner", chat_type: "p2p", chat_id: "oc_one", message_id: "om_one" },
    };
    store.save(task);
    assert.throws(() => cancelDraft(file, { senderId: "other", privateOnly: true }, task.id));
    assert.equal(cancelDraft(file, { senderId: "owner", privateOnly: true }, task.id).changed, true);
    store.save(task);
    assert.equal(store.tasks()[0].state, "cancelled");
    const next = { ...task, id: "draft2", state: "draft", managementCancelled: undefined };
    store.save(next);
    store.receive({ ...next.origin, message_id: "om_dispatch" });
    store.save(undefined, {
      message: { ...next.origin, message_id: "om_dispatch" },
      state: "ready",
      task: next.id,
      dispatch: { id: "dispatch" },
    } as any);
    assert.throws(() => cancelDraft(file, { senderId: "owner", privateOnly: true }, next.id), /派发/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("public changes normalize cards and retain lifecycle facts without credentials", async () => {
  const path = "../examples/recipes/live-dashboard/timeline.mjs";
  const { publicChange, projectTimeline } = await import(path);
  const facts = [
    {
      seq: 1,
      at: "2026-11-23T00:00:00Z",
      changes: [
        {
          table: "runs",
          key: "1",
          row: {
            id: 1,
            state: "done",
            usage: '{"input":12}',
            link: "https://example.com/session",
            emitted: "[9]",
            finished_at: "2026-11-23T00:00:00Z",
            token: "secret",
          },
        },
        {
          table: "cards",
          key: "3",
          row: {
            id: 3,
            kind: "ask",
            state: "open",
            run_id: 1,
            options: '["同意"]',
            created_at: "2026-11-23T00:00:00Z",
            token: "secret",
          },
        },
        { table: "events", key: "9", row: { id: 9, type: "followup", subject: "demo", summary: "继续", routed: "[]" } },
        { table: "timers", key: "4", row: null },
        { table: "pauses", key: "daily", row: { name: "daily", reason: "维护" } },
      ],
    },
  ];
  const change = publicChange(1, facts[0]);
  assert.equal(change.cards[0].runId, 1);
  assert.deepEqual(change.cards[0].options, ["同意"]);
  assert.deepEqual(change.timers, [{ id: "4", removed: true }]);
  assert.equal(change.pauses[0].reason, "维护");
  assert.equal(change.unrouted[0].id, 9);
  assert.ok(!JSON.stringify(change).includes("secret"));
  const titles = projectTimeline(1, facts).rows.map((row: any) => row.title);
  assert.ok(titles.includes("回执发出后续事件"));
  assert.ok(titles.includes("本轮用量"));
  assert.ok(titles.includes("会话链接"));
});

test("local requests cannot obtain owner authority without logging in", async () => {
  let writes = 0;
  const hub = createServer((_req, res) => {
    writes++;
    res.end("{}");
  }).listen(0, "127.0.0.1");
  await once(hub, "listening");
  const app = await startDashboard(
    { url: `http://127.0.0.1:${(hub.address() as any).port}`, owner: "secret" },
    { port: 0 },
  );
  try {
    assert.equal((await fetch(app.origin + "/")).headers.get("cache-control"), "no-store");
    const session = (await (await fetch(app.origin + "/api/session")).json()) as any;
    assert.equal(session.csrf, undefined);
    assert.equal(session.writable, false);
    assert.equal((await fetch(app.origin + "/api/state")).status, 401);
    assert.equal(
      (
        await fetch(app.origin + "/api/cards/1/answer", {
          method: "POST",
          headers: { Origin: app.origin },
          body: '{"choice":0}',
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(app.origin + "/api/login", {
          method: "POST",
          headers: { Origin: app.origin },
          body: '{"key":"wrong"}',
        })
      ).status,
      401,
    );
    const login = await fetch(app.origin + "/api/login", {
      method: "POST",
      headers: { Origin: app.origin },
      body: '{"key":"secret"}',
    });
    assert.match(login.headers.get("set-cookie")!, /HttpOnly.*SameSite=Strict/);
    const request = await client(app);
    const allowed = (await (await request(app.origin + "/api/session")).json()) as any;
    assert.equal(allowed.writable, true);
    assert.ok(allowed.csrf);
    assert.equal(
      (
        await request(app.origin + "/api/logout", {
          method: "POST",
          headers: { Origin: "https://other.test", "X-Autoloop-CSRF": allowed.csrf },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(app.origin + "/api/logout", {
          method: "POST",
          headers: { Origin: app.origin, "X-Autoloop-CSRF": allowed.csrf },
        })
      ).status,
      200,
    );
    assert.equal((await request(app.origin + "/api/state")).status, 401);
    assert.equal(writes, 0);
  } finally {
    await app.close();
    hub.closeAllConnections();
    await new Promise<void>((resolve) => hub.close(() => resolve()));
  }
});

test("owner login replaces old sessions without locking the owner out", async () => {
  const app = await startDashboard({ url: "http://127.0.0.1:1", owner: "secret" }, { port: 0 });
  try {
    const first = await client(app);
    for (let i = 0; i < 32; i++) await client(app);
    assert.equal((await first(app.origin + "/api/state")).status, 401);
  } finally {
    await app.close();
  }
});
