import { execFile } from 'child_process'
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { promisify } from 'util'
import type DatabaseType from 'better-sqlite3'

const execFileAsync = promisify(execFile)

/**
 * Dual SQLite driver dùng chung (copilot-ide / antigravity-ide):
 *
 * - Primary: better-sqlite3 (native, parameterized, cross-platform, busy_timeout)
 *   cần `npm run rebuild:native` để build đúng ABI Electron; chưa rebuild thì load fail.
 * - Fallback: sqlite3 CLI (không python3, không lsof) — read qua writefile()/temp file
 *   để byte-exact, write qua readfile() + CAST AS TEXT. Batch (writeValues/
 *   deleteValues) bọc BEGIN/COMMIT cho atomic; busy timeout 10s qua dot-command
 *   `.timeout` + lỗi busy được dịch sang tiếng Việt như driver native (R6 L2/INFO 4).
 *
 * Mọi thao tác serialize theo dbPath bằng promise-chain mutex (CODE_REVIEW M7).
 */

export interface SqliteDriver {
  readonly name: 'better-sqlite3' | 'sqlite3-cli'
  ensureSchema(dbPath: string): Promise<void>
  readValue(dbPath: string, key: string): Promise<string | null>
  writeValue(dbPath: string, key: string, value: string): Promise<void>
  writeValues(dbPath: string, entries: Record<string, string>): Promise<void>
  /** Xóa theo keys, trả về SỐ DÒNG thực sự bị xóa (R5 INFO 1: caller cần biết
   * có mutation thật hay không để quyết định finalize). */
  deleteValues(dbPath: string, keys: string[]): Promise<number>
  listKeys(dbPath: string, likePattern: string): Promise<string[]>
  finalize(dbPath: string): Promise<void>
}

export function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''")
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Native driver (better-sqlite3)
// ---------------------------------------------------------------------------

type DatabaseCtor = typeof DatabaseType
type DatabaseInstance = InstanceType<DatabaseCtor>

let cachedDatabase: DatabaseCtor | null | undefined

function loadNativeSqlite(): DatabaseCtor | null {
  if (cachedDatabase === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('better-sqlite3') as DatabaseCtor | { default: DatabaseCtor }
      cachedDatabase = 'default' in mod ? mod.default : mod
    } catch {
      // ABI mismatch (chưa chạy `npm run rebuild:native`) hoặc thiếu binary
      cachedDatabase = null
    }
  }
  return cachedDatabase
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return String(value)
}

function translateBusyError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  if (/locked|busy/i.test(message)) {
    throw new Error('state.vscdb đang bị khóa (IDE chưa đóng hẳn). Hãy đóng IDE rồi thử lại.')
  }
  throw error instanceof Error ? error : new Error(message)
}

function createNativeDriver(Database: DatabaseCtor): SqliteDriver {
  function open(dbPath: string, readonly: boolean): DatabaseInstance {
    const db = Database(dbPath, { readonly })
    db.pragma('busy_timeout = 10000')
    return db
  }

  return {
    name: 'better-sqlite3',
    async ensureSchema(dbPath) {
      let db: DatabaseInstance | undefined
      try {
        db = open(dbPath, false)
        db.exec(
          'CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY ON CONFLICT REPLACE, value BLOB)'
        )
      } catch (error) {
        translateBusyError(error)
      } finally {
        db?.close()
      }
    },
    async readValue(dbPath, key) {
      let db: DatabaseInstance | undefined
      try {
        db = open(dbPath, true)
        const row = db
          .prepare('SELECT value FROM ItemTable WHERE key = ? LIMIT 1')
          .get(key) as { value: unknown } | undefined
        return row === undefined ? null : toText(row.value)
      } catch (error) {
        translateBusyError(error)
      } finally {
        db?.close()
      }
    },
    async writeValue(dbPath, key, value) {
      await this.writeValues(dbPath, { [key]: value })
    },
    async writeValues(dbPath, entries) {
      let db: DatabaseInstance | undefined
      try {
        db = open(dbPath, false)
        const insert = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)')
        const run = db.transaction((rows: Array<[string, string]>) => {
          for (const [key, value] of rows) insert.run(key, value)
        })
        run(Object.entries(entries))
      } catch (error) {
        translateBusyError(error)
      } finally {
        db?.close()
      }
    },
    async deleteValues(dbPath, keys) {
      let deleted = 0
      let db: DatabaseInstance | undefined
      try {
        db = open(dbPath, false)
        const del = db.prepare('DELETE FROM ItemTable WHERE key = ?')
        const run = db.transaction((rows: string[]) => {
          let total = 0
          for (const key of rows) total += del.run(key).changes
          return total
        })
        deleted = run(keys)
      } catch (error) {
        translateBusyError(error)
      } finally {
        db?.close()
      }
      return deleted
    },
    async listKeys(dbPath, likePattern) {
      let db: DatabaseInstance | undefined
      try {
        db = open(dbPath, true)
        const rows = db
          .prepare("SELECT key FROM ItemTable WHERE key LIKE ? ESCAPE '\\'")
          .all(likePattern) as Array<{ key: string }>
        return rows.map((row) => row.key)
      } catch (error) {
        translateBusyError(error)
      } finally {
        db?.close()
      }
    },
    async finalize(dbPath) {
      let checkpointComplete = false
      let db: DatabaseInstance | undefined
      try {
        db = open(dbPath, false)
        // R5 LOW 2: `wal_checkpoint(TRUNCATE)` KHÔNG ném lỗi khi process khác
        // (IDE) còn đang giữ WAL — nó trả về hàng đợi kết quả với cột busy=1
        // (đã kiểm chứng: better-sqlite3 trả [{busy:1, log:1, checkpointed:0}]).
        // Xóa -wal/-shm khi busy=1 sẽ vứt các transaction đã commit nhưng chưa
        // checkpoint của process ngoài → DB lệch state. Chỉ dọn khi busy=0
        // (checkpoint hoàn tất, hoặc DB không ở WAL mode: busy=0/log=-1 và
        // sidecar vốn không tồn tại → remove là no-op an toàn).
        const rows = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy?: number }>
        checkpointComplete = Number(rows[0]?.busy ?? 1) === 0
      } catch {
        // Mở DB fail (corrupt/locked hẳn/quyền ghi) → GIỮ sidecar, không dọn
        // nửa vời; caller sẽ thấy lỗi thật qua thao tác kế tiếp.
      } finally {
        db?.close()
      }
      if (checkpointComplete) await removeWalSidecars(dbPath)
    }
  }
}

