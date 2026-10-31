export type UsageState =
  | "ok"
  | "missing"
  | "error"
  | "authentication_required"
  | "stale"
  | "partial"
  | "quota_reached";
export type CollectionState =
  | "ok"
  | "unknown"
  | "authentication_required"
  | "rate_limited"
  | "timeout"
  | "query_failed"
  | "worker_unavailable";
export interface UsageWindow {
  usedPercent: number | null;
  resetsAt: string | null;
  windowMinutes: number | null;
}
export interface Provider {
  id: string;
  provider: "codex" | "claude";
  name: string;
  usage: {
    state: UsageState;
    caption: string;
    measuredAt: string | null;
    retained: boolean;
    quotaReached: boolean;
    primary: UsageWindow;
    secondary: UsageWindow;
  };
  collection: {
    status: CollectionState;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    lastAuthCheckAt: string | null;
    authCheckSucceeded: boolean | null;
    nextAttemptAt: string | null;
  };
}
export interface Dashboard {
  schemaVersion: 1;
  revision: number;
  serverTime: string;
  pollIntervalSeconds: number;
  service: {
    status: "ok" | "unavailable";
    startedAt: string | null;
    lastCycleAt: string | null;
    lastImageAt: string | null;
    collecting: boolean;
    renderError: string | null;
  };
  providers: Provider[];
}

export async function fetchDashboard(signal: AbortSignal): Promise<Dashboard> {
  const response = await fetch("/api/dashboard", { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`讀取失敗（HTTP ${response.status}）`);
  const data = await response.json();
  if (
    data?.schemaVersion !== 1 ||
    !Array.isArray(data.providers) ||
    !data.service ||
    !Number.isFinite(Date.parse(data.serverTime))
  ) {
    throw new Error("無法辨識伺服器資料，請重新整理頁面。");
  }
  return data;
}
