import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const safeStorageMock = vi.hoisted(() => {
  const state = { available: true }
  return {
    state,
    encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`, 'utf-8')),
    decryptString: vi.fn((buffer: Buffer) => {
      const raw = buffer.toString('utf-8')
      if (!raw.startsWith('enc:')) throw new Error('invalid ciphertext')
      return raw.slice(4)
    }),
    isEncryptionAvailable: vi.fn(() => state.available)
  }
})

vi.mock('electron', () => ({ safeStorage: safeStorageMock }))

import {
  decodeSecureJson,
  encodeSecureJson,
  readSecureJson,
  writeSecureJson
} from '../../electron/main/secure-storage'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ai-switcher-secure-storage-'))
  safeStorageMock.state.available = true
  safeStorageMock.encryptString.mockClear()
  safeStorageMock.decryptString.mockClear()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('secure storage', () => {
  it('mã hóa và giải mã JSON qua safeStorage', () => {
    const encoded = encodeSecureJson({ accessToken: 'secret-token' })
    expect(encoded).not.toContain('secret-token')
    expect(decodeSecureJson<{ accessToken: string }>(encoded)).toEqual({
      value: { accessToken: 'secret-token' },
      encrypted: true
    })
    expect(safeStorageMock.encryptString).toHaveBeenCalledTimes(1)
    expect(safeStorageMock.decryptString).toHaveBeenCalledTimes(1)
  })

  it('đọc được JSON plaintext cũ và tự động mã hóa lại', async () => {
    const path = join(dir, 'legacy.json')
    await writeFile(path, JSON.stringify({ cookieHeader: 'session=abc' }, null, 2), 'utf-8')

    await expect(readSecureJson<{ cookieHeader: string }>(path)).resolves.toEqual({
      cookieHeader: 'session=abc'
    })

    const raw = await readFile(path, 'utf-8')
    expect(raw).not.toContain('session=abc')
    expect(decodeSecureJson<{ cookieHeader: string }>(raw).encrypted).toBe(true)
  })

  it('ghi file với quyền 0o600', async () => {
    const path = join(dir, 'auth.json')
    await writeSecureJson(path, { refreshToken: 'refresh-token' })

    const info = await stat(path)
    expect(info.mode & 0o777).toBe(0o600)
  })

  it('từ chối mã hóa thay vì fallback plaintext khi OS keychain không khả dụng', () => {
    safeStorageMock.state.available = false

    expect(() => encodeSecureJson({ apiKey: 'key-123' })).toThrow(
      'OS keychain không khả dụng'
    )
  })

  it('từ chối ghi file khi OS keychain không khả dụng', async () => {
    safeStorageMock.state.available = false
    const path = join(dir, 'auth.json')

    await expect(writeSecureJson(path, { refreshToken: 'secret' })).rejects.toThrow(
      'OS keychain không khả dụng'
    )
  })

  it('từ chối mã hóa thay vì fallback plaintext khi encryptString lỗi', () => {
    safeStorageMock.encryptString.mockImplementationOnce(() => {
      throw new Error('encrypt failed')
    })

    expect(() => encodeSecureJson({ apiKey: 'key-123' })).toThrow('OS keychain gặp lỗi')
  })

  it('từ chối giải mã envelope khi OS keychain không khả dụng', () => {
    const encoded = encodeSecureJson({ refreshToken: 'secret' })
    safeStorageMock.state.available = false

    expect(() => decodeSecureJson(encoded)).toThrow('OS keychain không khả dụng')
  })
})
