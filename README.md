# Kobo Token Monitor

自架的 Codex／Claude 訂閱用量看板。React + TypeScript 提供手機、平板、桌面適用的三頁 RWD 介面；同一個 Node.js 服務提供 JSON API 與 1072 × 1448 PNG，Kobo 可直接下載顯示。背景排程與 CLI 查詢仍由 Node.js 執行。

## Docker 部署

支援 Linux amd64／arm64。映像固定使用 CodexBar 0.80.0、Codex 0.164.0、Claude Code 2.1.310，包含中文字型；不含任何帳號憑證。

```sh
# 首次部署建立設定；若已有 .env，保留現有設定即可。
cp -n .env.example .env
docker compose build

# 首次登入：遠端終端機顯示網址，在你的瀏覽器完成授權。
docker compose run --rm --no-deps monitor codex login --device-auth
docker compose run --rm --no-deps monitor claude auth login

docker compose up -d
docker compose logs -f monitor
```

Codex device-code 登入可能需要先在 ChatGPT 安全設定開啟。Claude 若瀏覽器無法返回遠端 callback，可依 CLI 提示貼回登入碼。這兩步需要本人完成，服務不會嘗試自動輸入密碼或繞過 MFA。

Compose 預設只綁定主機 `127.0.0.1:8080`，可在既有 HTTPS reverse proxy 後方使用。若只在可信 LAN 測試，修改 `.env` 的 `BIND_ADDRESS` 為該主機的 LAN IP；Kobo 改用該 IP 存取。所有讀取端點均免認證，能連到服務的人即可讀取用量與狀態。若需遠端使用，可透過 VPN 或反向代理控制存取。舊 `.env` 中的 `DASHBOARD_TOKEN` 可刪除，程式不再讀取它或 `DASHBOARD_TOKEN_FILE`。

### 網頁、圖片與 API

| 路徑 | 用途 |
| --- | --- |
| `/`、`/overview` | 綜合總覽：用量與 CLI 狀態 |
| `/usage` | 我的用量 |
| `/cli` | CLI 最近查詢、認證檢查與重試狀態 |
| `/api/dashboard` | 同一份快照的用量、收集狀態與服務資訊 |
| `/usage.png` | Kobo PNG 圖片 |
| `/status` | 相容既有狀態查詢，保留 `running` 與 `providers` 欄位 |
| `/healthz` | 排程與產圖健康檢查 |

```sh
curl --fail http://127.0.0.1:8080/api/dashboard
curl --fail http://127.0.0.1:8080/usage.png -o usage.png
curl --fail http://127.0.0.1:8080/status
curl --fail http://127.0.0.1:8080/healthz
```

前端採用 shadcn/ui 的 Card、Button、Badge、Progress 與 Tailwind CSS 中性色主題；元件原始碼和 MIT 授權位於 `frontend/src/components/ui`。每個服務一張卡，總覽明確標示用量與 CLI 狀態，保留查詢結果、認證檢查、最近成功與下次重試四個欄位；移除側欄、摘要卡、副標題及宣傳文案。總覽時間以時分顯示，跨日以「明日／昨日」或日期區分，完整日期可從時間的提示與輔助閱讀資訊取得。一般標籤為 16px、狀態與重置時間為 14px、用量數字依尺寸為 40–72px。三個頁面在 320×568、375×667、390×844、768×1024、1280×720、844×390 視窗已驗證不需水平或垂直捲動；字體放大或更小視窗時仍允許自然捲動，避免裁切內容。

網頁開啟後立即讀取快照，之後依後端輪詢間隔更新（預設 60 秒）；背景分頁停止發起更新，回到前景且資料超過更新間隔會立即讀取。重新整理按鈕只讀取快照，不執行 CLI。連線失敗保留上次成功資料並提示異常；零用量與未知值分別顯示 `0%` 與 `—`。時間依瀏覽器所在時區顯示；額度倒數以伺服器時間為基準。

CLI 狀態代表後端最近一次查詢及認證檢查結果，不表示使用者電腦上的任務執行進度。歷史認證檢查成功不保證目前憑證仍有效。

