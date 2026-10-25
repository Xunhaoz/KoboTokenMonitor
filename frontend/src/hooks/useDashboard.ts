import { useCallback, useEffect, useRef, useState } from "react";
import { fetchDashboard } from "../api/dashboard";
import type { Dashboard } from "../api/dashboard";

export function useDashboard() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const controller = useRef<AbortController | null>(null);
  const lastRead = useRef(0);
  const interval = useRef(60000);

  const refresh = useCallback(async () => {
    if (controller.current) return;
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    const timeout = window.setTimeout(
      () => request.abort(new Error("讀取逾時，請稍後重試。")),
      15000,
    );
    try {
      const next = await fetchDashboard(request.signal);
      if (request.signal.aborted) return;
      lastRead.current = Date.now();
      interval.current = Math.max(
        10000,
        (next.pollIntervalSeconds || 60) * 1000,
      );
      setData(next);
      setReceivedAt(lastRead.current);
      setError(null);
    } catch (failure) {
      if (
        !request.signal.aborted ||
        request.signal.reason?.message?.includes("逾時")
      ) {
        setError(
          request.signal.aborted
            ? "讀取逾時，請稍後重試。"
            : failure instanceof TypeError
              ? "無法連線至服務"
              : failure instanceof Error
                ? failure.message
                : "無法連線至服務",
        );
      }
    } finally {
      window.clearTimeout(timeout);
      if (controller.current === request) {
        controller.current = null;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    let active = true;
    let timer: number;
    const schedule = () => {
      timer = window.setTimeout(async () => {
        if (!document.hidden) await refresh();
        if (active) schedule();
      }, interval.current);
    };
    void refresh();
    schedule();
    const onVisible = () => {
      if (document.hidden) controller.current?.abort();
      else if (Date.now() - lastRead.current >= interval.current)
        void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      const request = controller.current;
      controller.current = null;
      request?.abort();
    };
  }, [refresh]);

  return { data, error, loading, refresh, receivedAt };
}
