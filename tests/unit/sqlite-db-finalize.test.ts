// R5 LOW 2: finalize (CLI driver) chỉ được xóa sidecar -wal/-shm khi checkpoint
// THỰC SỰ hoàn tất (busy=0). Kiểm chứng thực nghiệm (2026-09-11): khi process
// khác còn giữ WAL read-snapshot, `sqlite3 db "PRAGMA wal_checkpoint(TRUNCATE)"`
// NOT throw — exit 0, stdout "1|log|checkpointed" với busy=1. Do đó guard phải
// đọc cột busy, không thể dựa vào exception.
// R6: flip default nhánh "output không parse được" → GIỮ sidecar (L1, đối xứng
// với native); thêm test busy timeout `.timeout` + translateBusyError (L2) và
// BEGIN/COMMIT bọc batch (INFO 4).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// best-sqlite3 trong vitest node env: require() load JS OK nhưng `new Database`
// nổ ABI mismatch (binary build cho Electron) → loadNativeSqlite không catch
// được tại thời điểm chọn driver. Mô phỏng đúng e2e fallback suite: chặn
// require('better-sqlite3') ngay từ Module._load để force sqlite3-cli driver.
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
  return {
    ...actual,
    execFile: vi.fn()
  }
})

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    access: vi.fn(async (path: string) => {
      if (String(path).endsWith('-wal') || String(path).endsWith('-shm')) return
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }),
    unlink: vi.fn(async () => undefined)
  }
})

import { execFile } from 'child_process'
import { unlink } from 'fs/promises'
import { getSqliteDriver } from '../../electron/main/sqlite-db'

// better-sqlite3 require fail trong test env (ABI Electron) → driver CLI.
// Mock execFile mô phỏng từng kịch bản theo command đã gọi.
// Lưu ý: promisify(execFile) generic resolve với arg đầu tiên của callback →
// phải trả object { stdout, stderr } để `const { stdout } = await ...` khớp.
// R6 L2: signature mới của sqliteCliQuery là
//   execFile('sqlite3', [dbPath, '.timeout 10000', sql])
// — args[0] = dbPath, args[1] = dot-command, args[2] = SQL.
function stubExecFile(handler: (file: string, args: string[]) => { stdout?: string; error?: unknown }): void {
  vi.mocked(execFile).mockImplementation(((
    file: string,
    args: string[],
    _options: unknown,
    callback: (error: unknown, result?: { stdout: string; stderr: string }) => void
  ) => {
    const result = handler(file, args)
    if (result.error) {
      callback(result.error)
    } else {
      callback(null, { stdout: result.stdout ?? '', stderr: '' })
    }
    return { unref: () => undefined } as never
  }) as never)
}

const BUSY_TIMEOUT_ARG = '.timeout 10000'

beforeEach(async () => {
  vi.mocked(execFile).mockReset()
  vi.mocked(unlink).mockClear()
})

describe('sqlite-db finalize — CLI driver (R5 LOW 2)', () => {
  it('checkpoint busy=1 (process khác giữ WAL): KHÔNG được xóa -wal/-shm', async () => {
    stubExecFile((file, args) => {
      if (args[0] === '--version') return { stdout: '3.45.0' }
      if (String(args[2]).includes('wal_checkpoint')) return { stdout: '1|3|0\n' }
      return { stdout: '' }
    })

    const driver = await getSqliteDriver()
    expect(driver.name).toBe('sqlite3-cli')
    await driver.finalize('/tmp/whatever.vscdb')

    expect(unlink).not.toHaveBeenCalled()
  })

  it('checkpoint busy=0 (thành công): xóa -wal/-shm', async () => {
    stubExecFile((file, args) => {
      if (args[0] === '--version') return { stdout: '3.45.0' }
      if (String(args[2]).includes('wal_checkpoint')) return { stdout: '0|3|3\n' }
      return { stdout: '' }
    })

    const driver = await getSqliteDriver()
    await driver.finalize('/tmp/whatever.vscdb')

    expect(unlink).toHaveBeenCalledTimes(2) // -wal + -shm (access mock cho tồn tại)
  })

  it('R6 L1: checkpoint output bất ngờ (không parse được) → GIỮ sidecar (đối xứng default native)', async () => {
    stubExecFile((file, args) => {
      if (args[0] === '--version') return { stdout: '3.45.0' }
      if (String(args[2]).includes('wal_checkpoint')) return { stdout: '\n' }
      return { stdout: '' }
    })

    const driver = await getSqliteDriver()
    await driver.finalize('/tmp/whatever.vscdb')
    expect(unlink).not.toHaveBeenCalled()
  })

  it('exec sqlite3 fail hẳn (DB corrupt/locked) → GIỮ sidecar, không nuốt rồi dọn', async () => {
    stubExecFile((file, args) => {
      if (args[0] === '--version') return { stdout: '3.45.0' }
      if (String(args[2]).includes('wal_checkpoint')) {
        return { error: new Error('file is not a database (26)') }
      }
      return { stdout: '' }
    })

    const driver = await getSqliteDriver()
    await driver.finalize('/tmp/whatever.vscdb')
    expect(unlink).not.toHaveBeenCalled()
  })
})

