import { chmod, mkdir, readFile, writeFile } from 'fs/promises'
import { safeStorage } from 'electron'

const ENCRYPTED_MARKER = '__aiSwitcherEncrypted'
const ENCRYPTED_VERSION = 1

interface EncryptedJsonEnvelope {
  [ENCRYPTED_MARKER]: number
  payload: string
}

/** Mọi thư mục chứa dữ liệu nhạy cảm chỉ cho phép user hiện tại truy cập (0700). */
export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700).catch(() => undefined)
}

/** Ghi tệp plaintext (cho app bên thứ ba đọc) nhưng vẫn owner-only (0600). */
export async function writePrivateFile(path: string, data: string): Promise<void> {
  await writeFile(path, data, { mode: 0o600 })
  await chmod(path, 0o600).catch(() => undefined)
}

export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function secureStorageError(reason: string): Error {
  return new Error(`Không thể mã hóa dữ liệu: ${reason}`)
}

function assertEncryptionAvailable(): void {
  if (!isEncryptionAvailable()) {
    throw secureStorageError('OS keychain không khả dụng')
  }

  if (process.platform !== 'linux') return

  let backend: string
  try {
    backend = safeStorage.getSelectedStorageBackend()
  } catch {
    throw secureStorageError('OS keychain không khả dụng')
  }

  if (backend === 'basic_text') {
    throw secureStorageError('OS keychain không an toàn (basic_text)')
  }
  if (backend === 'unknown') {
    throw secureStorageError('OS keychain chưa sẵn sàng')
  }
}

function isEncryptedEnvelope(value: unknown): value is EncryptedJsonEnvelope {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    candidate[ENCRYPTED_MARKER] === ENCRYPTED_VERSION &&
    typeof candidate.payload === 'string'
  )
}

export function encodeSecureJson(value: unknown): string {
  assertEncryptionAvailable()

  const json = JSON.stringify(value, null, 2)
  let payload: string
  try {
    payload = safeStorage.encryptString(json).toString('base64')
  } catch {
    throw secureStorageError('OS keychain gặp lỗi')
  }

  return JSON.stringify(
    {
      [ENCRYPTED_MARKER]: ENCRYPTED_VERSION,
      payload
    },
    null,
    2
  )
}

export function decodeSecureJson<T>(raw: string): { value: T; encrypted: boolean } {
  const parsed = JSON.parse(raw) as unknown
  if (!isEncryptedEnvelope(parsed)) {
    return { value: parsed as T, encrypted: false }
  }

  if (!isEncryptionAvailable()) {
    throw new Error('Không thể giải mã dữ liệu: OS keychain không khả dụng')
  }

  return {
    value: JSON.parse(
      safeStorage.decryptString(Buffer.from(parsed.payload, 'base64'))
    ) as T,
    encrypted: true
  }
}

export async function readSecureJson<T>(path: string): Promise<T | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    return null
  }

  const decoded = decodeSecureJson<T>(raw)
  if (!decoded.encrypted && isEncryptionAvailable()) {
    await writeSecureJson(path, decoded.value).catch(() => undefined)
  }

  return decoded.value
}

export async function writeSecureJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, encodeSecureJson(value), { mode: 0o600 })
  await chmod(path, 0o600)
}
