import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Collector } from './collector.mjs';
import { atomicJson } from './server.mjs';
import { cleanRecord, validateWorkers } from './workers.mjs';

export function createWorker({ spec, dataDir, collector = new Collector(), interval = 60000, now = Date.now }) {
  let record = cleanRecord(null, spec), timer, stopped = false, running = false, lastCycle = null;
  const path = resolve(dataDir, 'worker.json');
  async function initialize() {
    await mkdir(dataDir, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(path, 'utf8'));
      if (saved.workerId === spec.id && saved.provider === spec.provider) {
        record = cleanRecord(saved, spec);
        collector.restore([record]);
      }
    } catch {}
  }
  async function cycle() {
    if (running || stopped) return;
    running = true;
    try {
      record = cleanRecord(await collector.collect(spec.provider), spec);
      await atomicJson(path, record);
      lastCycle = now();
    } catch {
      record = { ...record, error: { code: 'query_failed' }, retained: !!record.usage };
    } finally { running = false; }
  }
  async function start() {
    await cycle();
    if (!stopped) timer = setTimeout(start, interval);
  }
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    let body;
    if (!['GET', 'HEAD'].includes(req.method)) { res.statusCode = 405; body = { error: 'method_not_allowed' }; }
    else if (req.url === '/snapshot') body = { schemaVersion: 1, record };
    else if (req.url === '/healthz') {
      const healthy = lastCycle !== null && now() - lastCycle < interval + 300000;
      res.statusCode = healthy ? 200 : 503;
      body = { status: healthy ? 'ok' : 'unavailable' };
    } else { res.statusCode = 404; body = { error: 'not_found' }; }
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
  });
  return { server, initialize, cycle, start, stop() { stopped = true; clearTimeout(timer); server.close(); } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const spec = validateWorkers([{ id: process.env.WORKER_ID, name: process.env.WORKER_NAME || process.env.WORKER_ID,
    provider: process.env.PROVIDER, url: 'http://localhost:8080' }])[0];
  const seconds = (key, fallback, min) => {
    const value = Number(process.env[key] ?? fallback);
    if (!Number.isFinite(value) || value < min) throw Error(`Invalid ${key}`);
    return value * 1000;
  };
  const app = createWorker({ spec, dataDir: resolve(process.env.DATA_DIR || 'data'),
    interval: seconds('POLL_INTERVAL_SECONDS', 60, 10),
    collector: new Collector({ timeout: seconds('CLI_TIMEOUT_SECONDS', 45, 1),
      authInterval: seconds('AUTH_CHECK_INTERVAL_SECONDS', 86400, 300), cwd: process.env.HOME,
      codexbar: process.env.CODEXBAR_BIN || 'codexbar', codex: process.env.CODEX_BIN || 'codex' }) });
  await app.initialize();
  app.server.listen(Number(process.env.PORT || 8080), process.env.HOST || '0.0.0.0');
  void app.start();
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    app.stop(); setTimeout(() => process.exit(0), 5000).unref();
  });
}
