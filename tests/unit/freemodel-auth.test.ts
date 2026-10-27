import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({
  safeStorage: {
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf-8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf-8').slice(4),
    isEncryptionAvailable: () => true
  }
}))

import { sendFreeModelOtp, verifyFreeModelOtp } from '../../electron/main/freemodel-auth'

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111'

let dir: string
let fetchMock: ReturnType<typeof vi.fn>

function jsonResponse(body: unknown, status = 200, setCookie?: string): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (setCookie) headers.set('set-cookie', setCookie)
  return new Response(JSON.stringify(body), { status, headers })
}

function mockVerifyFailure(): void {
  fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Mã OTP không hợp lệ' }, 400))
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ai-switcher-freemodel-auth-'))
  process.env.AI_SWITCHER_DATA_DIR = dir
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  delete process.env.AI_SWITCHER_DATA_DIR
  await rm(dir, { recursive: true, force: true })
})

async function requestOtp(email: string): Promise<void> {
  fetchMock.mockResolvedValueOnce(
    jsonResponse({ ok: true }, 200, 'freemodel_session=abc; Path=/; HttpOnly')
  )
  const result = await sendFreeModelOtp(email)
  expect(result.success).toBe(true)
}

describe('freemodel OTP rate limiting', () => {
  it('khóa tạm thời sau 5 lần nhập sai liên tiếp', async () => {
    const email = 'bruteforce@example.com'
    await requestOtp(email)

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      mockVerifyFailure()
      const result = await verifyFreeModelOtp(ACCOUNT_ID, email, '000000')
      expect(result.success).toBe(false)
      expect(result.message).toContain(`còn ${5 - attempt} lần thử`)
    }

    mockVerifyFailure()
    const locked = await verifyFreeModelOtp(ACCOUNT_ID, email, '000000')
    expect(locked.success).toBe(false)
    expect(locked.message).toContain('quá 5 lần')

    const verifyWhileLocked = await verifyFreeModelOtp(ACCOUNT_ID, email, '123456')
    expect(verifyWhileLocked.success).toBe(false)
    expect(verifyWhileLocked.message).toContain('thử lại sau')

    const resendWhileLocked = await sendFreeModelOtp(email)
    expect(resendWhileLocked.success).toBe(false)
    expect(resendWhileLocked.message).toContain('thử lại sau')
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  it('không cho request đồng thời vượt quá giới hạn', async () => {
    const email = 'concurrent@example.com'
    await requestOtp(email)

    fetchMock.mockImplementation(async () =>
      jsonResponse({ error: 'Mã OTP không hợp lệ' }, 400)
    )

    const results = await Promise.all(
      Array.from({ length: 10 }, () => verifyFreeModelOtp(ACCOUNT_ID, email, '000000'))
    )

    expect(results.every((result) => result.success === false)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1 + 5)
  })

  it('không reset số lần thử khi gửi lại OTP', async () => {
    const email = 'resend@example.com'
    await requestOtp(email)

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      mockVerifyFailure()
      const result = await verifyFreeModelOtp(ACCOUNT_ID, email, '000000')
      expect(result.success).toBe(false)
    }

    await requestOtp(email)

    mockVerifyFailure()
    const locked = await verifyFreeModelOtp(ACCOUNT_ID, email, '000000')
    expect(locked.success).toBe(false)
    expect(locked.message).toContain('quá 5 lần')
    expect(fetchMock).toHaveBeenCalledTimes(1 + 4 + 1 + 1)
  })

  it('đăng nhập thành công trước giới hạn không bị ảnh hưởng', async () => {
    const email = 'success@example.com'
    await requestOtp(email)

    mockVerifyFailure()
    const failed = await verifyFreeModelOtp(ACCOUNT_ID, email, '000000')
    expect(failed.success).toBe(false)

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ user: { id: 'u1', email } }, 200, 'freemodel_session=def')
    )
    const success = await verifyFreeModelOtp(ACCOUNT_ID, email, '123456')
    expect(success.success).toBe(true)
    expect(success.loginStatus?.loggedIn).toBe(true)
  })
})
