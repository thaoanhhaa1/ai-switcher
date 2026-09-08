#!/usr/bin/env node
/**
 * Driver e2e test runner — chạy cả native (better-sqlite3) + CLI fallback
 * trong Electron runtime (ELECTRON_RUN_AS_NODE) vì binary native được build
 * theo ABI Electron (`npm run rebuild:native`).
 *
 * Cú pháp: node tests/e2e/run-driver-tests.cjs [test-file...]
 * Không có args → chạy cả 2 suite: sqlite-driver.e2e.cjs + sqlite-driver-fallback.e2e.cjs
 */
const { execFileSync } = require('node:child_process')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const root = resolve(__dirname, '..', '..')
const electronBin = join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')

// Windows/Linux: electron binary nằm chỗ khác — chỉ hỗ trợ macOS cho driver e2e
if (process.platform !== 'darwin') {
  console.log('test:driver chỉ hỗ trợ macOS (đường dẫn Electron binary). Bỏ qua.')
  process.exit(0)
}

const esbuild = resolve(root, 'node_modules', '.bin', 'esbuild')
const cacheDir = join(root, 'node_modules', '.cache')
require('node:fs').mkdirSync(cacheDir, { recursive: true })
const bundlePath = join(cacheDir, 'driver-bundle.cjs')

function buildBundle() {
  execFileSync(esbuild, [
    join(__dirname, 'driver-entry.ts'),
    '--bundle',
    '--format=cjs',
    '--platform=node',
    '--target=node18',
    '--external:better-sqlite3',
    '--external:jsonc-parser',
    `--alias:electron=${join(__dirname, 'stub-electron.cjs')}`,
    `--outfile=${bundlePath}`
  ], { stdio: 'inherit', cwd: root })
}

function runSuite(testFile) {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_PATH: join(root, 'node_modules'),
    DRIVER_BUNDLE: bundlePath
  }
  console.log(`\n=== ${testFile} ===`)
  const result = execFileSync(electronBin, [join(__dirname, testFile)], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  })
  console.log(result.trim())
  const match = /(\d+) passed, (\d+) failed/.exec(result)
  if (!match) throw new Error(`Không đọc được kết quả test từ ${testFile}`)
  return match
}

const tests = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['sqlite-driver.e2e.cjs', 'sqlite-driver-fallback.e2e.cjs']

buildBundle()

let failed = 0
for (const test of tests) {
  try {
    const match = runSuite(test)
    if (Number(match[2]) > 0) failed += 1
  } catch (error) {
    console.error(error.stdout ?? error.message)
    failed += 1
  }
}

console.log(`\n${failed ? `✗ ${failed} suite FAILED` : '✓ tất cả driver suites PASS'}`)
process.exit(failed ? 1 : 0)
