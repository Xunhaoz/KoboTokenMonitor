import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { Activity, RefreshCw } from "lucide-react";
import { useDashboard } from "./hooks/useDashboard";
import { ProviderCard } from "./components/Panels";
import { Button } from "./components/ui/button";
import "./styles.css";

const navigation = [
  { to: "/usage", label: "我的用量" },
  { to: "/cli", label: "CLI 狀態" },
  { to: "/overview", label: "綜合總覽" },
];

function App() {
  const { pathname } = useLocation();
  const view =
    pathname === "/usage" ? "usage" : pathname === "/cli" ? "cli" : "overview";
  const { data, error, loading, refresh, receivedAt } = useDashboard();
  const [tick, setTick] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    document.title = `${navigation.find((item) => item.to === pathname)?.label ?? "綜合總覽"} · Token Monitor`;
  }, [pathname]);
  const now =
    data && receivedAt
      ? Date.parse(data.serverTime) + Math.max(0, tick - receivedAt)
      : tick;
  const updatedAt = data?.service.lastCycleAt;
  const warning = error
    ? data
      ? "連線中斷，顯示上次資料"
      : "無法連線，請重新整理"
    : data?.service.renderError && view !== "usage"
      ? "Kobo 圖片產生失敗"
      : null;

  return (
    <div className="dashboard-shell">
      <a className="skip-link" href="#main">
        跳至主要內容
      </a>
      <header className="toolbar">
        <h1>
          <Activity aria-hidden="true" />
          Token Monitor
        </h1>
        <div className="toolbar-actions">
          {warning ? (
            <span
              className="toolbar-warning"
              role="alert"
              aria-label={warning}
              title={error || warning}
            >
              {error ? "離線" : "圖片異常"}
            </span>
          ) : (
            updatedAt && (
              <time
                dateTime={updatedAt}
                title={`最近完成收集：${new Date(updatedAt).toLocaleString()}`}
                aria-label={`最近完成收集 ${new Date(updatedAt).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false })}`}
              >
                {new Date(updatedAt).toLocaleTimeString("zh-TW", {
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                })}
              </time>
            )
          )}
          <Button
            variant="outline"
            size="icon"
            className="refresh-button"
            disabled={loading}
            onClick={() => void refresh()}
            aria-label={loading ? "更新中" : "重新整理"}
            title="重新整理"
          >
            <RefreshCw
              className={loading ? "spin" : undefined}
              aria-hidden="true"
            />
          </Button>
        </div>
      </header>
      <nav className="view-tabs" aria-label="主要導覽">
        {navigation.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => `view-tab ${isActive ? "active" : ""}`}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <main
        id="main"
        className={`dashboard-grid view-${view}`}
        aria-label={
          navigation.find((item) => item.to === pathname)?.label ?? "綜合總覽"
        }
        aria-busy={!data && loading}
      >
        {data
          ? data.providers.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                view={view}
                now={now}
              />
            ))
          : !error && (
              <div className="empty-state" role="status">
                <RefreshCw className="spin" aria-hidden="true" />
                讀取中
              </div>
            )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <Routes>
      <Route path="/" element={<Navigate to="/overview" replace />} />
      {["/overview", "/usage", "/cli"].map((path) => (
        <Route key={path} path={path} element={<App />} />
      ))}
      <Route path="*" element={<Navigate to="/overview" replace />} />
    </Routes>
  </BrowserRouter>,
);
