# Code Review — Phase 0 (typecheck fix · Antigravity quota v2 · GitHub Copilot merge)

- **Ngày review:** 2026-09-07
- **Phạm vi:** `32a0905..HEAD` (5 commit, 25 file, +2875/−151 dòng)
- **Commit đã review:**
  | Commit | Nội dung |
  |--------|----------|
  | `0e2c2dc` | fix: resolve typecheck errors and add typecheck script |
  | `1566848` | feat: dynamic per-model Antigravity quota with real group windows |
  | `908c1d2` | fix: isolate per-account quota fetch failures |
  | `f21ef2c` | feat: integrate GitHub Copilot support (rebase + conflict resolution) |
  | `965fb2b` | docs: document GitHub Copilot provider and per-model Antigravity quota |

**Kết luận tổng quan:** Kiến trúc nhất quán với các provider có trước, quality pipeline (typecheck/build/smoke) xanh. Tuy nhiên **1 lỗi CRITICAL có khả năng mất dữ liệu người dùng** (wipe `settings.json` của VS Code) và **4 lỗi HIGH** cần sửa trước khi phát hành bản package có Copilot.

> **➡️ Cập nhật:** Toàn bộ P0 + P1 + hầu hết P2 đã được fix và verify — xem phần **"🛠️ Trạng thái xử lý"** gần cuối file. Phần review gốc bên dưới giữ nguyên để tra cứu chi tiết từng issue.

---

## 🔴 CRITICAL

### C1. Wipe toàn bộ `settings.json` của VS Code khi file chứa comment (JSONC)

**File:** `electron/main/copilot-ide.ts:339-354` (`updateCopilotPreferredAccount`)

```ts
try {
  const raw = await readFile(settingsPath, 'utf-8')
  settings = JSON.parse(raw) as Record<string, unknown>
} catch {
  settings = {}          // ← JSONC (comment) làm JSON.parse throw
}
settings['github.copilot.preferredAccount'] = username.trim()
await writeFile(settingsPath, JSON.stringify(settings, null, 4) + '\n')
// ← GHI ĐÈ TOÀN BỘ settings.json của user chỉ còn 1 key
```

`settings.json` của VS Code **chính thức hỗ trợ comment và trailing comma (JSONC)** — số lớn người dùng có comment trong file. Khi switch tài khoản Copilot, `JSON.parse` fail (đã kiểm chứng: `JSON.parse` throw trên input có `// comment`), catch gán `settings = {}`, rồi `writeFile` **xóa sạch toàn bộ cấu hình VS Code của user**.

**Tác động:** mất dữ liệu, xảy ra trên mọi lần switch Copilot thành công với user có settings.json dạng JSONC.

**Fix đề xuất (bất kỳ phương án nào):**
1. Parse fail → **bỏ qua bước update**, không ghi file (an toàn nhất, 3 dòng).
2. Dùng `jsonc-parser` (`parse` + `modify` + `applyEdits`) để chèn key mà giữ nguyên comment/format.
3. Regex chèn key vào object hiện có (fragile hơn, không khuyến khích).

---

## 🟠 HIGH

### H1. Quota Copilot dùng token machine-level, không phải token của slot → sai account khi multi-account

**File:** `electron/main/providers/github-copilot.ts:194-236, 477-488, 557`

`fetchCopilotQuota(accountId)` **không dùng token từ snapshot đã import của account**. Nó lấy token theo thứ tự: `gh auth token` (CLI) → `~/.config/github-copilot/apps.json|hosts.json` — tức token của **bất kỳ account nào đang đăng nhập trên máy**. Hệ quả:
- User có 2 slot Copilot (như data dev hiện tại: `anhthaodev`, `thaoanhhaa1`) → **cả 2 slot hiển thị cùng một quota** của account mà `gh` đang dùng.
- Dòng 557 `email: data.login ?? stored.username` hiển thị login của **token owner**, người dùng không biết đang xem quota của ai.

