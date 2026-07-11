# AI Switcher

Ứng dụng desktop đa nền tảng (macOS, Windows, Linux) để quản lý và chuyển đổi tài khoản/config cho các AI provider.

Hiện hỗ trợ **OpenAI Codex CLI** qua hai chế độ:

| Provider | Auth | Quota |
|----------|------|-------|
| [FreeModel](https://freemodel.dev/dashboard/docs#codex) | API key | Dashboard OTP login |
| [ChatGPT](https://developers.openai.com/codex/auth) | OAuth subscription | ChatGPT `wham/usage` API |

## Tính năng

- Thêm / sửa / xóa nhiều tài khoản Codex (FreeModel hoặc ChatGPT)
- Chuyển tài khoản active chỉ với một click
- Tự động ghi `~/.codex/auth.json` và `~/.codex/config.toml`
- Theo dõi quota theo từng tài khoản (5h / 7 ngày cho FreeModel; cửa sổ chính/phụ cho ChatGPT)
- Đăng nhập FreeModel qua OTP để đọc quota dashboard
- Đăng nhập ChatGPT qua `codex login`, import từ `~/.codex`, hoặc chọn file `auth.json`
- Kiểm tra API key FreeModel qua endpoint API
- Theo dõi lịch sử chuyển tài khoản và số lần sử dụng

## Cấu hình Codex được áp dụng

Khi chuyển sang một tài khoản, app ghi vào `~/.codex/`. Chỉ **một** tài khoản active tại một thời điểm.

### FreeModel (API key)

**`~/.codex/auth.json`**

```json
{
  "OPENAI_API_KEY": "your_freemodel_key",
  "FREEMODEL_API_KEY": "your_freemodel_key"
}
```

**`~/.codex/config.toml`**

```toml
model_provider = "freemodel"
model = "gpt-5.5-codex"
model_reasoning_effort = "xhigh"
disable_response_storage = true
preferred_auth_method = "apikey"

[model_providers.freemodel]
name = "freemodel"
base_url = "https://api.freemodel.dev"
wire_api = "responses"
requires_openai_auth = false
env_key = "FREEMODEL_API_KEY"
```

Tham khảo: [FreeModel Codex docs](https://freemodel.dev/dashboard/docs#codex)

### ChatGPT (OAuth subscription)

**`~/.codex/auth.json`**

```json
{
  "auth_mode": "chatgpt",
  "tokens": {
    "access_token": "...",
    "account_id": "...",
    "id_token": "..."
  }
}
```

**`~/.codex/config.toml`**

```toml
model = "gpt-5.4"
model_reasoning_effort = "xhigh"
cli_auth_credentials_store = "file"
preferred_auth_method = "chatgpt"
```

Tham khảo: [Codex auth docs](https://developers.openai.com/codex/auth)

## Yêu cầu

- Node.js 18+
- npm
- **Codex CLI** — cần khi đăng nhập ChatGPT qua OAuth (`codex login`)

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
| `~/.ai-switcher/codex-auth/{id}.json` | Snapshot auth ChatGPT OAuth theo tài khoản |
| `~/.codex/` | Config live của Codex CLI (auth + config.toml) |

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

### Xem quota

- **FreeModel**: cần đăng nhập dashboard (OTP). API key alone không đủ quyền đọc quota.
- **ChatGPT**: cần auth OAuth hợp lệ. Quota hiển thị theo % (cửa sổ chính / phụ).

## Roadmap

- Hỗ trợ Claude Code + FreeModel
- Mã hóa API key bằng OS keychain
- Tự refresh token ChatGPT khi hết hạn