服務僅提供唯讀介面，不提供原始登入檔、email 或 CLI 原始診斷輸出。`/healthz` 只表示排程與圖片生成是否運作；兩家登入與查詢結果請看網頁或 JSON API。PNG 失敗不會阻止 JSON 用量快照更新。沒有歷史資料庫，僅保留最近快照。

Kobo 下載不再需要 Authorization header。每次 PNG GET／HEAD 會檢查圖片，同一分鐘共用快取，跨分鐘時用已保存的用量和當下時間重新產圖。新用量寫入後，即使仍在同一分鐘也會重新產圖。並行下載共用同一次產圖；失敗時保留舊圖片，沒有舊圖片則回傳 503。Kobo 仍須每分鐘下載並顯示圖片，畫面時鐘才會更新；各家的測量時間保留原值。

### 本機前端開發

需要 Node.js 24（與 Docker 相同）。

```sh
npm ci
npm run build
npm start
# 開啟 http://127.0.0.1:8080/overview
```

前端修改時，在另一個終端機執行 `npm run dev`，開啟 Vite 印出的本機網址。Vite 將 `/api`、`/status`、`/healthz`、`/usage.png` 代理到 `127.0.0.1:8080`；開發時請讓後端使用預設 8080 port。`npm start` 直接啟動後端，預設監聽 `0.0.0.0`；限本機開發可用 `HOST=127.0.0.1 npm start`。本機需自行安裝與登入 CodexBar／相關 CLI，缺少 CLI 時會顯示查詢失敗；完整執行環境建議使用 Docker。

```sh
npm run typecheck
npm test
npm run build
```

正式環境使用多階段 Docker build，React 靜態檔由 Node 提供，只有一個容器和對外 port。`frontend/dist` 是建置產物，不納入 Git。直接進入 `/usage` 或 `/cli` 可正常載入；未知 API 路徑回傳 JSON 404，不會回傳前端 HTML。

### 排程與認證

| 設定 | 預設 | 行為 |
| --- | --- | --- |
| `POLL_INTERVAL_SECONDS` | 60 | 啟動立即更新；之後以約一分鐘為間隔查詢並產圖，慢任務不重疊；限流時仍遵守退避 |
| `CLI_TIMEOUT_SECONDS` | 45 | 每個 CLI 呼叫的最長時間，超時終止整個子程序群組 |
| `AUTH_CHECK_INTERVAL_SECONDS` | 86400 | 在收集循環中，每日執行一次認證恢復／檢查路徑 |

Codex 平常用 CodexBar CLI source 查詢；每日及認證失敗時，透過官方 App Server 的 `account/read`、`refreshToken: true` 交由 Codex 更新登入。RPC 僅讀取帳號，不會啟動模型工作。

Claude 平常使用 CodexBar Auto source；每日及認證失敗時改用 CLI source，讓 CodexBar 透過 Claude Code 的 `/usage` 路徑取得資料。這是認證恢復的嘗試，**不保證每天刷新一定成功**；`/status` 的 `lastAuthCheckAt`／`authCheckSucceeded` 記錄結果。Claude CLI source 成功代表取回用量，不代表一定更換了 token。沒有安排任何模型提示詞來維持登入。

認證失敗時最多恢復一次、重查一次，之後退避十五分鐘；429 遵守可解析的 `Retry-After` 秒數（最多一天），其他錯誤採 2、4、8、15 分鐘退避。兩家互不影響。圖片仍持續生成，保留最後成功資料並顯示過期／重新登入提示；沒有成功資料時顯示「—」。

每日任務與輪詢由同一個程序協調，不會同時更新同一家的憑證。需要重新登入時也先停服務，避免與背景程序競爭：

```sh
docker compose stop monitor
docker compose run --rm --no-deps monitor codex login --device-auth
# 或：docker compose run --rm --no-deps monitor claude auth login
docker compose up -d
```