**Fix đề xuất:** so sánh `data.login` với `stored.username`; lệch thì trả `available: true` kèm `message: '⚠ Quota của @<login> (token máy), không phải @<username> của slot này'`. Long-term: giải mã `secret://` trong snapshot (cần key của VS Code — hoặc hướng khác: device flow token lưu riêng khi import).

### H2. Linux: `pkill -f code` / `pgrep -f code` giết nhầm process không liên quan

**File:** `electron/main/copilot-ide.ts:526-533` (`isIdeRunning`), `547-550` (`quitIde`)

Pattern `code` với `-f` (full command line) match **mọi process có chuỗi "code" trong cmdline**: `code-server`, `codium`, project path chứa `/code/`, `vscode-*` language server... `quitIde` Linux gửi SIGTERM tới tất cả → có thể giết cả app khác của user (kể cả chính process đang chạy script này nếu path chứa "code").

**Fix đề xuất:** dùng pattern anchor theo tên executable/argv0 (`pgrep -x code`, `pkill -x code`) hoặc match `--type=`/đường dẫn cài đặt cụ thể.

### H3. Switch/update account kill VS Code không cảnh báo — mất unsaved work; edit metadata cũng kill

**File:** `electron/main/copilot-ide.ts:492-498` (`stopIdeForWrite`), `electron/main/services.ts:544-591` (`updateAccount` re-apply tại dòng 590)

Hai vấn đề gộp:
1. `stopIdeForWrite` quit/kill IDE ngay khi bấm "Chuyển sang" — **không có confirm dialog** trong UI (`App.tsx handleSwitch`). User đang có unsaved files/built đang chạy sẽ bị gián đoạn.
2. `updateAccount` re-apply nếu account đang active → **sửa tên/note cũng đá văng VS Code**. Với antigravity re-apply chỉ ghi file (harmless), nhưng với copilot re-apply là destructive.

**Fix đề xuất:** (a) confirm dialog trước khi apply provider có `destructiveApply: true`; (b) `updateAccount` chỉ re-apply khi `settings`/auth thay đổi, name/note không.

### H4. Windows: luồng apply thực tế không chạy được (thiếu `sqlite3` + `python3`)

**File:** `electron/main/copilot-ide.ts:139-186, 582-584`; `isDbLocked:440-447` dùng `lsof`

- `ensureSqliteAvailable()` yêu cầu `sqlite3` CLI — **không có sẵn trên Windows** (Win 11 chỉ có `winsqlite3.dll`, không có CLI).
- `writeDbValue` spawn **`python3`** — trên Windows thường chỉ có `python` (hoặc MS Store stub).
- `isDbLocked` dùng `lsof` — không tồn tại trên Windows → luôn trả `false` (bỏ qua chờ unlock).

README claim hỗ trợ Windows → tính năng Copilot trên Windows sẽ fail với message khó hiểu (`spawn python3 ENOENT`).

**Fix đề xuất:** chuyển sang `better-sqlite3` (native module, electron-builder đã rebuild native deps) — hết phụ thuộc sqlite3 CLI + python3 + lsof, hết luôn các vấn đề escaping/stdout ở M-level bên dưới. Đây cũng là nền tảng để Phase 1 làm Antigravity IDE sạch hơn.

---

## 🟡 MEDIUM

### M1. Trùng lặp logic path: `getCopilotConfigDirPath()` vs `getCopilotConfigDir()`

**File:** `providers/github-copilot.ts:575-585` vs `paths.ts:57-75`

Hàm trong provider hardcode path VS Code **production**, bỏ qua dev sandbox (`~/.ai-switcher-dev/copilot`) và env override `COPILOT_CONFIG_DIR`. `services.ts` dùng lẫn cả hai: `PROVIDERS[].configDir` + `openCopilotDir()` dùng `getCopilotConfigDir()` (đúng sandbox), còn `buildActiveStatusFromAccount`/`getInactiveStatus` dùng `getCopilotConfigDirPath()` (sai trong dev). → Dev mode hiển thị sai thư mục config trên status panel.
**Fix:** xóa `getCopilotConfigDirPath()`, dùng `getCopilotConfigDir()` từ `paths.ts` everywhere.

