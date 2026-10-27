import { createHash } from 'crypto'
import { constants } from 'fs'
import { open, realpath, stat } from 'fs/promises'
import { dirname, extname, resolve } from 'path'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024
const IMPORT_APPROVAL_TTL_MS = 5 * 60 * 1000
const MAX_PENDING_IMPORT_APPROVALS = 32

interface ImportApproval {
  sha256: string
  dev: number
  ino: number
  size: number
  mtimeMs: number
  expiresAt: number
}

export interface ApprovedImportFile {
  path: string
  content: string
}

const approvedImportFiles = new Map<string, ImportApproval>()

export function isValidAccountId(id: unknown): id is string {
  return typeof id === 'string' && UUID_REGEX.test(id)
}

export function assertValidAccountId(id: unknown): asserts id is string {
  if (!isValidAccountId(id)) {
    throw new Error('accountId không hợp lệ')
  }
}

export function getScopedJsonPath(baseDir: string, accountId: string): string {
  assertValidAccountId(accountId)

  const resolvedBaseDir = resolve(baseDir)
  const filePath = resolve(resolvedBaseDir, `${accountId}.json`)
  if (dirname(filePath) !== resolvedBaseDir) {
    throw new Error('Đường dẫn tệp không hợp lệ')
  }

  return filePath
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function pruneExpiredApprovals(now: number): void {
  for (const [canonicalPath, approval] of approvedImportFiles) {
    if (approval.expiresAt <= now) {
      approvedImportFiles.delete(canonicalPath)
    }
  }
}

async function resolveReadableJsonFile(filePath: string): Promise<string> {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('Đường dẫn tệp không hợp lệ')
  }

  const canonicalPath = await realpath(resolve(filePath)).catch(() => {
    throw new Error('Tệp không tồn tại hoặc không thể truy cập')
  })

  if (extname(canonicalPath).toLowerCase() !== '.json') {
    throw new Error('Chỉ chấp nhận tệp JSON')
  }

  const info = await stat(canonicalPath).catch(() => {
    throw new Error('Không thể đọc thông tin tệp')
  })
  if (!info.isFile()) {
    throw new Error('Đường dẫn không phải tệp')
  }
  if (info.size > MAX_IMPORT_FILE_BYTES) {
    throw new Error('Tệp quá lớn để import')
  }

  return canonicalPath
}

async function readCanonicalJsonFile(
  canonicalPath: string
): Promise<{ content: string; dev: number; ino: number; size: number; mtimeMs: number }> {
  // O_NOFOLLOW chặn symlink swap sau bước realpath (không hỗ trợ trên Windows).
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  const handle = await open(canonicalPath, flags).catch(() => {
    throw new Error('Không thể đọc tệp')
  })

  try {
    const info = await handle.stat()
    if (!info.isFile()) {
      throw new Error('Đường dẫn không phải tệp')
    }
    if (info.size > MAX_IMPORT_FILE_BYTES) {
      throw new Error('Tệp quá lớn để import')
    }

    const content = await handle.readFile('utf-8')
    return {
      content,
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtimeMs: info.mtimeMs
    }
  } finally {
    await handle.close().catch(() => {})
  }
}

export async function approveImportFile(filePath: string): Promise<string> {
  const canonicalPath = await resolveReadableJsonFile(filePath)
  const { content, dev, ino, size, mtimeMs } = await readCanonicalJsonFile(canonicalPath)

  const now = Date.now()
  pruneExpiredApprovals(now)
  if (approvedImportFiles.size >= MAX_PENDING_IMPORT_APPROVALS) {
    const oldest = approvedImportFiles.keys().next().value
    if (oldest !== undefined) {
      approvedImportFiles.delete(oldest)
    }
  }

  approvedImportFiles.set(canonicalPath, {
    sha256: sha256(content),
    dev,
    ino,
    size,
    mtimeMs,
    expiresAt: now + IMPORT_APPROVAL_TTL_MS
  })

  return canonicalPath
}

export async function consumeApprovedImportFile(filePath: string): Promise<ApprovedImportFile> {
  const canonicalPath = await resolveReadableJsonFile(filePath)
  const approval = approvedImportFiles.get(canonicalPath)

  if (!approval || approval.expiresAt <= Date.now()) {
    approvedImportFiles.delete(canonicalPath)
    throw new Error('Tệp chưa được chọn qua hộp thoại mở tệp')
  }

  approvedImportFiles.delete(canonicalPath)

  const { content, dev, ino, size, mtimeMs } = await readCanonicalJsonFile(canonicalPath)
  if (dev !== approval.dev || ino !== approval.ino || size !== approval.size || mtimeMs !== approval.mtimeMs) {
    throw new Error('Tệp đã bị thay đổi sau khi chọn')
  }
  if (sha256(content) !== approval.sha256) {
    throw new Error('Nội dung tệp đã bị thay đổi sau khi chọn')
  }

  return { path: canonicalPath, content }
}
