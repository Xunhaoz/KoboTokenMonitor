import { createServer } from "node:http";
import { readFile, writeFile, rename, mkdir, realpath } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Collector } from "./collector.mjs";
import { RemoteCollector, validateWorkers } from "./workers.mjs";
import { run } from "./process.mjs";
import { dashboardModel } from "./dashboard-model.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export async function atomicJson(path, value) {
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await rename(tmp, path);
}
export function createApp({
  dataDir,
  staticDir = resolve(root, "frontend/dist"),
  interval = 60000,
  timeout = 45000,
  collector = new Collector({ timeout }),
  workers = null,
  execute = run,
  now = Date.now,
}) {
  let running = false,
    timer,
    stopped = false;
  let records = workers ? workers.map(w => ({ workerId: w.id, name: w.name, provider: w.provider })) : [];
  let revision = 0,
    imageRevision = -1,
    imageMinute = null,
    rendering = null;
  const health = {
    startedAt: new Date(now()).toISOString(),
    lastCycleAt: null,
    lastImageAt: null,
    running: false,
    providers: {},
  };
  const image = resolve(dataDir, "usage.png"),
    input = resolve(dataDir, "usage.json");
  async function initialize() {
    await mkdir(dataDir, { recursive: true });
    try {
      const data = JSON.parse(await readFile(input, "utf8"));
      if (Array.isArray(data)) {
        collector.restore(data);
        records = workers ? workers.map(w => ({ ...(data.find(r => r?.workerId === w.id && r.provider === w.provider) || {}), workerId: w.id, name: w.name, provider: w.provider })) : data;
      }
    } catch {}
  }
  async function ensureImage() {
    // Share one renderer across downloads and collection cycles. If data changes
    // during a render, render again before declaring the cache current.
    while (
      imageRevision !== revision ||
      imageMinute !== Math.floor(now() / 60000)
    ) {
      if (!rendering) {
        const targetRevision = revision,
          at = now(),
          minute = Math.floor(at / 60000);
        rendering = (async () => {
          const rendered = await execute(
            process.execPath,
            [
              resolve(root, "render-dashboard.mjs"),
              "--input",
              input,
              "--at",
              new Date(at).toISOString(),
              "--output",
              image,
            ],
            { timeout: 30000, cwd: root },
          );
          if (rendered.code !== 0 || rendered.reason)
            throw Error("render_failed");
          imageRevision = targetRevision;
          imageMinute = minute;
          health.lastImageAt = new Date(now()).toISOString();
          health.renderError = null;
        })()
          .catch((error) => {
            health.renderError = "update_failed";
            throw error;
          })
          .finally(() => {
            rendering = null;
          });
      }
      await rendering;
    }
  }
  async function cycle() {
    if (running || stopped) return;
    running = true;
    health.running = true;
    try {
      const nextRecords = await Promise.all(
        (workers ? workers.map(w => w.id) : ["codex", "claude"]).map(async (id) => {
          try {
            return await collector.collect(id);
          } catch {
            const spec = workers?.find(w => w.id === id);
            return { provider: spec?.provider || id, ...(spec ? { workerId: id, name: spec.name } : {}), error: { code: "query_failed" } };
          }
        }),
      );
      await atomicJson(input, nextRecords);
      records = nextRecords;
      revision++;
      health.providers = Object.fromEntries(
        records.map((r) => [
          r.workerId || r.provider,
          {
            status:
              r.error?.code ||
              (r.usage?.updatedAt &&
              now() - Date.parse(r.usage.updatedAt) <= 600000
                ? "ok"
                : "stale"),
            measuredAt: r.usage?.updatedAt || null,
            ...r.collection,
          },
        ]),
      );
      await ensureImage();
    } catch {
      health.renderError = "update_failed";
    } finally {
      health.lastCycleAt = new Date(now()).toISOString();
      running = false;
      health.running = false;
      console.log(
        JSON.stringify({
          event: "cycle",
          at: health.lastCycleAt,
          renderError: health.renderError || null,
          providers: health.providers,
        }),
      );
    }
  }
  async function loop() {
    const started = Date.now();
    await cycle();
    if (!stopped)
      timer = setTimeout(
        loop,
        Math.max(1000, interval - (Date.now() - started)),
      );
  }
  function healthy() {
    return (
      !!health.lastImageAt &&
      !health.renderError &&
      now() - Date.parse(health.lastCycleAt) < interval + timeout * 5 + 60000
    );
  }
  function dashboard() {
    return dashboardModel(records, health, {
      now: now(),
      revision,
      interval,
      healthy: healthy(),
      workers,
    });
  }
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    const path = req.url?.split("?")[0];
    const json = (status, value) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify(value));
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      json(405, { error: "method_not_allowed" });
      return;
    }
    if (path === "/healthz") {
      res.writeHead(healthy() ? 200 : 503, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ status: healthy() ? "ok" : "unavailable" }));
      return;
    }
    if (path === "/api/dashboard") {
      json(200, dashboard());
      return;
    }
    if (path === "/status") {
      const publicData = dashboard();
      json(200, {
        ...publicData.service,
        running: health.running,
        providers: Object.fromEntries(
          publicData.providers.map((p) => [
            p.id,
            {
              ...p.collection,
              status: p.collection.status,
              measuredAt: p.usage.measuredAt,
            },
          ]),
        ),
      });
      return;
    }
    if (path === "/usage.png") {
      // Failed rendering leaves the previous atomically written PNG available.
      try {
        await ensureImage();
      } catch {}
      try {
        const bytes = await readFile(image);
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": bytes.length,
        });
        res.end(req.method === "HEAD" ? undefined : bytes);
      } catch {
        res.writeHead(503);
        res.end("Image not ready");
      }
      return;
    }
    // Only known SPA routes and Vite's flat generated assets can be served.
    // No fallback for API paths, arbitrary files, auth volumes, or source code.
    const page = ["/", "/usage", "/cli", "/overview"].includes(path);
    const asset = /^\/assets\/[a-zA-Z0-9_-]+\.(js|css|woff2|svg)$/.test(
      path || "",
    );
    if (page || asset) {
      try {
        const base = await realpath(staticDir);
        const file = await realpath(
          resolve(base, page ? "index.html" : path.slice(1)),
        );
        if (!file.startsWith(base + "/")) throw Error("invalid_path");
        const bytes = await readFile(file);
        const ext = file.split(".").at(-1);
        const types = {
          html: "text/html; charset=utf-8",
          js: "text/javascript; charset=utf-8",
          css: "text/css; charset=utf-8",
          svg: "image/svg+xml",
          woff2: "font/woff2",
        };
        res.writeHead(200, {
          "Content-Type": types[ext],
          "Content-Length": bytes.length,
          "Cache-Control": page
            ? "no-cache"
            : "public, max-age=31536000, immutable",
        });
        res.end(req.method === "HEAD" ? undefined : bytes);
        return;
      } catch {
        if (page) {
          res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(
            req.method === "HEAD"
              ? undefined
              : "Frontend not built. Run npm run build.",
          );
          return;
        }
      }
    }
    json(404, { error: "not_found" });
  });
  return {
    server,
    health,
    initialize,
    cycle,
    start: loop,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      server.close();
    },
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const number = (key, fallback, min) => {
    const value = Number(process.env[key] ?? fallback);
    if (!Number.isFinite(value) || value < min) throw Error(`Invalid ${key}`);
    return value;
  };
  const interval = number("POLL_INTERVAL_SECONDS", 60, 10) * 1000;
  const timeout = number("CLI_TIMEOUT_SECONDS", 45, 1) * 1000;
  const dataDir = resolve(process.env.DATA_DIR || "data");
  const workers = validateWorkers(JSON.parse(await readFile(resolve(process.env.WORKERS_CONFIG || "workers.json"), "utf8")));
  const collector = new RemoteCollector(workers, { timeout: number("WORKER_TIMEOUT_SECONDS", 5, 1) * 1000 });
  const app = createApp({ dataDir, interval, timeout, collector, workers });
  await app.initialize();
  app.server.listen(
    number("PORT", 8080, 0),
    process.env.HOST || "0.0.0.0",
    () => console.log(JSON.stringify({ event: "listening" })),
  );
  void app.start();
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      app.stop();
      setTimeout(() => process.exit(0), 5000).unref();
    });
}