### M2. Dev sandbox không áp dụng cho thao tác đọc state.vscdb thật

**File:** `copilot-ide.ts:59-123` (`getIdeDefinitions` luôn trả path thật)

Toàn bộ read path (`collectCopilotEntries`, `readLiveCopilotUsername`, `hasLiveCopilotAuth`, `assertImportableGithubAccount`) đánh vào `state.vscdb` **thật của user kể cả dev mode** (read-only nên không phá, nhưng trái triết lý sandbox trong README — antigravity dev là không đụng IDE).
**Fix:** cho `getIdeDefinitions` nhận sandbox override (env `COPILOT_IDE_DB_PATH` hoặc map theo `isDev()`).

### M3. `importCopilotFromFile` bỏ qua kiểm tra trùng auth

**File:** `providers/github-copilot.ts:463-471`

Live import gọi `assertAuthUniqueForAccount` (chống 2 slot cùng 1 auth), file import thì không → user có thể tạo 2 slot trùng token qua file mà không cảnh báo.
**Fix:** chạy cùng check (best-effort, so `github.auth secret` + `github.copilot-github` username).

### M4. `mapPercentCategory`: category không dữ liệu hiển thị "100% đã dùng"; field `unlimited` bị ignore

**File:** `providers/github-copilot.ts:146-174`

Khi `percent_remaining` undefined và `remaining` falsy → `remainingPercent = 0` → `usedPercent = 100`. Category không có usage data (hoặc plan **unlimited** — field `unlimited?: boolean` đã parse ở dòng 109 nhưng chưa dùng lần nào) bị hiển thị như đã cạn quota → user tưởng hết hạn mức.
**Fix:** `if (category.unlimited) return window với usedPercent 0 + label 'Unlimited'`; không có bất kỳ field số liệu nào → `return null` (ẩn card).

### M5. Chờ unlock DB cho-qua-sau-timeout rồi ghi tiếp; `lsof` thiếu → coi như unlocked

**File:** `copilot-ide.ts:440-456, 492-498`

`waitForDbUnlock` retry 40×250ms=10s rồi **return bình thường** kể cả vẫn locked → write vào DB đang bị giữ → sqlite trả `database is locked` (raw error nổi lên UI). Trên Windows `lsof` không tồn tại → catch → `false` → không chờ gì cả.
**Fix:** timeout → throw message rõ ("VS Code chưa đóng hẳn, thử lại"); trên Windows dùng `handle.exe`/mở file exclusive test, hoặc bỏ hẳn khi chuyển sang better-sqlite3.

### M6. Backup `.ai-switcher.bak` bị đè mỗi lần apply, không có đường restore

**File:** `copilot-ide.ts:595-603`

Mỗi lần switch đè backup trước đó; nếu user switch 2 lần rồi phát hiện state.vscdb hỏng thì backup khả dụng duy nhất đã là state giữa. Không có action "Restore backup" trong UI.
**Fix:** giữ backup theo timestamp (vd 5 bản gần nhất) + IPC restore.

### M7. Temp file `Date.now()` + thiếu mutex quanh thao tác apply

**File:** `copilot-ide.ts:162-186`; `services.ts` (không serialize switch/update)

`ai-switcher-copilot-${Date.now()}.txt` — hiện an toàn vì loop tuần tự, nhưng 2 IPC call chồng nhau (switch + updateAccount active cùng provider) có thể chạy song song trên cùng DB → race ghi/đè.
**Fix:** `fs.mkdtemp` cho temp; thêm mutex per-IDE quanh `applyCopilotIdeSnapshots` (tương tự nên áp dụng cho antigravity-ide).

---

## 🔵 LOW / INFO