`auth` named volume 保存 `/auth` 下的 Codex、Claude、CodexBar 設定；`data` volume 保存用量快照與圖片，重啟後仍保留原測量時間。`docker compose down` 不會刪除它們；`down -v` 會。請直接在遠端建立登入，不要讓多台機器共用同一份可變憑證檔。容器以非 root 使用者執行。

容器的 API、圖片與 logs 不含憑證或 email；`auth` volume 本身仍屬敏感登入資料，靜態檔案服務不會提供它。

## 本機產圖

The renderer uses `@resvg/resvg-js`: a small SVG layout rendered directly to a
1072 × 1448 opaque PNG without Chromium. Neutral text preserves grayscale edges;
green, terracotta and red are limited to service accents and quota bars.
The screenshot uses the user's supplied CodexBar snapshots, with email and other
unnecessary identity fields removed. It is not a live poll or a device photograph.

```sh
npm ci --ignore-scripts
npm run render
```

Outputs: `output/usage.png` and `output/usage.svg`.

To render a merged CodexBar JSON array:

```sh
node render-dashboard.mjs --input my-usage.local.json --at now --output output/usage.png
```

The default reference time is the newest `usage.updatedAt` in the input, so the
fixture preview remains reproducible. Production callers should use `--at now`;
measurements older than ten minutes are labeled stale. Missing percentages show
an em dash; missing reset times are never inferred. Claude's five-hour 0% is
shown as reported, with an explicit weekly-limit warning at 100%.

On Debian/Ubuntu, install `fonts-noto-cjk` for the Chinese labels. Alternatively
set `KOBO_FONT` to a font path. On macOS this prototype uses system Arial and Heiti
fonts. The PNG has no external font dependency after rendering. Color rendering
and refresh behavior still require validation on the actual Kobo/FBInk build.

Library: https://github.com/thx/resvg-js

### Unavailable/error states

`usage-model.mjs` validates each provider independently. Missing/null/non-numeric
percentages and values outside 0–100 render as `—` with an explicit `無資料` track.
A real numeric zero stays 0%. 401/authentication errors show `需要重新登入`;
other provider/input errors show `查詢失敗`. An unreadable file or malformed JSON
still generates a complete error-state PNG. Partial responses show valid windows
and leave other windows unknown. No account plan is inferred when it is absent.
Old successful data remains visible with `資料已過期`; each provider includes its
measurement date/time. One failed provider does not suppress the other.

```sh
npm test
node render-dashboard.mjs --input fixtures/unavailable.json --output output/unavailable.png
```

The previews cover normal, authentication-required, missing, and input-error
states. Seven model tests cover unknown vs zero, out-of-range values, stale and
partial data, authentication failures and weekly exhaustion. Atomic PNG replacement
prevents an incomplete PNG being served. PNG encoding and temporary-file write
failures leave the previous PNG in place. The Docker service adds collection,
timeouts, backoff and HTTP serving.

## 驗證範圍

React 介面已通過 TypeScript 檢查與正式建置；目前 26 個自動測試涵蓋收集、認證恢復、公開快照、欄位去識別化、SPA 深層路由、靜態檔案限制與 PNG 快取／失敗保留。瀏覽器實測桌面與 320／390／768px 寬度，確認頁面切換、手動更新、重新整理、未知用量、認證失敗及斷線保留資料。瀏覽器驗證使用範例快照，不代表真實帳號的查詢與續期已驗證。

新版 Linux arm64 Docker 映像已建置成功，並以無網路、空白登入環境啟動；三個網頁、JSON API、狀態、健康檢查及 PNG 均回傳 200，未設定 Dashboard token。

已實際建置並運行 Linux arm64 映像，驗證無登入時的錯誤分類、PNG 下載回應（當時使用 Bearer 認證；目前已改為免認證）、健康檢查、定時產圖，以及重啟後的舊資料保留；Linux 字型與 PNG 也已視覺檢查。amd64 有建置路徑，尚未在此環境實測。

測試使用獨立空白登入目錄與去識別範例數據，沒有複製本機登入憑證。正式部署後仍須完成首次登入，並驗證各帳號的實際用量與跨到期續期行為；尤其 Claude 的自動恢復不能以本次無登入測試當成已證明成功。
