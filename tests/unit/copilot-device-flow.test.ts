// ============================================================================
// R8 L2: lớp R6 L5 (withTimeout / abortableSleep / phân loại AbortError →
// 'Đã hủy', TimeoutError → message mạng tiếng Việt) CHƯA có test chạy
// implementation THẬT — mọi test khác đều vi.mock cả module. File này spy
// globalThis.fetch để thực đo requestDeviceCode / pollForToken.
//
// R8 L3: pin convention 3-site mirror của COPILOT_DEVICE_FLOW_CANCELLED —
// provider (github-copilot.ts) và dialog (CopilotLoginDialog.tsx) giữ literal
// mirror vì ranh giới vi.mock/IPC; đổi chuỗi nguồn mà quên mirror thì đỏ tại
// đây thay vì vỡ semantics M1-R7/cancelledByUser âm thầm.
//
// R8 L4: backupDatabase phải checkpoint WAL (finalize) TRƯỚC copyFile — pin
// call order bằng driver CLI mock (đồng bộ pattern sqlite-db-finalize.test.ts).
// ============================================================================
import { fileURLToPath } from 'url'
import { join } from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Force CLI driver (better-sqlite3 ABI Electron fail trong vitest node env) —
// pattern y hệt sqlite-db-finalize.test.ts, để nhánh finalize của L4 đi qua
// execFile đã mock bên dưới.
import Module from 'module'

const originalLoad = Module._load
Module._load = function (request: string, ...rest: unknown[]) {
  if (request === 'better-sqlite3') {
    throw new Error('NODE_MODULE_VERSION mismatch (simulated)')
  }
  // @ts-expect-error -- internal Node API, forward args
  return originalLoad(request, ...rest)
} as typeof Module._load

afterAll(() => {
  Module._load = originalLoad
})

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, execFile: vi.fn() }
})

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    access: vi.fn(async () => undefined),
    copyFile: vi.fn(async () => undefined),
    readdir: vi.fn(async () => []),
    unlink: vi.fn(async () => undefined)
  }
})

import { execFile } from 'child_process'
import { copyFile, readFile, readdir, unlink } from 'fs/promises'
import {
  COPILOT_DEVICE_FLOW_CANCELLED,
  pollForToken,
  requestDeviceCode
} from '../../electron/main/copilot-device-flow'
import { backupDatabase } from '../../electron/main/sqlite-db'

const CANCELLED_LITERAL = 'Đã hủy đăng nhập GitHub'
const NETWORK_TIMEOUT_MESSAGE =
  'Không kết nối được github.com (hết thời gian chờ). Kiểm tra mạng rồi thử lại.'

const fetchSpy = vi.fn()

beforeEach(() => {
  fetchSpy.mockReset()
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

function abortError(): Error {
  return new DOMException('This operation was aborted', 'AbortError')
}

function timeoutError(): Error {
  return new DOMException('The operation was aborted due to timeout', 'TimeoutError')
}

// execFile mock trả kết quả wal_checkpoint theo chuỗi stdout dựng sẵn (L4).
function stubSqliteCli(checkpointStdout: string): void {
  vi.mocked(execFile).mockImplementation(((
    _file: string,
    args: string[],
    _options: unknown,
    callback: (error: unknown, result?: { stdout: string; stderr: string }) => void
  ) => {
    const sql = String(args[2] ?? '')
    const stdout = sql.includes('wal_checkpoint') ? checkpointStdout : ''
    callback(null, { stdout, stderr: '' })
    return { unref: () => undefined }
  }) as never)
}

// ============================================================================
// L2 — requestDeviceCode (abort vs timeout vs HTTP vs lỗi lạ)
// ============================================================================

describe('requestDeviceCode — phân loại lỗi theo signal (R6 L5, impl thật)', () => {
  it('user abort (signal aborted + fetch văng AbortError) → đúng message convention hủy', async () => {
    const controller = new AbortController()
    controller.abort() // hệ quả R6 L6: cancel tới TRƯỚC request
    fetchSpy.mockRejectedValue(abortError())

    await expect(requestDeviceCode(controller.signal)).rejects.toThrow(CANCELLED_LITERAL)
  })

  it('fetch chết vì TimeoutError (không có user signal) → message mạng tiếng Việt', async () => {
    fetchSpy.mockRejectedValue(timeoutError())

    await expect(requestDeviceCode()).rejects.toThrow(NETWORK_TIMEOUT_MESSAGE)
  })

  it('TimeoutError nhưng user signal đã abort TRƯỚC → vẫn là "hủy" (pin thứ tự ưu tiên phân loại)', async () => {
    const controller = new AbortController()
    controller.abort()
    fetchSpy.mockRejectedValue(timeoutError())

    await expect(requestDeviceCode(controller.signal)).rejects.toThrow(CANCELLED_LITERAL)
  })

  it('HTTP != ok → lỗi HTTP, không phải họ abort/timeout', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({}, false, 502))

    await expect(requestDeviceCode()).rejects.toThrow(/Không lấy được device code \(HTTP 502\)/)
  })

  it('lỗi mạng lạ (không Abort/Timeout) → propagate nguyên nhân gốc, không bịa message', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNRESET boom'))

    await expect(requestDeviceCode()).rejects.toThrow('ECONNRESET boom')
  })
})

