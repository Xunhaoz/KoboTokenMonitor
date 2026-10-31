import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateWorkers, RemoteCollector } from './workers.mjs';
import { createWorker } from './worker.mjs';
import { createApp } from './server.mjs';
import { run } from './process.mjs';

const specs = validateWorkers(['codex-1', 'codex-2', 'claude-1'].map(id => ({ id, name: id, provider: id.split('-')[0], url: 'http://localhost:8080' })));
const sample = (spec, percent) => ({ workerId: spec.id, provider: spec.provider, account: spec.id,
  usage: { identity: { accountEmail: `${spec.id}@example.com` }, updatedAt: new Date().toISOString(), primary: { usedPercent: percent }, secondary: { usedPercent: 40 } },
  collection: { lastSuccessAt: new Date().toISOString() }, token: 'secret', email: 'private@example.com' });
const listen = async server => { await new Promise(r => server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${server.address().port}`; };

test('validate unique identities, providers and worker endpoints', () => {
  assert.throws(() => validateWorkers([specs[0], specs[0]]));
  assert.throws(() => validateWorkers([{ ...specs[0], provider: 'other' }]));
  assert.throws(() => validateWorkers([{ ...specs[0], url: 'file:///etc/passwd' }]));
  assert.deepEqual(validateWorkers([]), []);
});

test('remote failures preserve per-account snapshots across restart, reject swapped identities and strip private fields', async () => {
  let fail = false;
  const collector = new RemoteCollector(specs, { fetcher: async () => {
    if (fail) throw Error('offline');
    return { ok: true, json: async () => ({ schemaVersion: 1, record: sample(specs[0], 0) }) };
  } });
  const good = await collector.collect('codex-1');
  assert.doesNotMatch(JSON.stringify(good), /secret|private@example/);
  assert.equal((await collector.collect('codex-2')).error.code, 'worker_unavailable');
  fail = true;
  const restored = new RemoteCollector(specs, { fetcher: async () => { throw Error('offline'); } });
  restored.restore([good]);
  const stale = await restored.collect('codex-1');
  assert.equal(stale.usage.primary.usedPercent, 0);
  assert.equal(stale.retained, true);
  assert.equal(stale.account,'codex-1');
  assert.equal(stale.error.code, 'worker_unavailable');
});

test('three isolated workers feed master; reads never invoke CLI; offline worker retains only its own data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kobo-workers-'));
  const workers = [];
  let master, calls = [];
  try {
    const live = [];
    for (const [index, spec] of specs.entries()) {
      const worker = createWorker({ spec, dataDir: join(dir, spec.id), collector: {
        restore() {}, async collect(provider) { calls.push([spec.id, provider]); return sample(spec, index * 25); }
      } });
      workers.push(worker);
      await worker.initialize(); await worker.cycle();
      live.push({ ...spec, url: await listen(worker.server) });
    }
    master = createApp({ workers: live, dataDir: join(dir, 'master'), collector: new RemoteCollector(live),
      execute: async (_, args) => { await writeFile(args.at(-1), 'png'); return { code: 0 }; } });
    await master.initialize(); await master.cycle();
    const url = await listen(master.server);
    const data = await (await fetch(url + '/api/dashboard')).json();
    assert.deepEqual(data.providers.map(p => p.account), ['codex-1', 'codex-2', 'claude-1']);
    assert.deepEqual(data.providers.map(p => p.id), ['codex-1', 'codex-2', 'claude-1']);
    assert.deepEqual(data.providers.map(p => p.usage.primary.usedPercent), [0, 25, 50]);
    assert.deepEqual(calls, [['codex-1', 'codex'], ['codex-2', 'codex'], ['claude-1', 'claude']]);
    assert.doesNotMatch(JSON.stringify(data), /secret|private@example/);
    assert.equal((await fetch(live[0].url + '/usage.png')).status, 404);
    workers[1].stop();
    await master.cycle();
    const offline = await (await fetch(url + '/api/dashboard')).json();
    assert.equal(offline.providers[1].collection.status, 'worker_unavailable');
    assert.equal(offline.providers[1].usage.primary.usedPercent, 25);
    assert.equal(offline.providers[0].collection.status, 'ok');
  } finally {
    master?.stop(); workers.forEach(w => w.stop()); await rm(dir, { recursive: true, force: true });
  }
});

test('PNG dimensions remain 1072 × 1448 for zero, one, three and six workers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kobo-render-workers-'));
  try {
    for (const count of [0, 1, 3, 6]) {
      const records = Array.from({ length: count }, (_, i) => ({ ...sample(specs[i % 3], i * 10), workerId: `worker-${i}`, usage: { ...sample(specs[i % 3], i * 10).usage, identity: undefined }, account: `long-account-${i}-with-special-&-chars`, name: `Account ${i}` }));
      const input = join(dir, 'input.json'), output = join(dir, 'usage.png');
      await writeFile(input, JSON.stringify(records));
      const result = await run(process.execPath, ['render-dashboard.mjs', '--input', input, '--output', output], { timeout: 30000 });
      assert.equal(result.code, 0, result.stderr);
      const png = await readFile(output);
      assert.equal(png.readUInt32BE(16), 1072);
      assert.equal(png.readUInt32BE(20), 1448);
      const svg = await readFile(join(dir, 'usage.svg'), 'utf8');
      for (let i = 0; i < count; i++) assert.ok(svg.includes(`${records[i].provider === 'codex' ? 'Codex' : 'Claude'} - long-account-${i}-with-special-&amp;-chars`));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
