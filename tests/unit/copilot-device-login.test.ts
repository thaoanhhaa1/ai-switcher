import { beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================================
// CODE_REVIEW N2 — device flow login session:
// - githubLogin CHỈ lưu khi /user xác minh được (không "đoán" = username slot)
// - waitFor propagate lỗi THẬT (slot chưa có auth) thay vì "thất bại hoặc bị hủy"
// - token lưu OK nhưng không verify được → status.message chứa cảnh báo ⚠
// - phiên đã settle không chặn lần start sau; phiên pending thì có chặn
// ============================================================================

const store = vi.hoisted(() => ({
  entries: new Map<string, Record<string, unknown>>()
}))

vi.mock('../../electron/main/copilot-auth-storage', () => ({
  loadStoredCopilotAccount: vi.fn(async (id: string) => store.entries.get(id) ?? null),
  saveStoredCopilotAccount: vi.fn(async (id: string, entry: Record<string, unknown>) => {
    store.entries.set(id, entry)
  }),
  deleteStoredCopilotAccount: vi.fn(async (id: string) => {
    store.entries.delete(id)
  }),
  isValidCopilotEntry: (entry: unknown) => {
    const e = entry as
      | { username?: string; snapshots?: Record<string, { entries?: Record<string, string> }> }
      | null
    if (!e?.username?.trim()) return false
    return Object.values(e.snapshots ?? {}).some(
      (s) => s && Object.keys(s.entries ?? {}).length > 0
    )
  }
}))

vi.mock('../../electron/main/copilot-device-flow', () => ({
  requestDeviceCode: vi.fn(async () => ({
    device_code: 'device-code-test',
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    expires_in: 900,
    interval: 1
  })),
  pollForToken: vi.fn()
}))

import { pollForToken, requestDeviceCode } from '../../electron/main/copilot-device-flow'
import type { GithubTokenResult } from '../../electron/main/copilot-device-flow'
import {
  cancelCopilotDeviceLogin,
  startCopilotDeviceLogin,
  waitForCopilotDeviceLogin
} from '../../electron/main/providers/github-copilot'

function seedSlot(id: string, username = 'slotuser'): void {
  store.entries.set(id, {
    username,
    snapshots: {
      vscode: { username, entries: { 'github.copilot-github': username } }
    }
  })
}

function getSaved(id: string): Record<string, unknown> | undefined {
  return store.entries.get(id)
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

beforeEach(() => {
  store.entries.clear()
  vi.mocked(pollForToken).mockReset()
  vi.mocked(requestDeviceCode).mockReset().mockResolvedValue({
    device_code: 'device-code-test',
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    expires_in: 900,
    interval: 1
  })
})

describe('device flow login session (N2)', () => {
  it('verify OK → lưu githubLogin đúng, status sạch không cảnh báo', async () => {
    seedSlot('slot-ok')
    vi.mocked(pollForToken).mockResolvedValue({
      accessToken: 'ghu_verified',
      login: 'slotuser',
      loginVerified: true
    } satisfies GithubTokenResult)

    await startCopilotDeviceLogin('slot-ok')
    const status = await waitForCopilotDeviceLogin('slot-ok')

    expect(status.hasOwnToken).toBe(true)
    expect(status.username).toBe('slotuser')
    expect(status.message).toBeUndefined()
    expect(getSaved('slot-ok')?.githubToken).toBe('ghu_verified')
    expect(getSaved('slot-ok')?.githubLogin).toBe('slotuser')
  })

  it('token OK nhưng /user không verify được → githubLogin KHÔNG bị "đoán", status có cảnh báo ⚠', async () => {
    seedSlot('slot-unverified')
    vi.mocked(pollForToken).mockResolvedValue({
      accessToken: 'ghu_unverified',
      loginVerified: false
    } satisfies GithubTokenResult)

    await startCopilotDeviceLogin('slot-unverified')
    const status = await waitForCopilotDeviceLogin('slot-unverified')

    const saved = getSaved('slot-unverified')
    expect(saved?.githubToken).toBe('ghu_unverified')
    // N2: trước đây githubLogin = existing.username khi verify lỗi → metadata
    // khẳng định sai đã xác minh. Phải là undefined.
    expect(saved?.githubLogin).toBeUndefined()
    expect(status.hasOwnToken).toBe(true)
    expect(status.message).toContain('Chưa xác minh')
    expect(status.message).toContain('⚠')
  })

  it('slot chưa có auth Copilot → waitFor ném NGUYÊN NHÂN THẬT, không phải "thất bại hoặc bị hủy"', async () => {
    // Không seed slot — path save fail có chủ đích
    vi.mocked(pollForToken).mockResolvedValue({
      accessToken: 'ghu_x',
      login: 'someone',
      loginVerified: true
    } satisfies GithubTokenResult)

    await startCopilotDeviceLogin('slot-missing')
    await expect(waitForCopilotDeviceLogin('slot-missing')).rejects.toThrow(
      /Slot chưa có auth Copilot/
    )
  })

  it('phiên đang pending → start lần 2 bị chặn; cancel → cleanup OK', async () => {
    seedSlot('slot-pending')
    vi.mocked(pollForToken).mockImplementation(
      (_dc, _interval, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('Đã hủy đăng nhập GitHub')))
        })
    )

    await startCopilotDeviceLogin('slot-pending')
    await expect(startCopilotDeviceLogin('slot-pending')).rejects.toThrow(
      /Đang có phiên đăng nhập/
    )

    await cancelCopilotDeviceLogin('slot-pending')
    // Sau cancel: không còn phiên + chưa có token → waitFor báo rõ phải bắt đầu lại
    await expect(waitForCopilotDeviceLogin('slot-pending')).rejects.toThrow(
      /Không có phiên đăng nhập GitHub đang chạy/
    )
  })

  it('phiên đã settle nhưng UI chưa consume → start mới KHÔNG bị chặn bởi stale record', async () => {
    seedSlot('slot-stale')
    vi.mocked(pollForToken).mockResolvedValue({
      accessToken: 'ghu_stale',
      login: 'slotuser',
      loginVerified: true
    } satisfies GithubTokenResult)

    await startCopilotDeviceLogin('slot-stale')
    await delay(400) // để .then settle phiên mà không gọi waitFor

    const start2 = await startCopilotDeviceLogin('slot-stale')
    expect(start2.userCode).toBe('ABCD-1234')
  })

  it('R4 M1: phiên cũ finalize TRỄ khi map đã chứa phiên mới → phiên mới không bị xóa nhầm', async () => {
    seedSlot('slot-race')
    let resolvePoll2!: (result: GithubTokenResult) => void
    const poll2 = new Promise<GithubTokenResult>((resolve) => {
      resolvePoll2 = resolve
    })

    // Phiên 1: reject chỉ chạy khi abort VÀ delay 20ms — tái hiện đúng race
    // "catch của abort finalize SAU khi map đã có session mới" (kịch bản
    // waitFor-timeout/cancel + user bấm đăng nhập lại ngay trong review R4 M1).
    vi.mocked(pollForToken).mockImplementationOnce(
      (_dc, _interval, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            setTimeout(() => reject(new Error('Đã hủy đăng nhập GitHub')), 20)
          })
        })
    )
    vi.mocked(pollForToken).mockImplementationOnce(() => poll2)

    await startCopilotDeviceLogin('slot-race') // session 1 vào map
    await cancelCopilotDeviceLogin('slot-race') // abort + xóa map, catch còn chạy ngầm
    await startCopilotDeviceLogin('slot-race') // session 2 vào map

    await delay(80) // catch của session 1 chạy xong tại đây — guard identity
    // (pendingLogins.get === session) phải GIỮ LẠI session 2 trong map.
    // Bug cũ: delete vô điều kiện xóa session 2 → waitFor rơi vào nhánh
    // "Không có phiên pending" và ném lỗi mặc dù phiên mới đang chạy.

    const waiting = waitForCopilotDeviceLogin('slot-race')
    resolvePoll2({ accessToken: 'ghu_second', login: 'slotuser', loginVerified: true })
    const status = await waiting

    expect(status.hasOwnToken).toBe(true)
    expect(status.message).toBeUndefined()
    expect(getSaved('slot-race')?.githubToken).toBe('ghu_second')
  })

  it('R5 LOW 1: waitFor timeout + cancel/start phiên mới trong cửa sổ 500ms → phiên mới không bị xóa nhầm', async () => {
    // Chuỗi race đúng như R5 LOW 1 mô tả (dùng fake timers để không chờ 10 phút):
    // 1. waitFor hết 10 phút → abort session cũ → sleep 500ms chờ catch settle.
    // 2. Trong 500ms đó: IPC cancel (xóa map entry) + start phiên mới → map
    //    chứa session KHÁC.
    // 3. Sleep kết thúc, session cũ vẫn chưa settle → delete phải có guard
    //    identity, nếu không sẽ xóa nhầm session mới (cùng họ bug R4 M1).
    seedSlot('slot-timeout')
    vi.useFakeTimers()
    try {
      // Session 1: poll không bao giờ settle (kịch bản catch của abort chạy
      // sau timeout) → nhánh `!session.settled` sau sleep luôn kích hoạt.
      vi.mocked(pollForToken).mockImplementationOnce(() => new Promise<GithubTokenResult>(() => {}))
      let resolvePoll2!: (result: GithubTokenResult) => void
      vi.mocked(pollForToken).mockImplementationOnce(
        () =>
          new Promise<GithubTokenResult>((resolve) => {
            resolvePoll2 = resolve
          })
      )

      await startCopilotDeviceLogin('slot-timeout')
      const waiting1 = waitForCopilotDeviceLogin('slot-timeout')

      // 2400 lượt poll 250ms → hết 10 phút → abort + schedule sleep 500ms
      await vi.advanceTimersByTimeAsync(600_000)

      // Trong cửa sổ 500ms: cancel (clear map) rồi start phiên mới
      await cancelCopilotDeviceLogin('slot-timeout')
      await startCopilotDeviceLogin('slot-timeout')

      // Sleep kết thúc → session 1 chưa settle → guard identity phải GIỮ
      // session 2; waitFor cũ vẫn ném đúng lỗi timeout. Attach assertion
      // TRƯỚC khi advance để rejection không thành unhandled.
      const rejected1 = expect(waiting1).rejects.toThrow(/Hết thời gian chờ/)
      await vi.advanceTimersByTimeAsync(600)
      await rejected1

      // Phiên mới còn sống trong map: kết quả poll 2 phải tiêu thụ được.
      const waiting2 = waitForCopilotDeviceLogin('slot-timeout')
      resolvePoll2({ accessToken: 'ghu_after_timeout', login: 'slotuser', loginVerified: true })
      await vi.advanceTimersByTimeAsync(1_000) // flush .then(save) + poll loop
      const status2 = await waiting2

      expect(status2.hasOwnToken).toBe(true)
      expect(status2.message).toBeUndefined()
      expect(getSaved('slot-timeout')?.githubToken).toBe('ghu_after_timeout')
    } finally {
      vi.useRealTimers()
    }
  })

  it('R6 L6: cancel TRONG cửa sổ requestDeviceCode → placeholder bị abort, lần start sau không bị chặn', async () => {
    // Trước fix: session chỉ vào map SAU await requestDeviceCode() — cancel
    // chạy khi map còn trống là no-op → phiên âm thầm chạy 15 phút, lần bấm
    // sau gặp "Đang có phiên đăng nhập...". Sau fix: placeholder vào map ngay,
    // cancel abort nó → requestDeviceCode ném 'Đã hủy...' → catch settle +
    // guard-delete → map sạch.
    seedSlot('slot-startcancel')
    let rejectDevice!: (error: Error) => void
    const deviceGate = new Promise<never>((_, reject) => {
      rejectDevice = reject
    })
    vi.mocked(requestDeviceCode).mockImplementationOnce(() => deviceGate)

    const starting = startCopilotDeviceLogin('slot-startcancel') // placeholder vào map
    await cancelCopilotDeviceLogin('slot-startcancel') // cancel khi requestCode còn treo
    rejectDevice(new Error('Đã hủy đăng nhập GitHub')) // fetch văng theo abort
    await expect(starting).rejects.toThrow(/Đã hủy đăng nhập GitHub/)

    // Map sạch → lần start sau KHÔNG bị "Đang có phiên..." chặn nữa
    vi.mocked(pollForToken).mockResolvedValueOnce({
      accessToken: 'ghu_after_cancel',
      login: 'slotuser',
      loginVerified: true
    } satisfies GithubTokenResult)
    const start2 = await startCopilotDeviceLogin('slot-startcancel')
    expect(start2.userCode).toBe('ABCD-1234')
    const status = await waitForCopilotDeviceLogin('slot-startcancel')
    expect(status.hasOwnToken).toBe(true)
    expect(getSaved('slot-startcancel')?.githubToken).toBe('ghu_after_cancel')
  })

  it('R6 L6: start thứ 2 TRONG cửa sổ requestDeviceCode → bị chặn (placeholder đã vào map)', async () => {
    seedSlot('slot-doublestart')
    let resolveDevice!: (value: {
      device_code: string
      user_code: string
      verification_uri: string
      expires_in: number
      interval: number
    }) => void
    vi.mocked(requestDeviceCode).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDevice = resolve
        })
    )
    // pollForToken cần có implementation để .then của startCopilotDeviceLogin
    // không crash khi resolve device (treo vĩnh viễn — test chỉ quan tâm start)
    vi.mocked(pollForToken).mockImplementation(
      () => new Promise<GithubTokenResult>(() => {})
    )

    const starting = startCopilotDeviceLogin('slot-doublestart') // placeholder vào map
    // requestCode chưa resolve → start 2 thấy placeholder chưa settle → chặn
    await expect(startCopilotDeviceLogin('slot-doublestart')).rejects.toThrow(
      /Đang có phiên đăng nhập/
    )

    resolveDevice({
      device_code: 'device-code-2',
      user_code: 'ABCD-1234',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 1
    })
    await starting // start 1 hoàn tất bình thường
  })

  it('R7 M1: timeout + poll settle THEO ABORT của ta trong 500ms → vẫn ném lỗi timeout, không bị nuốt thành "Đã hủy"', async () => {
    // Hành vi THẬT của pollForToken từ R6 L5: abortableSleep + fetch nhận
    // signal → abort reject gần như ngay (<500ms) → catch handler set
    // session.error = 'Đã hủy đăng nhập GitHub'. Trước fix, waitFor đọc
    // session.error → ném 'Đã hủy...' → dialog so khớp message → nuốt lỗi im
    // lặng (kẹt trạng thái chờ).RED probe đã chứng minh trước khi fix.
    seedSlot('slot-r7-m1')
    vi.useFakeTimers()
    try {
      vi.mocked(pollForToken).mockImplementationOnce(
        (_deviceCode: string, _interval: number, signal?: AbortSignal) =>
          new Promise<GithubTokenResult>((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              reject(new Error('Đã hủy đăng nhập GitHub'))
            })
          })
      )

      await startCopilotDeviceLogin('slot-r7-m1')
      const waiting = waitForCopilotDeviceLogin('slot-r7-m1')
      const rejected = expect(waiting).rejects.toThrow(/Hết thời gian chờ/)

      // 10 phút loop → abort + sleep 500ms; poll reject theo abort NGAY tại
      // đây (catch handler đã chạy trước khi 500ms kết thúc).
      await vi.advanceTimersByTimeAsync(600_000)
      await vi.advanceTimersByTimeAsync(600)
      await rejected

      // Map phải sạch — phiên cũ không chặn start mới.
      vi.mocked(pollForToken).mockResolvedValueOnce({
        accessToken: 'ghu_after_r7m1',
        login: 'slotuser',
        loginVerified: true
      } satisfies GithubTokenResult)
      await startCopilotDeviceLogin('slot-r7-m1')
      const waiting2 = waitForCopilotDeviceLogin('slot-r7-m1')
      await vi.advanceTimersByTimeAsync(1_000) // flush .then(save) + poll loop
      const status = await waiting2
      expect(status.hasOwnToken).toBe(true)
      expect(getSaved('slot-r7-m1')?.githubToken).toBe('ghu_after_r7m1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('R7 M1 (không đổi semantics): settle THẬT do TA abort bằng error KHÁC (expired) → propagate nguyên nhân', async () => {
    // Lỗi không-phải-hủy settle đúng trong cửa sổ 500ms (vd expired_token
    // sát nút 10 phút) — fix chỉ nuốt ĐÚNG message hủy, không được biến mọi
    // lỗi trong cửa sổ thành timeout (giữ semantics N2 "ném đúng nguyên nhân").
    seedSlot('slot-r7-realerr')
    vi.useFakeTimers()
    try {
      vi.mocked(pollForToken).mockImplementationOnce(
        (_deviceCode: string, _interval: number, signal?: AbortSignal) =>
          new Promise<GithubTokenResult>((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              reject(new Error('Device code đã hết hạn. Hãy thử đăng nhập lại.'))
            })
          })
      )

      await startCopilotDeviceLogin('slot-r7-realerr')
      const waiting = waitForCopilotDeviceLogin('slot-r7-realerr')
      const rejected = expect(waiting).rejects.toThrow(/Device code đã hết hạn/)
      await vi.advanceTimersByTimeAsync(600_000)
      await vi.advanceTimersByTimeAsync(600)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })

  it('R7 M1: settle THÀNH CÔNG trong cửa sổ 500ms (user xong đúng lúc hết 10′) → trả status, không báo timeout', async () => {
    seedSlot('slot-r7-late')
    vi.useFakeTimers()
    try {
      vi.mocked(pollForToken).mockImplementationOnce(
        (_deviceCode: string, _interval: number, signal?: AbortSignal) =>
          new Promise<GithubTokenResult>((resolve) => {
            // Abort vì timeout, nhưng poll đã cầm token và resolve ngay sau đó
            // (50ms — trong cửa sổ 500ms). session.result set → path bình thường.
            signal?.addEventListener('abort', () => {
              setTimeout(
                () =>
                  resolve({
                    accessToken: 'ghu_last_second',
                    login: 'slotuser',
                    loginVerified: true
                  }),
                50
              )
            })
          })
      )

      await startCopilotDeviceLogin('slot-r7-late')
      const waiting = waitForCopilotDeviceLogin('slot-r7-late')
      await vi.advanceTimersByTimeAsync(600_000)
      await vi.advanceTimersByTimeAsync(600)
      const status = await waiting

      expect(status.hasOwnToken).toBe(true)
      expect(status.username).toBe('slotuser')
      expect(getSaved('slot-r7-late')?.githubToken).toBe('ghu_last_second')
    } finally {
      vi.useRealTimers()
    }
  })
})
