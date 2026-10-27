import { unlink } from 'fs/promises'
import { join } from 'path'
import type { FreeModelLoginStatus } from '../../src/types'
import { getAppDataDir } from './paths'
import { getScopedJsonPath } from './safe-path'
import { ensurePrivateDir, readSecureJson, writeSecureJson } from './secure-storage'

export const FREEMODEL_DASHBOARD_URL = 'https://freemodel.dev'

interface FreeModelUser {
  email?: string
  id?: string
  name?: string
}

interface FreeModelSession {
  accountId: string
  email: string
  cookieHeader: string
  user?: FreeModelUser
  updatedAt: string
}

interface OtpPendingState {
  email: string
  cookieHeader: string
  createdAt: number
  attempts: number
}

const otpPending = new Map<string, OtpPendingState>()
const otpLockouts = new Map<string, number>()
const otpEmailQueues = new Map<string, Promise<void>>()
const OTP_TTL_MS = 15 * 60 * 1000
const OTP_MAX_ATTEMPTS = 5
const OTP_LOCKOUT_MS = 15 * 60 * 1000

function withOtpEmailLock<T>(email: string, task: () => Promise<T>): Promise<T> {
  const previous = otpEmailQueues.get(email) ?? Promise.resolve()
  const run = previous.then(task)
  const tracked = run.then(
    () => undefined,
    () => undefined
  )
  otpEmailQueues.set(email, tracked)
  void tracked.finally(() => {
    if (otpEmailQueues.get(email) === tracked) {
      otpEmailQueues.delete(email)
    }
  })
  return run
}

function getSessionsDir(): string {
  return join(getAppDataDir(), 'freemodel-sessions')
}

function getSessionPath(accountId: string): string {
  return getScopedJsonPath(getSessionsDir(), accountId)
}

function cookiePairsFromHeader(cookieHeader: string): Map<string, string> {
  const pairs = new Map<string, string>()
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    pairs.set(trimmed.slice(0, eq), trimmed.slice(eq + 1))
  }
  return pairs
}

function headerFromPairs(pairs: Map<string, string>): string {
  return [...pairs.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
}

function mergeCookieHeaders(current: string, setCookies: string[]): string {
  const pairs = cookiePairsFromHeader(current)
  for (const cookie of setCookies) {
    const pair = cookie.split(';')[0]?.trim()
    if (!pair) continue
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    pairs.set(pair.slice(0, eq), pair.slice(eq + 1))
  }
  return headerFromPairs(pairs)
}

function extractSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie()
  }

  const raw = response.headers.get('set-cookie')
  return raw ? [raw] : []
}

async function freemodelRequest(
  path: string,
  init: RequestInit & { cookieHeader?: string }
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json')
  }
  if (init.cookieHeader) {
    headers.set('Cookie', init.cookieHeader)
  }

  return fetch(`${FREEMODEL_DASHBOARD_URL}${path}`, {
    ...init,
    headers
  })
}

async function loadSession(accountId: string): Promise<FreeModelSession | null> {
  try {
    return await readSecureJson<FreeModelSession>(getSessionPath(accountId))
  } catch {
    return null
  }
}

async function saveSession(session: FreeModelSession): Promise<void> {
  await ensurePrivateDir(getSessionsDir())
  await writeSecureJson(getSessionPath(session.accountId), session)
}

export async function clearFreeModelSession(accountId: string): Promise<void> {
  try {
    await unlink(getSessionPath(accountId))
  } catch {
    // ignore missing file
  }
}

function cleanupExpiredOtp(): void {
  const now = Date.now()
  for (const [email, state] of otpPending.entries()) {
    if (now - state.createdAt > OTP_TTL_MS) {
      otpPending.delete(email)
    }
  }
  for (const [email, lockedUntil] of otpLockouts.entries()) {
    if (now >= lockedUntil) {
      otpLockouts.delete(email)
    }
  }
}

