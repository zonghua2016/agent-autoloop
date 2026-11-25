import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, dirname, extname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { publicSnapshot, publicCard, publicChange, projectTimeline } from "./timeline.mjs";

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), "public");
const number = (text) =>
  /^(0|[1-9]\d*)$/.test(text ?? "") && Number.isSafeInteger(Number(text)) ? Number(text) : null;
const send = (res, status, value) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
};
const failure = (status, message) => Object.assign(new Error(message), { status });
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

export async function startDashboard(
  config,
  { port = 5419, readonly = false, configPath = resolve("config.json") } = {},
) {
  const upstream = new URL(config.url);
  if (
    !["http:", "https:"].includes(upstream.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(upstream.hostname) ||
    upstream.username ||
    upstream.password ||
    !config.owner
  )
    throw Error("请配置本机中台地址和本人密钥");
  const csrf = randomBytes(32).toString("hex"),
    clients = new Set(),
    abort = new AbortController();
  let generation = 0;
  let origin,
    host,
    cache,
    rawCache,
    refreshing,
    lastRead = 0,
    streaming,
    reconnectTimer,
    pulse;
  const html = await readFile(resolve(publicDir, "index.html"), "utf8");
  const importmap = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
  const policy = `default-src 'self'; script-src 'self' 'sha256-${createHash("sha256").update(importmap).digest("base64")}'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://api.open-meteo.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`;
  const scopes = Object.entries(config.channels ?? {}).flatMap(([id, channel]) => {
    const tasks = channel.tasks,
      senderId = tasks?.personal?.owner;
    return senderId && tasks.senders?.includes(senderId)
      ? [
          {
            id,
            database: tasks.database ? resolve(tasks.database) : resolve(dirname(configPath), "feishu-tasks.db"),
            scope: { senderId, privateOnly: true },
            source: tasks.delivery?.source ?? "feishu-chat",
          },
        ]
      : [];
  });
  const sessions = new Map();
  let cookieName;
  const streamSessions = new Map();
  function sessionOf(req) {
    const token = (req.headers.cookie ?? "")
      .split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1);
    if (token && (sessions.get(token) ?? 0) > Date.now()) return token;
    if (token) sessions.delete(token);
  }
  function revoke(token) {
    sessions.delete(token);
    for (const [client, current] of streamSessions) if (current === token) client.destroy();
  }
  const workCache = new Map();
  async function hub(path, body, signal) {
    const response = await fetch(new URL(path, upstream), {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: {
        Authorization: "Bearer " + config.owner,
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: signal ?? AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw failure(
        response.status,
        response.status < 500 && typeof detail?.error === "string"
          ? detail.error.slice(0, 2000)
          : "中台拒绝请求（" + response.status + "），请刷新状态后检查输入",
      );
    }
    return response;
  }
  function broadcast(event, data, id) {
    const message =
      (id == null ? "" : "id: " + id + "\n") + "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";
    for (const client of clients)
      if (
        (sessions.get(streamSessions.get(client)) ?? 0) <= Date.now() ||
        client.writableLength > 65536 ||
        !client.write(message)
      ) {
        clients.delete(client);
        client.destroy();
      }
  }
  async function refresh(force = false) {
    if (refreshing) {
      await refreshing;
      return refresh();
    }
    if (!force && cache && Date.now() - lastRead < 1000) return cache;
    refreshing = (async () => {
      const startedGeneration = generation;
      rawCache = await (await hub("/v1/state")).json();
      cache = publicSnapshot(rawCache);
      lastRead = startedGeneration === generation ? Date.now() : 0;
      return cache;
    })();
    try {
      return await refreshing;
    } finally {
      refreshing = null;
    }
  }
  function startStream() {
    if (streaming || abort.signal.aborted) return;
    streaming = (async () => {
      const state = await refresh(true);
      broadcast("reset", { seq: state.seq });
      const response = await hub("/v1/stream?after=" + state.seq, undefined, abort.signal);
      let pending = "",
        seq = null,
        body = [];
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        if (pending.length > 4 * 1024 * 1024) throw Error("日志帧过大");
        const lines = pending.split("\n");
        pending = lines.pop();
        for (const raw of lines) {
          const line = raw.replace(/\r$/, "");
          if (line.startsWith("id:")) seq = number(line.slice(3).trim());
          else if (line.startsWith("data:")) body.push(line.slice(5).trimStart());
          else if (line === "") {
            if (seq !== null && body.length) {
              broadcast("change", publicChange(seq, JSON.parse(body.join("\n"))), seq);
              generation++;
              lastRead = 0;
            }
            seq = null;
            body = [];
          }
        }
      }
    })()
      .catch(() => {
        if (!abort.signal.aborted) broadcast("offline", {});
      })
      .finally(() => {
        streaming = null;
        if (!abort.signal.aborted) {
          reconnectTimer = setTimeout(startStream, 1500);
          reconnectTimer.unref();
        }
      });
  }
  const why = async (id) => projectTimeline(id, await (await hub("/v1/runs/" + id + "/why")).json());
  async function bodyOf(req) {
    let text = "";
    for await (const part of req) {
      text += part;
      if (Buffer.byteLength(text) > 16384) throw failure(413, "请求过大");
    }
    let body;
    try {
      body = JSON.parse(text || "{}");
    } catch {
      throw failure(400, "需要 JSON 对象");
    }
    if (!body || Array.isArray(body) || typeof body !== "object") throw failure(400, "需要 JSON 对象");
    return body;
  }
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", policy);
    try {
      if (req.headers.host !== host || !req.url?.startsWith("/") || req.url.startsWith("//"))
        throw failure(403, "仅允许本机访问");
      const url = new URL(req.url, origin),
        path = decodeURIComponent(url.pathname);
      if (path.startsWith("/api/")) {
        if (
          (req.headers.origin && req.headers.origin !== origin) ||
          (req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(req.headers["sec-fetch-site"]))
        )
          throw failure(403, "仅允许同源页面访问");
        const session = sessionOf(req);
        if (path === "/api/login" && req.method === "POST") {
          if (req.headers.origin !== origin) throw failure(403, "仅允许同源页面登录");
          const body = await bodyOf(req);
          const hash = (value) => createHash("sha256").update(value).digest();
          if (typeof body.key !== "string" || !timingSafeEqual(hash(body.key), hash(config.owner)))
            throw failure(401, "本人密钥不正确");
          for (const [token, expires] of sessions) if (expires <= Date.now()) sessions.delete(token);
          if (session) revoke(session);
          if (sessions.size >= 32) revoke(sessions.keys().next().value);
          const token = randomBytes(32).toString("hex");
          sessions.set(token, Date.now() + 12 * 60 * 60 * 1000);
          res.setHeader("Set-Cookie", cookieName + "=" + token + "; Path=/; Max-Age=43200; HttpOnly; SameSite=Strict");
          return send(res, 200, { ok: true });
        }
        if (path === "/api/session" && req.method === "GET")
          return send(
            res,
            200,
            session ? { authenticated: true, writable: !readonly, csrf } : { authenticated: false, writable: false },
          );
        if (!session) throw failure(401, "请先登录本机管理看板");
        if (path === "/api/logout" && req.method === "POST") {
          if (req.headers.origin !== origin || req.headers["x-autoloop-csrf"] !== csrf)
            throw failure(403, "管理令牌无效");
          revoke(session);
          res.setHeader("Set-Cookie", cookieName + "=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict");
          return send(res, 200, { ok: true });
        }
        if (req.method === "POST") {
          if (readonly) throw failure(403, "当前以只读模式启动");
          if (req.headers.origin !== origin || req.headers["x-autoloop-csrf"] !== csrf)
            throw failure(403, "管理令牌无效，请刷新页面");
          const match =
            /^\/api\/(cards\/[1-9]\d*\/(answer|resolve)|runs\/[1-9]\d*\/cancel|rules\/[^/]+\/(pause|resume|run|replay))$/.exec(
              path,
            );
          const draft = /^\/api\/work-items\/([\w-]+)\/cancel$/.exec(path);
          if (!match && !draft) throw failure(404, "没有此管理操作");
          const body = await bodyOf(req);
          if (draft) {
            const scope = scopes.find((scope) => scope.id === body.channel);
            if (!scope) throw failure(403, "没有获准的本人事项范围");
            const { cancelDraft } = await import("../../../plugins/feishu-tasks/work-items.ts");
            const result = cancelDraft(scope.database, scope.scope, draft[1]);
            workCache.clear();
            return send(res, 200, result);
          }
          const target = "/v1/" + match[1].split("/").map(encodeURIComponent).join("/");
          let result;
          try {
            result = await (await hub(target, body)).json();
          } catch (error) {
            if (!error.status) throw failure(502, "提交结果未知，请刷新状态核对，勿重复提交");
            throw error;
          }
          generation++;
          lastRead = 0;
          return send(res, 200, result);
        }
        if (req.method !== "GET") throw failure(405, "不支持此请求方法");
        if (path === "/api/state") {
          const raw = url.searchParams.get("before"),
            before = number(raw);
          if (raw !== null && (!before || before < 1)) throw failure(400, "轮次编号无效");
          return send(
            res,
            200,
            before ? publicSnapshot(await (await hub("/v1/state?before=" + before)).json()) : await refresh(),
          );
        }
        if (path === "/api/work-items") {
          if (!scopes.length) return send(res, 200, { available: false, items: [] });
          const hubReachable = await refresh().then(
            () => true,
            () => false,
          );
          const { readWorkItems } = await import("../../../plugins/feishu-tasks/work-items.ts");
          const views = await Promise.all(
            scopes.map(async (scope) => {
              const stamps = await Promise.all(
                [scope.database, scope.database + "-wal"].map((file) =>
                  stat(file)
                    .then((s) => [s.mtimeMs, s.size])
                    .catch(() => null),
                ),
              );
              const stamp = JSON.stringify([stamps, cache?.seq, hubReachable]),
                old = workCache.get(scope.id);
              const view =
                old?.stamp === stamp
                  ? old.view
                  : readWorkItems(scope.database, scope.scope, {
                      source: scope.source,
                      runs: hubReachable ? rawCache?.runs : undefined,
                    });
              workCache.set(scope.id, { stamp, view });
              return { ...view, items: view.items.map((item) => ({ ...item, channel: scope.id })) };
            }),
          );
          return send(res, 200, {
            available: true,
            hubReachable,
            items: views.flatMap((view) => view.items),
            intake: views.find((view) => view.intake)?.intake,
          });
        }
        if (path === "/api/changes") {
          if (number(url.searchParams.get("after")) === null) throw failure(400, "需要快照日志序号");
          res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
          res.write(": connected\n\n");
          clients.add(res);
          streamSessions.set(res, session);
          res.once("close", () => {
            clients.delete(res);
            streamSessions.delete(res);
          });
          res.write("event: reset\ndata: {}\n\n");
          startStream();
          return;
        }
        const run = number(/^\/api\/runs\/([1-9]\d*)$/.exec(path)?.[1]);
        if (run) return send(res, 200, await why(run));
        const id = number(/^\/api\/cards\/([1-9]\d*)$/.exec(path)?.[1]);
        if (id) {
          await refresh();
          const card = [...(rawCache.cards ?? []), ...(rawCache.recentCards ?? [])].find((card) => card.id === id);
          if (!card) throw failure(404, "卡片已离开当前记录");
          return send(res, 200, {
            card: publicCard(card),
            runId: card.runId ?? null,
            rows: card.runId ? (await why(card.runId)).rows : [],
          });
        }
        throw failure(404, "没有此接口");
      }
      if (req.method !== "GET") throw failure(405, "不支持此请求方法");
      const file = resolve(publicDir, "." + (path === "/" ? (sessionOf(req) ? "/index.html" : "/login.html") : path)),
        type = mime[extname(file)];
      if (!file.startsWith(publicDir + sep) || !type) throw failure(404, "页面不存在");
      const content = await readFile(file),
        etag = '"' + createHash("sha256").update(content).digest("hex") + '"';
      res.setHeader("ETag", etag);
      res.setHeader("Cache-Control", path === "/" ? "no-store" : "public, max-age=300, must-revalidate");
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": type });
      res.end(content);
    } catch (error) {
      if (res.headersSent) return res.end();
      send(res, error.status ?? (error.code === "ENOENT" ? 404 : 502), {
        error: error.status ? error.message : "暂时无法读取本机中台",
      });
    }
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  host = "127.0.0.1:" + server.address().port;
  origin = "http://" + host;
  cookieName = "autoloop_session_" + server.address().port;
  pulse = setInterval(() => {
    for (const client of clients)
      if ((sessions.get(streamSessions.get(client)) ?? 0) <= Date.now() || !client.write(": heartbeat\n\n"))
        client.destroy();
  }, 15000);
  pulse.unref();
  return {
    origin,
    async close() {
      abort.abort();
      clearTimeout(reconnectTimer);
      clearInterval(pulse);
      for (const client of clients) client.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await streaming;
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2),
    readonly = args.includes("--readonly"),
    [configPath, portText = "5419"] = args.filter((arg) => arg !== "--readonly");
  const port = Number(portText);
  if (!configPath || !Number.isInteger(port) || port < 1 || port > 65535)
    throw Error("用法：node server.mjs <config.json> [端口] [--readonly]");
  const app = await startDashboard(JSON.parse(await readFile(configPath, "utf8")), {
    port,
    readonly,
    configPath: resolve(configPath),
  });
  console.log("Autoloop 本机管理园区 · " + app.origin + (readonly ? " · 只读" : ""));
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void app.close();
    });
}