describe('sqlite-db deleteValues — CLI driver (R5 INFO 1 + R6)', () => {
  it('trả đúng số dòng xóa tổng hợp từ SELECT changes()', async () => {
    stubExecFile((file, args) => {
      if (args[0] === '--version') return { stdout: '3.45.0' }
      const sql = String(args[2] ?? '')
      if (sql.includes('DELETE')) {
        // 3 câu DELETE: 2 key thật sự có dòng (changes=1), 1 key trống (0)
        return { stdout: '1\n0\n1\n' }
      }
      return { stdout: '' }
    })

    const driver = await getSqliteDriver()
    const deleted = await driver.deleteValues('/tmp/x.vscdb', ['a', 'b', 'c'])
    expect(deleted).toBe(2)

    // keys rỗng → 0, không spawn sqlite3
    vi.mocked(execFile).mockClear()
    const empty = await driver.deleteValues('/tmp/x.vscdb', [])
    expect(empty).toBe(0)
    expect(execFile).not.toHaveBeenCalled()
  })

  it('R6 INFO 4: batch DELETE được bọc BEGIN/COMMIT (atomic — CLI chết giữa chừng thì SQLite rollback)', async () => {
    stubExecFile((file, args) => {
      if (args[0] === '--version') return { stdout: '3.45.0' }
      const sql = String(args[2] ?? '')
      if (sql.includes('DELETE')) return { stdout: '1\n' }
      return { stdout: '' }
    })

    const driver = await getSqliteDriver()
    await driver.deleteValues('/tmp/x.vscdb', ['a'])

    const sql = String(vi.mocked(execFile).mock.calls.at(-1)?.[1]?.[2] ?? '')
    expect(sql.startsWith('BEGIN;')).toBe(true)
    expect(sql.endsWith('COMMIT;')).toBe(true)
  })
})

describe('sqlite-db CLI — busy timeout + lỗi busy dịch tiếng Việt (R6 L2)', () => {
  it('mọi sqliteCliQuery đều kèm dot-command .timeout 10000 (giống busy_timeout native)', async () => {
    stubExecFile((file, args) => {
      if (args[0] === '--version') return { stdout: '3.45.0' }
      const sql = String(args[2] ?? '')
      if (sql.includes('wal_checkpoint')) return { stdout: '0|0|0\n' }
      return { stdout: '' }
    })

    const driver = await getSqliteDriver()
    await driver.finalize('/tmp/x.vscdb')
    await driver.listKeys('/tmp/x.vscdb', 'github-%')

    for (const call of vi.mocked(execFile).mock.calls) {
      const args = call[1] as string[]
      if (args[0] === '--version') continue // probe getSqliteDriver, không phải query
      expect(args[1]).toBe(BUSY_TIMEOUT_ARG)
    }
  })

  it('lỗi "database is locked" từ CLI được dịch sang message tiếng Việt như native', async () => {
    stubExecFile((file, args) => {
      if (args[0] === '--version') return { stdout: '3.45.0' }
      return { error: Object.assign(new Error('Error: database is locked'), { code: 1 }) }
    })

    const driver = await getSqliteDriver()
    await expect(driver.listKeys('/tmp/x.vscdb', 'github-%')).rejects.toThrow(
      /state\.vscdb đang bị khóa/
    )
  })
})