function getOtpLockoutRemainingMs(email: string): number {
  const lockedUntil = otpLockouts.get(email)
  if (!lockedUntil) return 0

  const remaining = lockedUntil - Date.now()
  if (remaining <= 0) {
    otpLockouts.delete(email)
    return 0
  }

  return remaining
}

function lockoutMessage(remainingMs: number): string {
  const minutes = Math.max(1, Math.ceil(remainingMs / 60000))
  return `Bạn đã nhập sai OTP quá ${OTP_MAX_ATTEMPTS} lần. Vui lòng thử lại sau ${minutes} phút.`
}

export function sendFreeModelOtp(email: string): Promise<{ success: boolean; message: string }> {
  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) {
    return Promise.resolve({ success: false, message: 'Nhập email FreeModel' })
  }

  return withOtpEmailLock(normalizedEmail, () => sendFreeModelOtpLocked(normalizedEmail))
}

async function sendFreeModelOtpLocked(
  normalizedEmail: string
): Promise<{ success: boolean; message: string }> {
  cleanupExpiredOtp()

  const remainingLockoutMs = getOtpLockoutRemainingMs(normalizedEmail)
  if (remainingLockoutMs > 0) {
    return { success: false, message: lockoutMessage(remainingLockoutMs) }
  }

  try {
    const response = await freemodelRequest('/api/auth/send-otp', {
      method: 'POST',
      body: JSON.stringify({ email: normalizedEmail })
    })

    const payload = (await response.json().catch(() => ({}))) as { error?: string }
    if (!response.ok) {
      return { success: false, message: payload.error ?? 'Không thể gửi mã OTP' }
    }

    const setCookies = extractSetCookies(response)
    const previousAttempts = otpPending.get(normalizedEmail)?.attempts ?? 0
    otpPending.set(normalizedEmail, {
      email: normalizedEmail,
      cookieHeader: mergeCookieHeaders('', setCookies),
      createdAt: Date.now(),
      attempts: previousAttempts
    })

    return { success: true, message: 'Đã gửi mã OTP tới email của bạn' }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Lỗi mạng'
    return { success: false, message: `Không thể gửi OTP: ${message}` }
  }
}

export function verifyFreeModelOtp(
  accountId: string,
  email: string,
  code: string
): Promise<{ success: boolean; message: string; loginStatus?: FreeModelLoginStatus }> {
  const normalizedEmail = email.trim().toLowerCase()
  const normalizedCode = code.replace(/\D/g, '').slice(0, 6)

  if (!normalizedEmail || normalizedCode.length < 6) {
    return Promise.resolve({ success: false, message: 'Nhập email và mã OTP 6 số' })
  }

  return withOtpEmailLock(normalizedEmail, () =>
    verifyFreeModelOtpLocked(accountId, normalizedEmail, normalizedCode)
  )
}

