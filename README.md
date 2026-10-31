# Kobo Token Monitor

自架的多帳號 Codex／Claude 訂閱用量看板。每個 worker container 負責一個帳號、一個 provider；master 定期收集快照，提供 React 總覽與 Kobo PNG。預設為兩個 Codex 帳號、一個 Claude 帳號。

```text
codex-1  ─┐
codex-2  ─┼─ HTTP /snapshot ← master → /overview、/api/dashboard、/usage.png
claude-1 ─┘
```

Worker 各自保存登入、用量快照、排程與認證恢復狀態。master 不執行 CLI、不掛載登入 volume；沒有額外資料庫或訊息佇列。每個帳號以唯一 worker ID 區分，同 provider 的不同帳號不會互相覆蓋。不同帳號的百分比不相加。

## Docker 部署

需要 Docker Compose。支援 Linux amd64／arm64 的建置路徑。worker 映像使用 CodexBar 0.80.0、Codex 0.164.0、Claude Code 2.1.310；master 映像只包含 API、前端與產圖所需程式及中文字型。

```sh
cp -n .env.example .env
docker compose build

# 分別使用對應帳號登入，每個 worker 使用自己的 auth volume。
docker compose run --rm --no-deps codex-1 codex login --device-auth
docker compose run --rm --no-deps codex-2 codex login --device-auth
docker compose run --rm --no-deps claude-1 claude auth login

docker compose up -d
docker compose logs -f master codex-1 codex-2 claude-1
```

登入需本人完成 CLI 提示的授權。重新登入前，只需停止對應 worker，避免背景更新與登入同時操作憑證：

```sh
docker compose stop codex-2
docker compose run --rm --no-deps codex-2 codex login --device-auth
docker compose up -d codex-2
```

master 預設綁定主機 `127.0.0.1:8080`，可透過 `.env` 的 `BIND_ADDRESS`、`PORT` 調整。Worker 只有 Compose 網路內的 8080 port，沒有主機 port。端點為唯讀、免認證，限可信網路；遠端存取可接既有 VPN 或 HTTPS reverse proxy。

### 增減 worker

`workers.json` 決定 master 要讀取哪些 worker，以及網頁和 PNG 的排列順序：

```json
[
  { "id": "codex-1", "name": "Codex 個人", "provider": "codex", "url": "http://codex-1:8080" },
  { "id": "codex-2", "name": "Codex 工作", "provider": "codex", "url": "http://codex-2:8080" },
  { "id": "claude-1", "name": "Claude", "provider": "claude", "url": "http://claude-1:8080" }
]
```

新增帳號時：

1. 在 `compose.yaml` 複製一個 worker service，套用 `<<: *worker`，設定唯一的 `WORKER_ID` 與 `PROVIDER`（`codex` 或 `claude`）。
2. 為它建立獨立 `/auth`、`/data` named volumes，並在 Compose 底部宣告。不要與另一個 worker 共用登入 volume。
3. 在 `workers.json` 加入相同 `id`、`provider`、顯示名稱與 service URL。
4. 執行該 service 的登入命令，然後 `docker compose up -d 新服務名稱`。
5. `docker compose up -d --force-recreate master` 載入新清單。

移除帳號時，停止對應 service，從清單與 Compose 移除該服務，再重新建立 master。保留 named volumes 可供日後恢復；不必刪除登入資料。暫停 worker 但保留清單時，卡片仍會顯示並標記「Worker 離線」。空清單 `[]` 會顯示尚未設定 worker。

這些是具名的帳號服務：不要對同一 service 使用 `--scale` 來新增帳號，因為那些副本會共用同一 worker ID 與憑證。各 worker 可獨立啟停，不要求全部正常才啟動 master。修改清單後需重新建立 master；尚未實作自動探索或熱更新。

### 舊版遷移

舊版 `monitor` 使用共用 `auth` volume。新版為各帳號建立全新的獨立 volumes，**不會自動搬移或複製舊憑證**。先在舊 Compose 設定下執行 `docker compose stop monitor`，再套用新版設定並分別登入。若已換成新版設定，可先用 `docker compose ls`／`docker ps` 確認舊容器並停止它，避免舊服務持續查詢。

舊 `data` volume 可保留；舊快照沒有 worker ID，因此不會被猜測配對到新帳號。新 worker 完成查詢後會寫入新快照。`docker compose down` 保留 volumes；`down -v` 會刪除登入與快照。不要在不同機器上共用可變憑證檔。

## 顯示與 API

| master 路徑 | 用途 |
| --- | --- |
| `/`、`/overview` | 唯一的綜合總覽 tab，每個 worker 一張卡，由上往下排列 |
| `/usage`、`/cli` | 舊連結導向 `/overview` |
| `/api/dashboard` | 用量、收集狀態、服務資訊；`providers[].id` 為 worker ID，`provider` 為服務種類 |
| `/usage.png` | 固定 **1072 × 1448** 的 PNG |
| `/status` | `providers` 依 worker ID 分組的狀態 |
| `/healthz` | master 排程與產圖健康檢查 |