// ============================================================================
// L2 — pollForToken (abortableSleep + phân loại giữa fetch + error codes)
// ============================================================================

describe('pollForToken — abort/timeout/phân nhánh payload (R6 L5, impl thật)', () => {
  it('signal abort TRONG cửa sổ abortableSleep → thức giấc ngay, ZERO fetch, message hủy', async () => {
    //.abortableSleep gắn listener trên signal GỐC (không phải combined) →
    // cancel không phải chờ hết interval (R6 L5).
    const controller = new AbortController()
    const poll = pollForToken('dc-1', 60, controller.signal) // sleep 60s
    setTimeout(() => controller.abort(), 10)

    await expect(poll).rejects.toThrow(CANCELLED_LITERAL)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('signal abort TRƯỚC khi pollForToken chạy → throw hủy ngay, không fetch', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(pollForToken('dc-2', 1, controller.signal)).rejects.toThrow(CANCELLED_LITERAL)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('slow_down → nudge +5000ms THẬT rồi mới fetch lại → token về → trả accessToken', async () => {
    vi.useFakeTimers()
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ error: 'slow_down' }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'ghu_sd' }))
      .mockResolvedValueOnce(jsonResponse({ login: 'slotuser' }))

    const poll = pollForToken('dc-slow', 2) // 2000ms; slow_down → 7000ms
    await vi.advanceTimersByTimeAsync(2_000)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(6_900)
    expect(fetchSpy).toHaveBeenCalledTimes(1) // chưa tới mốc 7000 → chưa fetch lại
    await vi.advanceTimersByTimeAsync(200)

    const result = await poll
    expect(result.accessToken).toBe('ghu_sd')
    expect(result.login).toBe('slotuser')
    expect(result.loginVerified).toBe(true)

    // fetch access_token phải kèm signal (withTimeout — R6 L5, không có là lỗi)
    const [, firstInit] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(firstInit.signal).toBeInstanceOf(AbortSignal)
  })

  it('authorization_pending → poll lại đúng interval → access_token → /user verify', async () => {
    vi.useFakeTimers()
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ error: 'authorization_pending' }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'ghu_pending' }))
      .mockResolvedValueOnce(jsonResponse({ login: 'octocat' }))

    const poll = pollForToken('dc-pending', 1)
    await vi.advanceTimersByTimeAsync(5_000) // 2× sleep 1s + flush

    const result = await poll
    expect(result.accessToken).toBe('ghu_pending')
    expect(result.login).toBe('octocat')
    expect(fetchSpy).toHaveBeenCalledTimes(3) // pending → token → /user
  })

  it('expired_token → message tiếng Việt "Device code đã hết hạn"', async () => {
    vi.useFakeTimers()
    fetchSpy.mockResolvedValue(jsonResponse({ error: 'expired_token' }))

    const poll = pollForToken('dc-expired', 1)
    const rejected = expect(poll).rejects.toThrow(/Device code đã hết hạn/)
    await vi.advanceTimersByTimeAsync(2_000)
    await rejected
  })

  it('signal abort GIỮA fetch (reject AbortError theo combined signal) → thoát loop NGAY bằng message hủy', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    fetchSpy.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(abortError()))
        })
    )

    const poll = pollForToken('dc-midfetch', 1, controller.signal)
    await vi.advanceTimersByTimeAsync(1_000) // sleep xong → fetch được gọi, treo
    const rejected = expect(poll).rejects.toThrow(CANCELLED_LITERAL) // attach trước advance
    controller.abort() // AbortSignal.any → combined văng abort → catch: aborted → break
    await vi.advanceTimersByTimeAsync(1_000)
    await rejected
  })

  it('TimeoutError giữa fetch (KHÔNG abort) → message mạng tiếng Việt, không im lặng continue', async () => {
    vi.useFakeTimers()
    fetchSpy.mockImplementation(() => Promise.reject(timeoutError()))

    const poll = pollForToken('dc-timeout', 1)
    const rejected = expect(poll).rejects.toThrow(NETWORK_TIMEOUT_MESSAGE)
    await vi.advanceTimersByTimeAsync(1_000)
    await rejected
  })

  it('lỗi mạng tạm (không Abort/Timeout) → retry continue, không nổ', async () => {
    vi.useFakeTimers()
    fetchSpy
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'ghu_retry' }))
      .mockResolvedValueOnce(jsonResponse({}))

    const poll = pollForToken('dc-retry', 1)
    await vi.advanceTimersByTimeAsync(5_000) // loop 1 fail → loop 2 token → /user

    const result = await poll
    expect(result.accessToken).toBe('ghu_retry')
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('unsupported_grant_type → ném đúng error_description GitHub (N3)', async () => {
    vi.useFakeTimers()
    fetchSpy.mockResolvedValue(
      jsonResponse({ error: 'unsupported_grant_type', error_description: 'client id cũ toe' })
    )

    const poll = pollForToken('dc-denied', 1)
    const rejected = expect(poll).rejects.toThrow(/client id cũ toe/)
    await vi.advanceTimersByTimeAsync(2_000)
    await rejected
  })
})

