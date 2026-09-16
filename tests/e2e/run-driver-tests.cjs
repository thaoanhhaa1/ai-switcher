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
const { join, resolve } = require('node:path')

const root = resolve(__dirname, '..', '..')

/**
 * N4: resolve đường dẫn Electron binary cross-platform.
 * `require('electron')` từ plain Node trả về đúng path binary cho mọi OS
 * (electron npm trỏ qua dist/path.txt). Fallback thủ công nếu require fail.
 */
function resolveElectronBin() {
  try {
    const electronPath = require(join(root, 'node_modules', 'electron'))
    if (typeof electronPath === 'string' && electronPath.length) return electronPath
  } catch {
    // fall through
  }
  const dist = join(root, 'node_modules', 'electron', 'dist')
  if (process.platform === 'darwin') {
    return join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron')
  }
  if (process.platform === 'win32') {
    return join(dist, 'electron.exe')
  }
  return join(dist, 'electron')
}

const electronBin = resolveElectronBin()

const cacheDir = join(root, 'node_modules', '.cache')
require('node:fs').mkdirSync(cacheDir, { recursive: true })
const bundlePath = join(cacheDir, 'driver-bundle.cjs')

function buildBundle() {
  // N4: dùng JS API của esbuild (auto-find binary theo platform) thay vì
  // spawn `node_modules/.bin/esbuild` — shim .bin là shell script trên
  // POSIX và .cmd trên Windows (execFileSync không chạy được .cmd).
  const esbuild = require('esbuild')
  esbuild.buildSync({
    entryPoints: [join(__dirname, 'driver-entry.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    external: ['better-sqlite3', 'jsonc-parser'],
    alias: { electron: join(__dirname, 'stub-electron.cjs') },
    outfile: bundlePath
  })
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
