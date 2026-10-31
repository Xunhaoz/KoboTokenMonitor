import type { Provider, UsageWindow } from "../api/dashboard";
import { usageColor } from "../lib/usage-color";
import { Card, CardContent, CardHeader } from "./ui/card";
import { Badge } from "./ui/badge";
import { Progress } from "./ui/progress";

type Tone = "good" | "warn" | "bad" | "neutral";

function StatusBadge({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: Tone;
}) {
  return (
    <Badge variant="outline" className={`status-badge tone-${tone}`}>
      <span className="status-dot" aria-hidden="true" />
      {children}
    </Badge>
  );
}

function dateTime(value: string | null, compact = false, now = Date.now()) {
  if (!value) return "—";
  const date = new Date(value);
  const reference = new Date(now);
  const time = new Intl.DateTimeFormat("zh-TW", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  if (compact) {
    const day = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    const today = Date.UTC(
      reference.getFullYear(),
      reference.getMonth(),
      reference.getDate(),
    );
    const difference = (day - today) / 86400000;
    if (difference === 0) return time;
    if (difference === 1) return `明日${time}`;
    if (difference === -1) return `昨日${time}`;
  }
  return new Intl.DateTimeFormat("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function resetTime(value: string | null, now: number) {
  if (!value) return "重置時間未知";
  const minutes = Math.ceil(Math.max(0, Date.parse(value) - now) / 60000);
  if (!minutes) return "等待重置";
  if (minutes < 60) return `${minutes} 分鐘後重置`;
  if (minutes < 1440) return `${Math.ceil(minutes / 60)} 小時後重置`;
  return `${Math.floor(minutes / 1440)} 天 ${Math.floor((minutes % 1440) / 60)} 小時後重置`;
}

function Quota({
  window,
  label,
  now,
  provider,
  inline = false,
}: {
  window: UsageWindow;
  label: string;
  now: number;
  provider: string;
  inline?: boolean;
}) {
  const windowLabel =
    window.windowMinutes === 10080
      ? "每週用量"
      : window.windowMinutes === 300
        ? "5 小時用量"
        : window.windowMinutes
          ? `${window.windowMinutes >= 60 ? `${Number((window.windowMinutes / 60).toFixed(1))} 小時` : `${window.windowMinutes} 分鐘`}用量`
          : label;
  const value = window.usedPercent;
  const Label = inline ? "h4" : "h3";
  return (
    <div
      className={`quota ${value === 100 ? "quota-full" : ""}`}
      style={{ "--usage-color": usageColor(value) } as React.CSSProperties}
    >
      <div className="quota-heading">
        <Label>{inline ? windowLabel.replace(/用量$/, "") : windowLabel}</Label>
        <div
          className="quota-value"
          aria-label={
            value === null
              ? `${windowLabel}無資料`
              : `${windowLabel}已使用 ${value}%`
          }
        >
          {value === null ? "—" : Number(value.toFixed(1))}
          {value !== null && <span>%</span>}
        </div>
      </div>
      <Progress
        value={value}
        className="quota-progress"
        aria-label={`${provider} ${windowLabel}`}
        aria-valuetext={value === null ? "無資料" : `已使用 ${value}%`}
      />
      <div
        className="quota-reset"
        title={
          window.resetsAt
            ? new Date(window.resetsAt).toLocaleString()
            : undefined
        }
      >
        {resetTime(window.resetsAt, now)}
      </div>
    </div>
  );
}

const collectionLabels = {
  ok: "正常",
  unknown: "未查詢",
  authentication_required: "需登入",
  rate_limited: "限流",
  timeout: "逾時",
  query_failed: "查詢失敗",
  worker_unavailable: "Worker 離線",
};
function CliDetails({
  provider,
  compact,
  now,
}: {
  provider: Provider;
  compact: boolean;
  now: number;
}) {
  const state = provider.collection;
  const tone =
    state.status === "ok"
      ? "good"
      : state.status === "unknown"
        ? "neutral"
        : state.status === "authentication_required"
          ? "bad"
          : "warn";
  return (
    <dl
      className={compact ? "cli-summary" : "cli-details"}
      aria-label={`${provider.name} CLI 狀態`}
    >
      {compact && (
        <div>
          <dt>查詢結果</dt>
          <dd>
            <StatusBadge tone={tone}>
              {collectionLabels[state.status]}
            </StatusBadge>
          </dd>
        </div>
      )}
      <>
        <div>
          <dt>最近成功</dt>
          <dd>
            <time
              dateTime={state.lastSuccessAt || undefined}
              title={
                state.lastSuccessAt
                  ? new Date(state.lastSuccessAt).toLocaleString()
                  : undefined
              }
              aria-label={
                state.lastSuccessAt ? dateTime(state.lastSuccessAt) : "尚無紀錄"
              }
            >
              {dateTime(state.lastSuccessAt, compact, now)}
            </time>
          </dd>
        </div>
        <div>
          <dt>下次重試</dt>
          <dd>
            <time
              dateTime={state.nextAttemptAt || undefined}
              title={
                state.nextAttemptAt
                  ? new Date(state.nextAttemptAt).toLocaleString()
                  : undefined
              }
              aria-label={
                state.nextAttemptAt
                  ? dateTime(state.nextAttemptAt)
                  : "未排定重試"
              }
            >
              {dateTime(state.nextAttemptAt, compact, now)}
            </time>
          </dd>
        </div>
      </>
    </dl>
  );
}

export function ProviderCard({
  provider,
  view,
  now,
}: {
  provider: Provider;
  view: "usage" | "cli" | "overview";
  now: number;
}) {
  const usage = provider.usage;
  const aged =
    usage.measuredAt !== null && now - Date.parse(usage.measuredAt) > 600000;
  const warning =
    usage.state === "authentication_required"
      ? "需登入"
      : usage.retained || aged || usage.state === "stale"
        ? "舊資料"
        : usage.state === "missing"
          ? "無資料"
          : usage.state === "partial"
            ? "資料不完整"
            : usage.state === "error"
              ? "查詢失敗"
              : null;
  const state = provider.collection.status;
  return (
    <Card
      className={`provider-card provider-${provider.id}`}
      aria-labelledby={`${provider.id}-title`}
    >
      <CardHeader className="provider-header">
        <h2 id={`${provider.id}-title`}>{provider.name}</h2>
        {view === "overview" && (
          <h3 className="panel-section-title" id={`${provider.id}-usage`}>
            用量
          </h3>
        )}
        {view === "cli" ? (
          <StatusBadge
            tone={
              state === "ok" ? "good" : state === "unknown" ? "neutral" : "bad"
            }
          >
            {collectionLabels[state]}
          </StatusBadge>
        ) : (
          warning && (
            <StatusBadge
              tone={
                usage.state === "authentication_required" ||
                usage.state === "error"
                  ? "bad"
                  : "warn"
              }
            >
              {warning}
            </StatusBadge>
          )
        )}
      </CardHeader>
      <CardContent className="provider-content">
        {view !== "cli" && (
          <section
            className="usage-section"
            aria-labelledby={
              view === "overview" ? `${provider.id}-usage` : undefined
            }
          >
            <div className="quota-grid">
              <Quota
                window={usage.primary}
                label="主要用量"
                now={now}
                provider={provider.name}
                inline={view === "overview"}
              />
              <Quota
                window={usage.secondary}
                label="次要用量"
                now={now}
                provider={provider.name}
                inline={view === "overview"}
              />
            </div>
          </section>
        )}
        {view !== "usage" && (
          <section
            className={view === "overview" ? "cli-section" : undefined}
            aria-labelledby={
              view === "overview" ? `${provider.id}-cli` : undefined
            }
          >
            {view === "overview" && (
              <h3 className="panel-section-title" id={`${provider.id}-cli`}>
                CLI 狀態
              </h3>
            )}
            <CliDetails
              provider={provider}
              compact={view === "overview"}
              now={now}
            />
          </section>
        )}
      </CardContent>
    </Card>
  );
}
