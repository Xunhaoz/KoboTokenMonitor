import { normalizeProvider, timestamp, accountName, displayName } from "../usage-model.mjs";

const errors = new Set([
  "authentication_required",
  "rate_limited",
  "timeout",
  "query_failed",
  "worker_unavailable",
]);
const date = (value) =>
  timestamp(value) === null ? null : new Date(value).toISOString();

// This public representation deliberately excludes raw CLI output and full email addresses.
export function dashboardModel(
  records,
  health,
  { now = Date.now(), revision = 0, interval = 60000, healthy = false, workers = null } = {},
) {
  return {
    schemaVersion: 1,
    revision,
    serverTime: new Date(now).toISOString(),
    pollIntervalSeconds: interval / 1000,
    service: {
      status: healthy ? "ok" : "unavailable",
      startedAt: date(health.startedAt),
      lastCycleAt: date(health.lastCycleAt),
      lastImageAt: date(health.lastImageAt),
      collecting: health.running === true,
      renderError: health.renderError ? "update_failed" : null,
    },
    providers: (workers || (records.some(r => r?.workerId) ? records.map(r => ({ id: r.workerId, provider: r.provider, name: r.name })) : ["codex", "claude"].map(id => ({ id, provider: id })))).map((spec) => {
      const id = spec.provider;
      const record = records.find((record) => record?.workerId ? record.workerId === spec.id : record?.provider === spec.id) || {};
      const error = record.error
        ? errors.has(record.error.code)
          ? record.error.code
          : "query_failed"
        : null;
      const model = normalizeProvider(
        [
          {
            ...record,
            provider: id,
            ...(error ? { error: { code: error } } : {}),
          },
        ],
        id,
        new Date(now),
      );
      const collection = record.collection || {};
      const window = (key, usedPercent, reset) => ({
        usedPercent,
        resetsAt: date(reset),
        windowMinutes:
          Number.isFinite(record.usage?.[key]?.windowMinutes) &&
          record.usage[key].windowMinutes > 0
            ? record.usage[key].windowMinutes
            : null,
      });
      return {
        id: spec.id,
        provider: id,
        account: accountName(record),
        name: displayName(record, spec.name || (id === "codex" ? "Codex" : "Claude")),
        usage: {
          state: model.state,
          caption: model.caption,
          measuredAt:
            model.updatedAt === null
              ? null
              : new Date(model.updatedAt).toISOString(),
          retained: record.retained === true,
          quotaReached: model.quotaReached,
          primary: window("primary", model.primary, model.resetPrimary),
          secondary: window("secondary", model.secondary, model.resetSecondary),
        },
        collection: {
          status: error || (date(collection.lastSuccessAt) ? "ok" : "unknown"),
          lastAttemptAt: date(collection.lastAttemptAt),
          lastSuccessAt: date(collection.lastSuccessAt),
          nextAttemptAt: date(collection.nextAttemptAt),
        },
      };
    }),
  };
}