// ============================================================================
// L3 — pin literal + convention 3-site mirror
// ============================================================================

describe('COPILOT_DEVICE_FLOW_CANCELLED — pin convention 3-site mirror (R8 L3)', () => {
  it('literal nguồn đúng bằng chuỗi convention', () => {
    expect(COPILOT_DEVICE_FLOW_CANCELLED).toBe(CANCELLED_LITERAL)
  })

  it('provider github-copilot.ts và dialog CopilotLoginDialog.tsx còn giữ ĐÚNG literal mirror', async () => {
    // 2 consumer KHÔNG import value (ranh giới vi.mock / IPC) mà giữ literal.
    // Đổi chuỗi nguồn mà quên 1 mirror → semantics M1-R7 (settledByOurAbort)
    // hoặc cancelledByUser của dialog vỡ ÂM THẦM — test này đỏ là duy nhất.
    const unitDir = fileURLToPath(new URL('.', import.meta.url))
    const providerSource = await readFile(
      join(unitDir, '../../electron/main/providers/github-copilot.ts'),
      'utf-8'
    )
    const dialogSource = await readFile(
      join(unitDir, '../../src/components/CopilotLoginDialog.tsx'),
      'utf-8'
    )
    expect(providerSource).toContain(`const CANCELLED_LOGIN_MESSAGE = '${CANCELLED_LITERAL}'`)
    expect(dialogSource).toContain(`const DEVICE_LOGIN_CANCELLED = '${CANCELLED_LITERAL}'`)
  })
})

// ============================================================================
// L4 — backupDatabase: checkpoint WAL TRƯỚC khi copy (đơn giản finalize gate
// busy=0 như 2 driver; copyFile chạy bất kể checkpoint — không regression)
// ============================================================================

describe('backupDatabase — an toàn WAL (R8 L4)', () => {
  beforeEach(() => {
    vi.mocked(copyFile).mockClear()
    vi.mocked(readdir).mockClear()
    vi.mocked(unlink).mockClear()
  })

  it('checkpoint TRƯỚC copyFile (call order) — hết cửa sổ mất transaction chưa checkpoint', async () => {
    stubSqliteCli('0|0|0\n') // busy=0 → checkpoint hoàn tất

    await backupDatabase('/tmp/l4-should-not-exist.vscdb')

    expect(copyFile).toHaveBeenCalledTimes(1)
    const checkpointCall = vi.mocked(execFile).mock.calls.find((call) =>
      String((call[1] as string[])[2] ?? '').includes('wal_checkpoint')
    )
    expect(checkpointCall).toBeDefined()
    expect(vi.mocked(execFile).mock.invocationCallOrder.indexOf(checkpointCall!)).toBeLessThan(
      vi.mocked(copyFile).mock.invocationCallOrder[0]!
    )
    expect(vi.mocked(copyFile).mock.calls[0]?.[1]).toMatch(
      /state\.vscdb\.ai-switcher-.*\.bak$/
    )
  })

  it('checkpoint busy (process khác giữ WAL) → VẪN copy backup (không chặn switch), chỉ giữ sidecar', async () => {
    stubSqliteCli('1|3|0\n') // busy=1

    await expect(backupDatabase('/tmp/l4-busy.vscdb')).resolves.toMatch(/\.bak$/)

    expect(copyFile).toHaveBeenCalledTimes(1)
    expect(unlink).not.toHaveBeenCalled() // sidecar bị giữ (đúng semantics R5 LOW 2)
  })
})
