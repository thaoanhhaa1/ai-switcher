# Changelog

Tất cả các thay đổi đáng chú ý của dự án **AI Switcher** sẽ được ghi chép trong file này.

Định dạng dựa trên [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
và dự án tuân thủ theo [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.2.0] - 2026-10-31

### Added
- **Hỗ trợ Antigravity 2.x Credential Store (Keyring & Standalone Sync)**:
  - Đồng bộ token OAuth tới macOS Keychain hệ thống (service `gemini`, account `antigravity`) theo chuẩn `go-keyring-base64:` của Antigravity 2.x (`agy`).
  - Ghi token độc lập vào file `~/.gemini/jetski-standalone-oauth-token` với quyền truy cập an toàn `0600`.
  - Duy trì cơ chế đồng bộ kép (dual sync) song song với SQLite `state.vscdb` truyền thống để đảm bảo tính tương thích ngược.
  - Tự động mở lại Antigravity IDE nếu quá trình áp dụng token thất bại nhằm bảo vệ phiên làm việc của người dùng.
- **Dynamic Model Options cho Antigravity**:
  - Tự động truy vấn danh sách model khả dụng theo tài khoản qua Google API (`fetchAvailableModels`) thay vì danh sách tĩnh cố định.
  - Cho phép người dùng tùy chọn cấu hình `geminiModel` và `claudeModel` cụ thể cho từng tài khoản Antigravity trong `AntigravityAccountDialog`, hoặc giữ chế độ "Tự động" để app tự chọn model tối ưu.
  - Tích hợp in-memory cache cho candidate models (`clearDynamicCandidateModelsCache`) giúp giảm thiểu số lượng request tới Google API.
- **Cải tiến Auto Test Chat & Reset Quota Tuần**:
  - Bổ sung hàm kiểm tra cửa sổ ngắn hạn `isFamilyShortTermExhausted`: hoãn kích hoạt chat thử nghiệm nếu cửa sổ 5 giờ đang cạn kiệt (0% còn lại), tránh lãng phí request hoặc báo lỗi quota.
  - Ngăn chặn spam liên tục khi chu kỳ tuần chưa bắt đầu (`resetsAt === null`) thông qua `initialTriggeredSet`, được lưu bền vững qua `localStorage` (`AUTO_TEST_CHAT_INITIAL_TRIGGERED_KEY`).
  - Cơ chế backoff thông minh khi test chat thất bại: giảm thời gian thử lại xuống 2 phút (`DEFAULT_AUTO_TEST_CHAT_ERROR_COOLDOWN_MS`), tự động chuyển về cooldown đầy đủ (30 phút) sau 3 lần lỗi liên tiếp (`consecutiveErrorMap`).
  - Lưu trạng thái kích hoạt gần nhất (`lastTriggeredMap`) vào `localStorage` (`AUTO_TEST_CHAT_LAST_TRIGGERED_KEY`) để không bị mất khi reload hoặc mở lại ứng dụng.
- **Bộ kiểm thử tự động (Unit Tests)**:
  - Thêm test suite `tests/unit/antigravity-ide.test.ts` kiểm thử payload token store, mã hóa password keyring và đường dẫn standalone token.
  - Bổ sung các test case trong `tests/unit/antigravity-auto-chat.test.ts` cho logic cạn kiệt ngắn hạn, chống lặp vô hạn và dynamic cooldown.
  - Bổ sung test case trong `tests/unit/antigravity-provider.test.ts` cho `fetchDynamicCandidateModels`, `getAntigravityModelOptions` và ưu tiên model do người dùng cấu hình.

### Changed
- Cập nhật `AntigravityAccountDialog`: thêm giao diện lựa chọn model Gemini và Claude/GPT với dropdown tải động từ API.
- Cập nhật `testAntigravityChat`: ưu tiên model người dùng đã cấu hình trước, sau đó fallback tuần tự qua các candidate models động được tối ưu theo độ nhẹ (flash trước pro) và thử nghiệm qua nhiều base endpoints (Daily, Sandbox, Prod).
- `getProviderOptions` cho Antigravity chuyển sang trả về model options động theo tài khoản.

---

## [0.1.0] - 2026-10-27

### Added
- **Quản lý đa Provider**:
  - Hỗ trợ Codex FreeModel (API key), Codex ChatGPT (OAuth), Antigravity (Google OAuth), và GitHub Copilot (VS Code/Cursor OAuth).
  - Chuyển đổi tài khoản nhanh chóng chỉ với 1 click, tự động cập nhật cấu hình vào `~/.codex/config.toml`, `auth.json`, OpenCode config và VS Code `state.vscdb`.
- **Theo dõi Hạn mức & Quota thời gian thực**:
  - Quota panel trực quan hiển thị hạn mức theo từng nhóm model (Gemini, Claude / 3P).
  - Tách bạch cửa sổ 5 giờ (rolling window) và cửa sổ tuần (7-day window) kèm thời gian reset dự kiến.
- **Tự động kích hoạt Reset Quota Tuần (Auto Test Chat)**:
  - Lập lịch định kỳ tự động gửi tin nhắn thử nghiệm để kích hoạt chu kỳ quota tuần mới ngay khi đến hạn.
- **GitHub Copilot Device Flow**:
  - Hỗ trợ đăng nhập thiết bị (Device Flow OAuth) và quản lý token riêng biệt cho từng slot tài khoản Copilot.
- **Bảo mật & Quản lý file**:
  - Che API key trên Renderer process (SEC-09).
  - Kiểm tra và xác thực an toàn đường dẫn file cấu hình nhập vào, phòng chống tấn công path traversal.
  - Hệ thống SQLite driver dùng chung (`better-sqlite3` + CLI fallback) với mutex lock và tự động sao lưu định kỳ.