async function verifyFreeModelOtpLocked(
  accountId: string,
  normalizedEmail: string,
  normalizedCode: string
): Promise<{ success: boolean; message: string; loginStatus?: FreeModelLoginStatus }> {
  cleanupExpiredOtp()

  const remainingLockoutMs = getOtpLockoutRemainingMs(normalizedEmail)
  if (remainingLockoutMs > 0) {
    return { success: false, message: lockoutMessage(remainingLockoutMs) }
  }

  const pending = otpPending.get(normalizedEmail)
  if (!pending) {
    return { success: false, message: 'OTP đã hết hạn. Vui lòng gửi lại mã.' }
  }

  if (pending.attempts >= OTP_MAX_ATTEMPTS) {
    otpPending.delete(normalizedEmail)
    otpLockouts.set(normalizedEmail, Date.now() + OTP_LOCKOUT_MS)
    return { success: false, message: lockoutMessage(OTP_LOCKOUT_MS) }
  }

  pending.attempts += 1
  const attempt = pending.attempts

  try {
    const response = await freemodelRequest('/api/auth/verify-otp', {
      method: 'POST',
      cookieHeader: pending.cookieHeader,
      body: JSON.stringify({ email: normalizedEmail, code: normalizedCode })
    })

    const payload = (await response.json().catch(() => ({}))) as {
      error?: string
      user?: FreeModelUser
    }

    if (!response.ok || !payload.user) {
      if (attempt >= OTP_MAX_ATTEMPTS) {
        otpPending.delete(normalizedEmail)
        otpLockouts.set(normalizedEmail, Date.now() + OTP_LOCKOUT_MS)
        return { success: false, message: lockoutMessage(OTP_LOCKOUT_MS) }
      }

      const remainingAttempts = OTP_MAX_ATTEMPTS - attempt
      const baseMessage = payload.error ?? 'Mã OTP không hợp lệ'
      return {
        success: false,
        message: `${baseMessage} (còn ${remainingAttempts} lần thử)`
      }
    }

    const cookieHeader = mergeCookieHeaders(pending.cookieHeader, extractSetCookies(response))
    const session: FreeModelSession = {
      accountId,
      email: normalizedEmail,
      cookieHeader,
      user: payload.user,
      updatedAt: new Date().toISOString()
    }

    await saveSession(session)
    otpPending.delete(normalizedEmail)
    otpLockouts.delete(normalizedEmail)

    return {
      success: true,
      message: 'Đăng nhập FreeModel thành công',
      loginStatus: {
        loggedIn: true,
        email: payload.user.email ?? normalizedEmail,
        userId: payload.user.id,
        updatedAt: session.updatedAt
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Lỗi mạng'
    return { success: false, message: `Không thể xác thực OTP: ${message}` }
  }
}

export async function getFreeModelLoginStatus(accountId: string): Promise<FreeModelLoginStatus> {
  const session = await loadSession(accountId)
  if (!session?.cookieHeader) {
    return { loggedIn: false }
  }

  try {
    const response = await freemodelRequest('/api/auth/me', {
      method: 'GET',
      cookieHeader: session.cookieHeader
    })

    if (response.status === 401) {
      await clearFreeModelSession(accountId)
      return { loggedIn: false }
    }

    if (!response.ok) {
      return {
        loggedIn: false,
        email: session.email,
        message: 'Không thể xác minh phiên đăng nhập'
      }
    }

    const payload = (await response.json()) as { user?: FreeModelUser }
    const user = payload.user

    if (!user) {
      await clearFreeModelSession(accountId)
      return { loggedIn: false }
    }

    const nextCookieHeader = mergeCookieHeaders(session.cookieHeader, extractSetCookies(response))
    const updated: FreeModelSession = {
      ...session,
      cookieHeader: nextCookieHeader,
      user,
      updatedAt: new Date().toISOString()
    }
    await saveSession(updated)

    return {
      loggedIn: true,
      email: user.email ?? session.email,
      userId: user.id,
      updatedAt: updated.updatedAt
    }
  } catch {
    return {
      loggedIn: false,
      email: session.email,
      message: 'Không thể kiểm tra phiên đăng nhập'
    }
  }
}

export async function logoutFreeModel(accountId: string): Promise<void> {
  const session = await loadSession(accountId)
  if (session?.cookieHeader) {
    await freemodelRequest('/api/auth/logout', {
      method: 'POST',
      cookieHeader: session.cookieHeader
    }).catch(() => undefined)
  }

  await clearFreeModelSession(accountId)
}

export async function fetchFreeModelUsageWithSession(accountId: string): Promise<Response | null> {
  const session = await loadSession(accountId)
  if (!session?.cookieHeader) {
    return null
  }

  const response = await freemodelRequest('/api/usage', {
    method: 'GET',
    cookieHeader: session.cookieHeader
  })

  if (response.status === 401) {
    await clearFreeModelSession(accountId)
    return null
  }

  if (!response.ok) {
    return null
  }

  const nextCookieHeader = mergeCookieHeaders(session.cookieHeader, extractSetCookies(response))
  if (nextCookieHeader !== session.cookieHeader) {
    await saveSession({
      ...session,
      cookieHeader: nextCookieHeader,
      updatedAt: new Date().toISOString()
    })
  }

  return response
}
