# Kobo e-paper PNG dashboard

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
failures leave the previous PNG in place. The planned HTTP/polling
service is not implemented here yet, so network timeouts and retry policies still
belong to that future collector.