| # | Vị trí | Vấn đề |
|---|--------|--------|
| L1 | `copilot-ide.ts:560-580`, `129-137`; `copilot-auth-storage.ts:74-82` | Dead code: `openIde`, `listAvailableCopilotIdes`, `mergeCopilotSnapshots` không được gọi; `restartedTargets` luôn rỗng → nên xóa hoặc wire vào UI |
| L2 | `providers/github-copilot.ts:98-103` vs `src/types.ts:51-56` | Định nghĩa trùng `CopilotLoginStatus` (`targets?: CopilotIdeTarget[]` vs `string[]`) — drift risk; provider nên import type từ `src/types` |
| L3 | `services.ts:757-772` | `getProviderOptions('github-copilot')` hardcode model đã lỗi thời (`gpt-4o`, `claude-sonnet-4`); dialog Copilot không dùng options này → config chết, dễ gây hiểu nhầm |
| L4 | `copilot-ide.ts:154-160` | `readDbValue` dùng `trimEnd()` trên stdout → value có trailing newline sẽ bị cắt; các key hiện tại (JSON/base64 một dòng) an toàn nhưng fragile |
| L5 | `copilot-ide.ts:214-223` | Regex `^github-[A-Za-z0-9._-]+(-usages)?$` thu hơi rộng (mọi key `github-*`), nhưng `filterEntriesForApply` đã chặn lại khi apply → chấp nhận được |
| L6 | `providers/antigravity.ts:399-400` | `hourly: models[0], weekly: models[1]` — abuse field legacy để tương thích UI cũ; nên cleanup khi QuotaPanel bỏ nhánh fallback |
| L7 | `load-env.ts:33` | `resolve(__dirname, '../..')` trên app đóng gói trỏ vào `Resources/` (không có .env) → README nói "override bằng `.env.production`" chỉ đúng khi chạy từ source; nên sửa doc hoặc hỗ trợ env trong userData |
| L8 | `copilot-ide.ts:225-258` | `collectCopilotEntries` spawn 1 process sqlite3 **per key** (~10-15 lần) — chậm nhưng chịu được; gộp 1 query `IN (...)` sẽ tốt hơn |
| L9 | `providers/github-copilot.ts:245-325` | Cursor được hỗ trợ một nửa: candidates/paths có `cursor` nhưng import chỉ đọc `['vscode']` → apply không bao giờ có cursor snapshot. Nên document rõ "Copilot: VS Code only (Cursor coming soon)" |
| L10 | `copilot-auth-storage.ts:41-43` | `writeFile mode 0o600` + `chmod` — tốt; lưu ý `secret://` blob chỉ giải mã được trên cùng máy+keychain → backup/export **không dùng được cross-machine** (design limitation, nên note trong README) |

---

## ✅ Điểm tốt đã ghi nhận

1. **Typecheck fix chứng minh giá trị ngay lập tức** — bắt được 2 bug import path sai (`codex-chatgpt.ts`, `github-copilot.ts`) mà esbuild âm thầm bỏ qua vì `import type`; build xanh nhưng TS đỏ → script `npm run typecheck` là catch đúng.
2. **`buildUnavailableQuota` + per-account catch** (`908c1d2`) — verified bằng smoke test: data dev có account `github-copilot` lạ không còn phá toàn batch quota.
3. **Antigravity quota v2** (`1566848`):
   - Danh sách model **động** từ API (agent/command/image/tiered) — Google thêm model mới không cần sửa code.
   - Semantics trung thực: `remainingFraction` thiếu = cạn (khớp hành vi IDE), bucket `disabled` hiển thị "Không áp dụng" thay vì ẩn.
   - Binding window = cửa sổ cạn nhất (model-own vs group) — đúng logic IDE.
   - Đã kiểm chứng: **19 unit assertions + live e2e trên 4 tài khoản Google thật** (12 model/account, số liệu khớp IDE).
