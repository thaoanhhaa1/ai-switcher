import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import {
  approveImportFile,
  consumeApprovedImportFile,
  getScopedJsonPath,
  isValidAccountId
} from '../../electron/main/safe-path'

const VALID_ACCOUNT_ID = '3f1d2c4b-5a6e-4f70-8b91-2c3d4e5f6a7b'
const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ai-switcher-safe-path-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('safe-path: accountId', () => {
  it('chỉ chấp nhận UUID hợp lệ', () => {
    expect(isValidAccountId(VALID_ACCOUNT_ID)).toBe(true)
    expect(isValidAccountId('../../evil')).toBe(false)
    expect(isValidAccountId('abc')).toBe(false)
    expect(isValidAccountId(null)).toBe(false)
  })

  it('không cho accountId thoát khỏi thư mục lưu trữ', () => {
    expect(getScopedJsonPath('/tmp/base', VALID_ACCOUNT_ID)).toBe(
      resolve('/tmp/base', `${VALID_ACCOUNT_ID}.json`)
    )
    expect(() => getScopedJsonPath('/tmp/base', '../../evil')).toThrow('accountId không hợp lệ')
  })
})

describe('safe-path: import file', () => {
  it('chỉ đọc được tệp đã chọn qua hộp thoại và chỉ dùng một lần', async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, 'auth.json')
    await writeFile(filePath, '{"ok":true}')

    const approvedPath = await approveImportFile(filePath)
    const consumed = await consumeApprovedImportFile(filePath)
    expect(consumed.path).toBe(approvedPath)
    expect(consumed.content).toBe('{"ok":true}')
    await expect(consumeApprovedImportFile(filePath)).rejects.toThrow(
      'Tệp chưa được chọn qua hộp thoại mở tệp'
    )
  })

  it('từ chối nếu tệp bị thay đổi nội dung sau khi chọn', async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, 'auth.json')
    await writeFile(filePath, '{"ok":true}')

    await approveImportFile(filePath)
    await writeFile(filePath, '{"ok":false}')

    await expect(consumeApprovedImportFile(filePath)).rejects.toThrow(
      'Tệp đã bị thay đổi sau khi chọn'
    )
  })

  it('từ chối tệp chưa được chọn hoặc không phải JSON', async () => {
    const dir = await makeTempDir()
    const jsonPath = join(dir, 'auth.json')
    const textPath = join(dir, 'auth.txt')
    await writeFile(jsonPath, '{}')
    await writeFile(textPath, '{}')

    await expect(consumeApprovedImportFile(jsonPath)).rejects.toThrow(
      'Tệp chưa được chọn qua hộp thoại mở tệp'
    )
    await expect(approveImportFile(textPath)).rejects.toThrow('Chỉ chấp nhận tệp JSON')
  })
})
