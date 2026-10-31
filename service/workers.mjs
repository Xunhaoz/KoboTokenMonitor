import { sanitize } from './collector.mjs';
import { timestamp } from '../usage-model.mjs';

export function validateWorkers(value) {
  if (!Array.isArray(value)) throw Error('Workers config must be an array');
  const ids = new Set();
  return value.map(w => {
    if (!w || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(w.id) || ids.has(w.id))
      throw Error('Worker IDs must be unique safe identifiers');
    if (!['codex', 'claude'].includes(w.provider)) throw Error('Invalid worker provider');
    const url = new URL(w.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw Error('Invalid worker URL');
    if (typeof w.name !== 'string' || !w.name.trim() || w.name.length > 40) throw Error('Worker name must be 1–40 characters');
    ids.add(w.id);
    return { id: w.id, name: w.name.trim(), provider: w.provider, url: url.origin };
  });
}
const errors = new Set(['authentication_required', 'rate_limited', 'timeout', 'query_failed', 'worker_unavailable']);
export function cleanRecord(record, spec) {
  const clean = sanitize(record, spec.provider) || { provider: spec.provider };
  // Account plan/identity labels are not required by the worker protocol.
  if (clean.usage) delete clean.usage.loginMethod;
  const collection = {};
  for (const key of ['lastAttemptAt', 'lastSuccessAt', 'lastAuthCheckAt', 'nextAttemptAt'])
    collection[key] = timestamp(record?.collection?.[key]) === null ? null : new Date(record.collection[key]).toISOString();
  collection.authCheckSucceeded = typeof record?.collection?.authCheckSucceeded === 'boolean' ? record.collection.authCheckSucceeded : null;
  return { ...clean, workerId: spec.id, name: spec.name, collection,
    ...(record?.error ? { error: { code: errors.has(record.error.code) ? record.error.code : 'query_failed' } } : {}),
    retained: record?.retained === true };
}

export class RemoteCollector {
  constructor(workers, { timeout = 5000, fetcher = fetch } = {}) {
    this.workers = workers;
    this.timeout = timeout;
    this.fetcher = fetcher;
    this.cache = new Map();
  }
  restore(records) {
    for (const spec of this.workers) {
      const record = records.find(r => r?.workerId === spec.id && r.provider === spec.provider);
      if (record) this.cache.set(spec.id, cleanRecord(record, spec));
    }
  }
  async collect(id) {
    const spec = this.workers.find(w => w.id === id);
    try {
      const response = await this.fetcher(`${spec.url}/snapshot`, { signal: AbortSignal.timeout(this.timeout), redirect: 'error' });
      if (!response.ok) throw Error('Worker unavailable');
      const data = await response.json();
      if (data.schemaVersion !== 1 || data.record?.workerId !== id || data.record?.provider !== spec.provider)
        throw Error('Worker identity mismatch');
      const record = cleanRecord(data.record, spec);
      this.cache.set(id, record);
      return record;
    } catch {
      const previous = this.cache.get(id);
      return { ...(previous || cleanRecord(null, spec)), error: { code: 'worker_unavailable' }, retained: !!previous?.usage };
    }
  }
}
