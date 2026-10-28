vi.mock('../../electron/main/env', () => ({
  shouldApplyAntigravityIde: () => true
}))

vi.mock('../../electron/main/sqlite-db', () => ({
  getSqliteDriver: vi.fn(),
  fileExists: vi.fn(async () => false),
  backupDatabase: vi.fn(async () => ''),
  withDbLock: vi.fn(async (_dbPath: string, fn: () => Promise<unknown>) => fn())
}))

import { homedir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import {
  buildAntigravityKeyringPassword,
  buildAntigravityTokenStorePayload,
  getAntigravityStandaloneTokenPath
} from '../../electron/main/antigravity-ide'

const entry = {
  email: 'user@example.com',
  refreshToken: 'refresh-token-1'
}

describe('buildAntigravityTokenStorePayload', () => {
  it('tạo token store JSON đúng format mà Antigravity 2.x đọc từ keychain/file', () => {
    const now = Date.UTC(2026, 0, 2, 3, 4, 5)
    const payload = buildAntigravityTokenStorePayload(
      entry,
      { accessToken: 'access-token-1', expiresIn: 3600 },
      now
    )

    expect(JSON.parse(payload)).toEqual({
      token: {
        access_token: 'access-token-1',
        token_type: 'Bearer',
        refresh_token: 'refresh-token-1',
        expiry: new Date(now + 3600 * 1000).toISOString(),
        expires_in: 3600
      },
      auth_method: 'consumer',
      id_token_email: 'user@example.com'
    })
  })

  it('expiresIn tối thiểu 300 giây và làm tròn xuống', () => {
    const now = Date.UTC(2026, 0, 2, 3, 4, 5)
    const payload = buildAntigravityTokenStorePayload(
      entry,
      { accessToken: 'a', expiresIn: 12.9 },
      now
    )
    const parsed = JSON.parse(payload)
    expect(parsed.token.expires_in).toBe(300)
    expect(parsed.token.expiry).toBe(new Date(now + 300 * 1000).toISOString())
  })

  it('throw khi thiếu email vì keychain cần id_token_email', () => {
    expect(() =>
      buildAntigravityTokenStorePayload(
        { refreshToken: 'r' },
        { accessToken: 'a', expiresIn: 3600 }
      )
    ).toThrow(/thiếu email/i)
  })
})

describe('buildAntigravityKeyringPassword', () => {
  it('dùng prefix go-keyring-base64 mà agy/go-keyring mong đợi', () => {
    const password = buildAntigravityKeyringPassword('{"token":{}}')
    expect(password.startsWith('go-keyring-base64:')).toBe(true)
    expect(Buffer.from(password.slice('go-keyring-base64:'.length), 'base64').toString()).toBe(
      '{"token":{}}'
    )
  })
})

describe('getAntigravityStandaloneTokenPath', () => {
  it('trỏ tới ~/.gemini/jetski-standalone-oauth-token', () => {
    expect(getAntigravityStandaloneTokenPath()).toBe(
      join(homedir(), '.gemini', 'jetski-standalone-oauth-token')
    )
  })
})
