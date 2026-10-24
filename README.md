# Kobo Token Monitor

自架的 Codex／Claude 訂閱用量電子紙看板。Docker 內執行 CodexBar，定時取得用量並產生 1072 × 1448 PNG；Kobo 只負責下載與顯示。

## Docker 部署

支援 Linux amd64／arm64。映像固定使用 CodexBar 0.80.0、Codex 0.164.0、Claude Code 2.1.310，包含中文字型；不含任何帳號憑證。

```sh
# 在專案目錄建立圖片下載密鑰；.env 不會進 Git 或 Docker build context。
umask 077
printf 'DASHBOARD_TOKEN=%s\nBIND_ADDRESS=127.0.0.1\nPORT=8080\n' "$(openssl rand -hex 32)" > .env
docker compose build

# 首次登入：遠端終端機顯示網址，在你的瀏覽器完成授權。
docker compose run --rm --no-deps monitor codex login --device-auth
docker compose run --rm --no-deps monitor claude auth login

docker compose up -d
docker compose logs -f monitor
```

Codex device-code 登入可能需要先在 ChatGPT 安全設定開啟。Claude 若瀏覽器無法返回遠端 callback，可依 CLI 提示貼回登入碼。這兩步需要本人完成，服務不會嘗試自動輸入密碼或繞過 MFA。

Compose 預設只綁定主機 `127.0.0.1:8080`，可在既有 HTTPS reverse proxy 後方使用。若只在可信 LAN 測試，修改 `.env` 的 `BIND_ADDRESS` 為該主機的 LAN IP；Kobo 改用該 IP 存取。Bearer token 在純 HTTP 會以明文傳輸，遠端網際網路部署應使用 HTTPS。

### 圖片與狀態端點

```sh
export DASHBOARD_TOKEN="$(sed -n 's/^DASHBOARD_TOKEN=//p' .env)"
curl --fail -H "Authorization: Bearer $DASHBOARD_TOKEN" \
  http://127.0.0.1:8080/usage.png -o usage.png
curl --fail -H "Authorization: Bearer $DASHBOARD_TOKEN" \
  http://127.0.0.1:8080/status
curl --fail http://127.0.0.1:8080/healthz
```

Kobo 下載同樣帶 `Authorization: Bearer ...`。服務沒有檔案瀏覽功能，不提供原始登入檔或 email。`/healthz` 不需登入，只表示排程與圖片生成是否運作；兩家登入是否有效，請看受保護的 `/status`。提供 PNG 時不會觸發額外查詢。

### 排程與認證

| 設定 | 預設 | 行為 |
| --- | --- | --- |
| `POLL_INTERVAL_SECONDS` | 120 | 啟動立即更新；之後以約兩分鐘為間隔查詢並產圖，慢任務不重疊 |
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

容器的 `/status`、圖片與 logs 不含憑證或 email；`auth` volume 本身仍屬敏感登入資料。進階部署可用 `DASHBOARD_TOKEN_FILE` 從容器內的 secret 檔案讀取圖片密鑰，取代環境變數。

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

已實際建置並運行 Linux arm64 映像，驗證無登入時的錯誤分類、受保護 PNG 的 200／401 回應、健康檢查、定時產圖，以及重啟後的舊資料保留；Linux 字型與 PNG 也已視覺檢查。amd64 有建置路徑，尚未在此環境實測。

測試使用獨立空白登入目錄與去識別範例數據，沒有複製本機登入憑證。正式部署後仍須完成首次登入，並驗證各帳號的實際用量與跨到期續期行為；尤其 Claude 的自動恢復不能以本次無登入測試當成已證明成功。