每個 worker 提供內部 `/snapshot` 與 `/healthz`，不提供網頁或 PNG。`/snapshot` 僅讀取快照，不觸發 CLI。master 驗證 worker ID 與 provider，重新篩選公開欄位；不提供 token、email、登入檔或原始 CLI 輸出。顯示名稱由你設定，請不要填入敏感資訊。

前端卡片包含用量、查詢、認證檢查、最近成功與重試狀態。網頁可自然往下捲動；PNG 在原本尺寸內，依 worker 數量等比例縮小並垂直堆疊，包含所有帳號，絕不增加圖片高度。Worker 越多文字越小。PNG 已測試 0、1、3、6 個 worker 的固定尺寸；實際電子看板的可讀性仍需裝置確認。

前端依 master 輪詢間隔重新讀取資料，背景分頁暫停更新；重新整理不執行 CLI。讀取失敗保留舊畫面。`0%` 與未知 `—` 分別呈現。Worker 離線時 master 保留該 worker 上次資料與原測量時間，不影響其他帳號。資料超過十分鐘標示過期。master 健康並不代表每個帳號都已登入，請查看各張卡片。

PNG GET／HEAD 會更新分鐘時鐘，同分鐘共用快取；新資料使快取失效。並行下載共用一次產圖。產圖失敗保留舊 PNG；沒有舊 PNG 時回傳 503。Kobo 仍需定期下載才能更新畫面。PNG 使用 Asia/Taipei 時區，網頁使用瀏覽器時區。

## 排程與恢復

| 設定 | 服務 | 預設 |
| --- | --- | --- |
| `WORKERS_CONFIG` | master | `workers.json` |
| `WORKER_TIMEOUT_SECONDS` | master | 5 |
| `POLL_INTERVAL_SECONDS` | master／worker | 60 |
| `WORKER_ID`、`PROVIDER` | worker | 必填 |
| `WORKER_NAME` | worker 內部快照名稱 | worker ID；總覽名稱由 master 清單決定 |
| `CLI_TIMEOUT_SECONDS` | worker | 45 |
| `AUTH_CHECK_INTERVAL_SECONDS` | worker | 86400 |
| `DATA_DIR` | 兩者 | Docker `/data`，本機 `data` |

master 啟動即並行讀取所有 worker，預設每分鐘更新。worker 啟動即查詢，完成後等待輪詢間隔，不重疊執行。兩層各自輪詢，總覽可能落後一個 master 輪詢週期。

沿用既有認證流程：Codex 平常使用 CodexBar CLI source，每日與認證失敗時透過 App Server `account/read`、`refreshToken: true` 嘗試恢復；Claude 平常使用 Auto source，每日與認證失敗時使用 CLI source。這些流程不發送模型提示詞，也不保證每次都能恢復登入。認證失敗最多恢復一次、重查一次，之後退避十五分鐘；429 遵守可解析的 Retry-After，其他錯誤採 2、4、8、15 分鐘退避。每個 worker 獨立處理。

## 本機開發與驗證

Node.js 24：

```sh
npm ci
npm run build
npm test
npm start
# master 預設讀取 workers.json；本機測試請把 URL 改為各 worker 的 localhost port。
# worker 範例，請使用獨立登入與資料目錄：
# WORKER_ID=codex-1 PROVIDER=codex DATA_DIR=./data/codex-1 PORT=8081 node service/worker.mjs
```

`npm run dev` 啟動 Vite，代理 API 到本機 master 的 8080 port。完整 CLI 環境建議使用 Docker；本機 worker 需自行安裝 CodexBar 與對應 CLI，並設定各自獨立的 `HOME`、`CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`XDG_CONFIG_HOME`。

```sh
node render-dashboard.mjs --input fixtures/usage.json --output output/usage.png
# 多帳號輸入為陣列，每筆保留 provider、usage，另加唯一 workerId 與 name。
node render-dashboard.mjs --input my-usage.local.json --at now --output output/usage.png
```

產圖使用 `@resvg/resvg-js`，輸出 PNG 與 SVG；Linux 需 Noto CJK 字型，或使用 `KOBO_FONT` 指定字型檔。預設範例的時間取最新測量時間，正式產圖使用 `--at now`。

目前 30 個測試涵蓋原收集與認證流程、三個模擬 worker 到 master 的 HTTP 整合、同 provider 的帳號隔離、離線保留、重啟快照、身分不符拒收、公開欄位篩選與固定 PNG 尺寸。前端已通過 TypeScript 與正式建置，Compose 設定已驗證；新版 Docker 映像與三個真實帳號登入尚未實測。
