# AI Switcher

Ứng dụng desktop đa nền tảng (macOS, Windows, Linux) để quản lý và chuyển đổi tài khoản/config key cho các AI provider.

Phiên bản đầu tiên hỗ trợ **OpenAI Codex CLI** qua [FreeModel](https://freemodel.dev/dashboard/docs#codex).

## Tính năng

- Thêm / sửa / xóa nhiều tài khoản FreeModel cho Codex
- Chuyển tài khoản active chỉ với một click
- Tự động ghi `~/.codex/auth.json` và `~/.codex/config.toml`
- Kiểm tra API key qua endpoint FreeModel
- Theo dõi lịch sử chuyển tài khoản và số lần sử dụng

## Cấu hình Codex được áp dụng

Khi chuyển sang một tài khoản, app sẽ ghi:

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

Tham khảo thêm tại [FreeModel Codex docs](https://freemodel.dev/dashboard/docs#codex).

## Yêu cầu

- Node.js 18+
- npm

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

- App data: `~/.ai-switcher/data.json`
- Codex config: `~/.codex/`

## Lấy API key FreeModel

1. Tạo tài khoản tại [freemodel.dev](https://freemodel.dev/)
2. Vào Dashboard → API Keys
3. Tạo key mới và thêm vào AI Switcher

## Roadmap

- Hỗ trợ Claude Code + FreeModel
- Mã hóa API key bằng OS keychain
- Đồng bộ usage từ dashboard FreeModel (nếu có public API)