// ---------------------------------------------------------------------------
// CLI driver (fallback — chỉ cần sqlite3 CLI, KHÔNG python3)
// ---------------------------------------------------------------------------

/**
 * SQLite busy timeout (ms) cho cả 2 driver — native qua `busy_timeout` pragma,
 * CLI qua dot-command `.timeout` (dot-command hoạt động ở batch mode, đã kiểm
 * chứng thực tế: `sqlite3 db ".timeout 10000" "INSERT ..."` chạy bình thường).
 * Tránh raw "database is locked" (R6 L2) khi VS Code còn giữ DB.
 */
const SQLITE_BUSY_TIMEOUT_MS = 10_000

async function sqliteCliQuery(dbPath: string, sql: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'sqlite3',
    // Dot-command `.timeout` đặt busy timeout cho CÁC câu SQL sau nó trong
    // cùng tiến trình sqlite3 (giống busy_timeout của driver native).
    [dbPath, `.timeout ${SQLITE_BUSY_TIMEOUT_MS}`, sql],
    {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024
    }
  ).catch((error) => translateBusyError(error))
  return stdout
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ai-switcher-sqlite-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

function createCliDriver(): SqliteDriver {
  return {
    name: 'sqlite3-cli',
    async ensureSchema(dbPath) {
      await sqliteCliQuery(
        dbPath,
        'CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY ON CONFLICT REPLACE, value BLOB);'
      )
    },
    async readValue(dbPath, key) {
      // writefile() giữ nguyên byte — tránh hỏng value có newline qua stdout
      return withTempDir(async (dir) => {
        const outPath = join(dir, 'out')
        await sqliteCliQuery(
          dbPath,
          `SELECT writefile('${escapeSqlString(outPath)}', value) FROM ItemTable WHERE key = '${escapeSqlString(key)}' LIMIT 1;`
        )
        if (!(await fileExists(outPath))) return null
        return readFile(outPath, 'utf8')
      })
    },
    async writeValue(dbPath, key, value) {
      await this.writeValues(dbPath, { [key]: value })
    },
    async writeValues(dbPath, entries) {
      await withTempDir(async (dir) => {
        const statements: string[] = []
        let index = 0
        for (const [key, value] of Object.entries(entries)) {
          const valuePath = join(dir, `value-${index}.txt`)
          await writeFile(valuePath, value, 'utf8')
          statements.push(
            `INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('${escapeSqlString(
              key
            )}', CAST(readfile('${escapeSqlString(valuePath)}') AS TEXT));`
          )
          index += 1
        }
        if (statements.length) {
          // R6 INFO 4: bọc batch trong transaction — sqlite3 CLI exit≠0 giữa
          // dòng thì process chết trước COMMIT → SQLite implicit rollback toàn
          // batch, không còn trạng thái "cleared-but-not-applied" nửa vời.
          await sqliteCliQuery(dbPath, `BEGIN;\n${statements.join('\n')}\nCOMMIT;`)
        }
      })
    },
    async deleteValues(dbPath, keys) {
      if (!keys.length) return 0
      // R5 INFO 1: kèm SELECT changes() để biết số dòng xóa thật (finalize gate)
      const statements = keys.map(
        (key) =>
          `DELETE FROM ItemTable WHERE key = '${escapeSqlString(key)}';\nSELECT changes();`
      )
      // R6 INFO 4: bọc batch trong transaction (giống writeValues) — all-or-nothing.
      const output = await sqliteCliQuery(dbPath, `BEGIN;\n${statements.join('\n')}\nCOMMIT;`)
      let deleted = 0
      for (const line of output.split('\n')) {
        const count = Number.parseInt(line.trim(), 10)
        if (Number.isFinite(count)) deleted += count
      }
      return deleted
    },
    async listKeys(dbPath, likePattern) {
      const output = await sqliteCliQuery(
        dbPath,
        `SELECT key FROM ItemTable WHERE key LIKE '${escapeSqlString(likePattern)}' ESCAPE '\\';`
      )
      return output.split('\n').filter(Boolean)
    },
    async finalize(dbPath) {
      // R5 LOW 2: giống driver native — CLI không ném lỗi khi checkpoint bị
      // chặn, nó in kết quả "busy|log|checkpointed" với busy=1 (đã kiểm chứng
      // exit 0, stdout "1|1|0"). Chỉ dọn sidecar khi busy=0.
      let checkpointComplete = false
      try {
        const stdout = await sqliteCliQuery(dbPath, 'PRAGMA wal_checkpoint(TRUNCATE);')
        const busy = Number.parseInt(stdout.trim().split('|')[0] ?? '', 10)
        // R6 L1: DB đang ở WAL mode luôn in "busy|log|ckpt" nên output không
        // parse được chỉ đến từ (a) sqlite3 quá cũ không hỗ trợ WAL-checkpoint
        // (in rỗng — DB khi đó cũng không có sidecar để dọn) hoặc (b) format
        // lạ. Hướng an toàn cho (b) là GIỮ — đối xứng với default của native
        // (thiếu hàng đợi → busy=1 → giữ).
        checkpointComplete = Number.isNaN(busy) ? false : busy === 0
      } catch {
        checkpointComplete = false
      }
      if (checkpointComplete) await removeWalSidecars(dbPath)
    }
  }
}

