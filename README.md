# AI Switcher

Ứng dụng desktop đa nền tảng (macOS, Windows, Linux) để quản lý và chuyển đổi tài khoản/config cho các AI provider.

Hiện hỗ trợ:

| Provider | Tool | Auth | Quota |
|----------|------|------|-------|
| [FreeModel](https://freemodel.dev/dashboard/docs#codex) | Codex CLI | API key | Dashboard OTP login |
| [ChatGPT](https://developers.openai.com/codex/auth) | Codex CLI | OAuth subscription | ChatGPT `wham/usage` API |
| [Antigravity](https://github.com/NoeFabris/opencode-antigravity-auth) | OpenCode | Google OAuth | Claude / Gemini 3 Pro / Flash |

## Tính năng

- Thêm / sửa / xóa nhiều tài khoản (Codex FreeModel, Codex ChatGPT, Antigravity)
- Chuyển tài khoản active chỉ với một click
- Tự động ghi `~/.codex/`, `~/.config/opencode/antigravity-accounts.json`, và Antigravity IDE `state.vscdb`
- Theo dõi quota theo từng tài khoản
- Đăng nhập FreeModel qua OTP, ChatGPT qua `codex login`, Antigravity qua `opencode auth login`
- Import auth từ file hoặc config live

## Cấu hình Codex được áp dụng

Khi chuyển sang một tài khoản, app ghi vào `~/.codex/`. Chỉ **một** tài khoản active tại một thời điểm.

### FreeModel (API key)

**`~/.codex/auth.json`**

```json
{
  "OPENAI_API_KEY": "YOUR_API_KEY"
}
```

**`~/.codex/config.toml`**

```toml
model_provider = "freemodel"
model = "gpt-5.5"
model_reasoning_effort = "xhigh"
disable_response_storage = true
preferred_auth_method = "apikey"

[model_providers.freemodel]
name = "freemodel"
base_url = "https://api.freemodel.dev"
wire_api = "responses"
```

Tham khảo: [FreeModel Codex docs](https://freemodel.dev/dashboard/docs#codex)

### ChatGPT (OAuth subscription)

**`~/.codex/auth.json`**

```json
{
  "auth_mode": "chatgpt",
  "OPENAI_API_KEY": null,
  "tokens": {
    "id_token": "...",
    "access_token": "...",
    "refresh_token": "...",
    "account_id": "..."
  },
  "last_refresh": "2026-07-12T05:37:34.677019Z"
}
```

**`~/.codex/config.toml`**

Trên macOS, khi chuyển từ FreeModel (hoặc lần đầu), app ghi cấu hình Codex desktop (plugins, MCP servers, desktop settings). Khi chuyển giữa các tài khoản ChatGPT, `config.toml` hiện có được giữ nguyên — chỉ `auth.json` thay đổi.

Tham khảo: [Codex auth docs](https://developers.openai.com/codex/auth)

### Antigravity (Google OAuth via OpenCode + Antigravity IDE)

**OpenCode — `~/.config/opencode/antigravity-accounts.json`**

```json
{
  "version": 3,
  "accounts": [
    {
      "email": "you@gmail.com",
      "refreshToken": "1//0abc...",
      "projectId": "my-gcp-project",
      "enabled": true
    }
  ],
  "activeIndex": 0
}
```

Cần cài [OpenCode CLI](https://opencode.ai) và plugin `opencode-antigravity-auth`.

OAuth client credentials được tải từ [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) khi đăng nhập. Nếu cần override (offline hoặc custom app), đặt `ANTIGRAVITY_CLIENT_ID` và `ANTIGRAVITY_CLIENT_SECRET` trong `.env` (xem `.env.example`).

**Antigravity IDE — `~/Library/Application Support/Antigravity IDE/User/globalStorage/state.vscdb`**

Khi chuyển tài khoản, app cũng inject OAuth token vào SQLite database của Antigravity IDE. Nếu IDE đang mở, app sẽ tự đóng và mở lại IDE để áp dụng.

Tham khảo: [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth)

## Yêu cầu

- Node.js 18+
- npm
- **Codex CLI** — `npm install -g @openai/codex` (login ChatGPT)
- **OpenCode CLI** — `npm install -g opencode` (login Antigravity)

Cài Codex CLI:

```bash
npm install -g @openai/codex
```

> Lưu ý: dùng `@openai/codex`, không phải package `codex` không có scope.

Nếu chưa cài global, app tự tìm binary tại các vị trí sau (theo thứ tự):

1. Biến môi trường `CODEX_CLI_PATH`
2. `codex` trong PATH (qua login shell)
3. `~/.codex/plugins/.plugin-appserver/codex` (bundled bởi Cursor/plugin)
4. Homebrew, nvm, `~/.local/bin`, v.v.

## Chạy development

```bash
npm install
npm run dev
```

## Build app

```bash
npm run build
npm run package        # build cho OS hiện tại
npm run package:mac    # macOS
npm run package:win    # Windows
npm run package:linux  # Linux
```

File cài đặt sẽ nằm trong thư mục `release/`.

## Dữ liệu lưu trữ

| Đường dẫn | Mô tả |
|-----------|--------|
| `~/.ai-switcher/data.json` | Danh sách tài khoản, lịch sử sử dụng |
| `~/.ai-switcher/freemodel-sessions/{id}.json` | Session cookie FreeModel (đọc quota) |
| `~/.ai-switcher/codex-auth/{id}.json` | Snapshot auth ChatGPT OAuth |
| `~/.ai-switcher/antigravity-auth/{id}.json` | Snapshot Google OAuth Antigravity |
| `~/.config/opencode/antigravity-accounts.json` | Config live Antigravity (OpenCode) |

## Hướng dẫn sử dụng

### Thêm tài khoản FreeModel

1. Tạo tài khoản tại [freemodel.dev](https://freemodel.dev/)
2. Vào Dashboard → API Keys → tạo key mới
3. Trong AI Switcher: **+ Thêm tài khoản Codex** → chọn **FreeModel**
4. Nhập API key, chọn model và reasoning effort
5. Đăng nhập FreeModel (OTP) để xem quota usage

### Thêm tài khoản ChatGPT

1. Trong AI Switcher: **+ Thêm tài khoản Codex** → chọn **ChatGPT**
2. Đặt tên và chọn model
3. Liên kết auth bằng một trong các cách:
   - **Đăng nhập qua codex login** — mở trình duyệt OAuth (cần Codex CLI)
   - **Import từ ~/.codex** — nếu `auth.json` hiện tại đã là ChatGPT OAuth
   - **Chọn file auth.json** — import từ file backup
4. Bấm **Chuyển sang** để áp dụng auth vào `~/.codex`

| `~/.codex/` | Config live Codex CLI |

### Thêm tài khoản Antigravity

1. Cài OpenCode + plugin `opencode-antigravity-auth` trong `~/.config/opencode/opencode.json`
2. Trong AI Switcher: **+ Thêm tài khoản** → **Antigravity**
3. Liên kết auth: `opencode auth login`, import live, hoặc chọn file JSON
4. **Chuyển sang** để ghi `antigravity-accounts.json` với account active

### Xem quota

- **FreeModel**: cần đăng nhập dashboard (OTP). API key alone không đủ quyền đọc quota.
- **ChatGPT**: auth OAuth hợp lệ, quota theo %
- **Antigravity**: Claude, Gemini 3 Pro, Gemini 3 Flash (% còn lại + thời gian reset)

## Roadmap

- Hỗ trợ Claude Code + FreeModel
- Mã hóa API key bằng OS keychain
- Tự refresh token ChatGPT khi hết hạn
