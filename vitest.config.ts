import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Render test (.tsx) dùng JSX automatic runtime — không cần import React thủ công.
  esbuild: {
    jsx: 'automatic'
  },
  test: {
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    // Mặc định node; file cần DOM khai báo `// @vitest-environment jsdom` ở đầu file.
    environment: 'node'
  }
})