let cachedDriver: SqliteDriver | null = null
let sqliteCliChecked = false

export async function getSqliteDriver(): Promise<SqliteDriver> {
  if (cachedDriver) return cachedDriver

  const Database = loadNativeSqlite()
  if (Database) {
    cachedDriver = createNativeDriver(Database)
    return cachedDriver
  }

  if (!sqliteCliChecked) {
    sqliteCliChecked = true
    try {
      await execFileAsync('sqlite3', ['--version'], { encoding: 'utf8' })
    } catch {
      throw new Error(
        'Cần better-sqlite3 (chạy `npm run rebuild:native`) hoặc cài sqlite3 CLI để thao tác state.vscdb'
      )
    }
  }

  cachedDriver = createCliDriver()
  return cachedDriver
}

async function removeWalSidecars(dbPath: string): Promise<void> {
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${dbPath}${suffix}`
    if (await fileExists(sidecar)) {
      await unlink(sidecar).catch(() => undefined)
    }
  }
}

// ---------------------------------------------------------------------------
// Per-DB mutex — serialize mọi thao tác trên cùng một state.vscdb
// ---------------------------------------------------------------------------

const dbLocks = new Map<string, Promise<unknown>>()

export function withDbLock<T>(dbPath: string, fn: () => Promise<T>): Promise<T> {
  const previous = dbLocks.get(dbPath) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const tail = run.then(
    () => {
      if (dbLocks.get(dbPath) === tail) dbLocks.delete(dbPath)
    },
    () => {
      if (dbLocks.get(dbPath) === tail) dbLocks.delete(dbPath)
    }
  )
  dbLocks.set(dbPath, tail)
  return run
}

// ---------------------------------------------------------------------------
// Timestamped backup + prune (giữ BACKUP_KEEP bản gần nhất)
// ---------------------------------------------------------------------------

const BACKUP_PREFIX = 'state.vscdb.ai-switcher-'
const BACKUP_SUFFIX = '.bak'
const BACKUP_KEEP = 5

export async function backupDatabase(dbPath: string): Promise<string> {
  const dir = dirname(dbPath)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = join(dir, `${BACKUP_PREFIX}${stamp}${BACKUP_SUFFIX}`)

  // R8 L4: copyFile một mình KHÔNG kèm sidecar -wal/-shm — nếu phiên IDE trước
  // chết cứng (SIGKILL/crash) để lại transaction đã commit trong WAL, bản backup
  // mất chúng (restore lùi state). finalize = wal_checkpoint(TRUNCATE) gộp toàn
  // bộ WAL vào main DB + dọn sidecar trước khi copy. Cả 2 driver đều nuốt lỗi
  // checkpoint (busy/corrupt → GIỮ sidecar, backup vẫn chạy như trước — không
  // regression; caller luôn gọi trong withDbLock nên không ai giữ WAL lúc này).
  const driver = await getSqliteDriver()
  await driver.finalize(dbPath)

  await copyFile(dbPath, backupPath)

  try {
    const siblings = await readdir(dir)
    const backups = siblings
      .filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith(BACKUP_SUFFIX))
      .sort()
      .reverse()
    for (const stale of backups.slice(BACKUP_KEEP)) {
      await unlink(join(dir, stale)).catch(() => undefined)
    }
  } catch {
    // prune thất bại không chặn switch
  }

  return backupPath
}
