# AGENTS.md — ai-switcher

> Bản đồ ngắn cho AI agent (tạo 2026-11-17). Quy tắc chung nằm ở global rules (`thao-global`); file này chỉ ghi điều riêng của repo. Trao đổi với chủ repo bằng tiếng Việt.

Tài liệu/rule có sẵn (ưu tiên khi mâu thuẫn): `CODE_REVIEW.md`

## How to run
- `npm run dev` → `electron-vite dev`
- `npm run build` → `electron-vite build`
- `npm run typecheck` → `tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.jso`
- `npm run test` → `vitest run`
- `npm run preview` → `electron-vite preview`

## Layout
- Stack: `react`, `vite`, `vitest`; package manager `npm`.
- `src/`: `components`

## Reference sibling
- (chưa xác định — hỏi chủ repo)

## Reusable catalog
- `src/components/`: `AccountDialog.tsx`, `AntigravityAccountDialog.tsx`, `AntigravityLoginDialog.tsx`, `ChatGptAccountDialog.tsx`, `ChatGptLoginDialog.tsx`, `CopilotAccountDialog.tsx`, `CopilotLoginDialog.tsx`, `FreeModelLoginDialog.tsx`, `QuotaPanel.tsx`

## Clients & URLs
- Biến môi trường mẫu: `.env.example` (không đọc `.env`).
- Toast: không thấy toast trong HTTP middleware → toast thủ công theo module mẫu.

## Conventions unique to this repo
- (chưa xác định — hỏi chủ repo)

## Verify notes
- `npm run typecheck`, `npm run build`, `npm run test`
- `bash ~/.cursor/hooks/check-structure.sh` (diff) để soát types/toast/URL hard-code.