4. **Chuỗi validation Copilot kỹ**: username khớp slot, nhất quán đa-IDE (nhiều user khác nhau → chặn), auth uniqueness khi import live, snapshot integrity check.
5. **Rebase resolution đúng**: giữ cả `buildUnavailableQuota` (main) + `persistCopilotIdentity`/copilot-snapshot (branch) trong `snapshotActiveAccountAuth`; toàn bộ phần còn lại auto-merge additive, verify bằng typecheck + build + smoke 0 lỗi IPC.
6. **Dev-mode gating** `AI_SWITCHER_APPLY_COPILOT_IDE` nhất quán với antigravity; file auth lưu `0o600`.
7. **QuotaPanel tabs** có `role="tab"`/`aria-selected`, fallback về 'overview' khi tab set thay đổi (switch account không crash).

---

## 🧪 Bằng chứng verification đã chạy

| Kiểm tra | Kết quả |
|----------|---------|
| `npm run typecheck` (cả 2 project) | ✅ pass |
| `npm run build` (main/preload/renderer) | ✅ pass |
| Unit test antigravity-quota (fixtures, 19 assertions) | ✅ pass |
| Live e2e quota 4 tài khoản Google thật | ✅ pass, sanity asserts OK |
| Dev smoke test (5 account / 4 provider, full IPC init flow) | ✅ 0 `Error occurred in handler`, renderer kết nối dev server |
| JSON.parse trên settings.json có comment | ❌ throw → xác nhận C1 |

---

## 🛠️ Trạng thái xử lý (cập nhật sau vòng fix)

| Issue | Trạng thái | Cách xử lý |
|-------|-----------|------------|
| **C1** wipe settings.json JSONC | ✅ **ĐÃ FIX** | `copilot-ide.ts` `updateCopilotPreferredAccount`: dùng `jsonc-parser` (`modify` + `applyEdits`) chèn key giữ nguyên comment/format; parse fail (JSONC hỏng) → **skip write**, log warn, không bao giờ ghi đè cả file. Đã test: JSONC có comment → comment + settings cũ còn nguyên sau khi chèn. |
| **H1** quota sai account | ✅ **ĐÃ FIX (cảnh báo)** | `fetchCopilotQuota` so `data.login` vs `stored.username` → lệch thì thêm `⚠ Quota của @X (token máy), không phải @Y của slot này` vào message. Long-term (token riêng per-slot) vẫn để Phase 1. |
| **H2** pkill Linux quá rộng | ✅ **ĐÃ FIX** | Linux dùng `pgrep -x`/`pkill -x code|cursor` (khớp chính xác argv0) thay vì `pgrep -f code`. |
| **H3** kill IDE không confirm | ✅ **ĐÃ FIX** | (a) `App.tsx handleSwitch`: confirm dialog khi switch Copilot mà `applyCopilotIde` bật. (b) `services.ts updateAccount`: thêm `configChanged` check — chỉ re-apply khi apiKey/model/effort đổi, sửa name/note không còn kick IDE. |
| **H4** phụ thuộc sqlite3 CLI/python3/lsof | ✅ **ĐÃ FIX (dual-driver)** | `copilot-ide.ts` chuyển sang **better-sqlite3** (native, lazy-load) + **fallback sqlite3 CLI** khi ABI chưa rebuild. CLI driver đã **loại hoàn toàn python3** (dùng `readfile()`/`writefile()` + `CAST AS TEXT` của CLI). Thêm script `rebuild:native` (`electron-builder install-app-deps`) + `asarUnpack` cho `node_modules/better-sqlite3`. Windows: không còn phụ thuộc python3/lsof; chỉ cần better-sqlite3 (prebuild có sẵn cho Electron 34 win/mac/linux) hoặc sqlite3 CLI. |
| M1 trùng lặp path | ✅ ĐÃ FIX | Xóa `getCopilotConfigDirPath()`; `services.ts` dùng `getCopilotConfigDir()` từ `paths.ts` thống nhất (sandbox + env override được tôn trọng). |
| M2 dev đọc state.vscdb thật | ✅ ĐÃ FIX (override) | Thêm env `COPILOT_IDE_DB_PATH` trỏ DB target `vscode` sang file khác (test/sandbox); khi override, `stopIdeForWrite` **bỏ qua quit/kill IDE thật**. Reads mặc định vẫn đọc VS Code thật (read-only — cần cho import live), ghi chú trong README. |
| M3 file-import thiếu uniqueness check | ✅ ĐÃ FIX | `importCopilotFromFile` chạy `assertAuthUniqueForAccount` với auth value từ snapshot vscode (nếu có). |
| M4 quota "no data" hiển thị 100% | ✅ ĐÃ FIX | `mapPercentCategory`: `unlimited` → card 0% nhãn `X · Unlimited`; không có số liệu → `return null` (ẩn card thay vì hiện 100%). |
| M5 unlock DB cho-qua | ✅ ĐÃ FIX | Native driver: `busy_timeout = 10000` + `translateBusyError` → lỗi tiếng Việt rõ ràng khi DB còn bị giữ. CLI driver: `waitForDbUnlock` trả boolean → hết 10s **throw** "VS Code vẫn đang giữ state.vscdb..." thay vì ghi tiếp. `lsof` thiếu (ENOENT) → chờ tĩnh 1.5s rồi proceed. |
| M6 backup bị đè | ✅ ĐÃ FIX | Backup timestamped `state.vscdb.ai-switcher-<ts>.bak`, tự prune còn 5 bản gần nhất. |
| M7 temp file + thiếu mutex | ✅ ĐÃ FIX | Temp file dùng `fs.mkdtemp` (tên duy nhất, tự dọn); `withDbLock` — promise-chain mutex per-DB-path serialize mọi `applyToIde`. |
| L1 dead code | ✅ ĐÃ FIX | Xóa `openIde`, `listAvailableCopilotIdes`, `mergeCopilotSnapshots`, field `restarted` (luôn rỗng). |
| L2 type trùng lặp | ✅ ĐÃ FIX | Xóa `CopilotLoginStatus` local trong `providers/github-copilot.ts`, import từ `src/types.ts`. |
| L3 model list lỗi thời | ✅ ĐÃ FIX | `getProviderOptions('github-copilot')` trả `{models: [], reasoningEfforts: []}` kèm comment (dialog Copilot không dùng). |
| L4 trimEnd cắt value | ✅ ĐÃ FIX | Native: prepared statement trả nguyên vẹn. CLI fallback: đọc qua `writefile()` ra temp file rồi đọc file (byte-exact). Test: value 3 dòng đọc lại đúng nguyên vẹn trên cả 2 driver. |
| L5 regex thu rộng | ℹ️ Chấp nhận | Giữ nguyên — `filterEntriesForApply` đã chặn khi apply (defense in depth đủ). |
| L6 abuse hourly/weekly | ℹ️ Defer Phase 1 | Gắn với cleanup QuotaPanel fallback. |
| L7 .env override packaged app | ✅ ĐÃ FIX (docs) | README ghi rõ override qua `.env` chỉ áp dụng khi chạy từ source; packaged app dùng biến môi trường hệ thống. |
| L8 N+1 sqlite query | ✅ ĐÃ FIX (native path) | better-sqlite3: mỗi op 1 connection ngắn, prepared statement; không còn spawn process per key. CLI fallback giữ nguyên (chỉ là fallback). |
| L9 Cursor half-wired | ✅ ĐÃ FIX (docs) | README ghi rõ Copilot sync hiện VS Code only. |
| L10 snapshot không dùng cross-machine | ✅ ĐÃ FIX (docs) | (Cần bổ sung — xem phần việc còn lại.) |
| — | ✅ Bổ sung khi fix | `asarUnpack` cho better-sqlite3 trong electron-builder config; `getActiveDriverName()` export cho test/debug; fix M2 side-effect (override DB → không quit IDE thật). |

**Hạng mục còn lại (Phase 1):**
- ~~Token riêng per-slot cho Copilot quota (long-term H1)~~ → ✅ ĐÃ FIX: GitHub device flow login per-slot (`copilot-device-flow.ts`, client_id Copilot plugin public, scope `read:user`), token lưu trong `copilot-auth/{id}.json`, `fetchCopilotQuota` ưu tiên token slot → fallback token máy + cảnh báo; UI device flow trong `CopilotLoginDialog`
- ~~Migration `antigravity-ide.ts` sang cùng dual-driver pattern (hiện vẫn CLI)~~ → ✅ ĐÃ FIX: tách shared module `electron/main/sqlite-db.ts` (dual-driver + mutex + backup), copilot-ide và antigravity-ide cùng dùng; antigravity cũng bỏ `pkill -f antigravity` → `pkill -x`
- ~~Unit tests cho `copilot-ide`/`github-copilot` chính thức vào repo~~ → ✅ ĐÃ FIX: vitest (`npm test`, 30 tests: antigravity-quota parsing, copilot quota mapping M4, filterEntriesForApply, storage migration) + driver e2e trong repo (`npm run test:driver`, 12+12 assertions chạy trong Electron runtime)
- L6 abuse hourly/weekly → ✅ ĐÃ FIX: antigravity trả `hourly/weekly` = emptyWindow (trung tính) thay vì ép models[0..1]
- L10 cross-machine note → ✅ ĐÃ FIX: README ghi rõ snapshot gắn máy

---

## 🧪 Bằng chứng verification — vòng fix (mới nhất)

| Kiểm tra | Kết quả |
|----------|---------|
| `npm run typecheck` | ✅ pass |
| `npm run build` (3 bundles) | ✅ pass |
| `npm run rebuild:native` (better-sqlite3 → Electron ABI 132) | ✅ pass |
| Driver test native (12 assertions: roundtrip quote/newline/unicode, delete, listKeys, ensureSchema, busy-lock message, jsonc C1, L4 multi-line, filter) — chạy trong Electron runtime | ✅ 12/12 |
| Driver test CLI fallback (12 assertions, simulate máy chưa rebuild) | ✅ 12/12 |
| Antigravity quota regression (19 assertions) | ✅ pass |
| Dev smoke test (5 account / 4 provider) | ✅ 0 IPC errors, renderer connected |

---

## 📋 Thứ tự sửa đề xuất

**P0 — trước khi package bản có Copilot:** *(✅ đã xử lý toàn bộ — xem bảng "Trạng thái xử lý" phía trên)*
1. C1 — không ghi đè settings.json khi parse fail (fix ~5 phút)
2. H1 — cảnh báo quota sai account (so `data.login` vs `stored.username`)
3. H2 — siết pattern pkill/pgrep trên Linux
4. H3 — confirm trước khi kill IDE + không re-apply khi chỉ đổi name/note

**P1 — tuần tiếp theo:** *(✅ đã xử lý — dual-driver better-sqlite3 + CLI fallback không python3)*
5. H4 + M5 + L4/L8 — ~~chuyển `copilot-ide.ts` sang `better-sqlite3`~~ → HOÀN THÀNH (lazy-load + fallback, `rebuild:native`, `asarUnpack`). `antigravity-ide.ts` chuyển theo ở Phase 1.
6. M1 + M2 — thống nhất path qua `paths.ts`, thêm sandbox override cho dev
7. M3, M4, M6, M7

**P2 — gộp vào Phase 1 (refactor):**
8. ~~L1–L3~~ (đã fix), L6, L9, L10 (docs đã fix) + unit tests cho `copilot-ide` (filter/validate) và `github-copilot` (quota mapping) — chính là lúc gom vào `ProviderAdapter` interface.

---

*Reviewer: opencode · Generated from diff `32a0905..965fb2b`*
