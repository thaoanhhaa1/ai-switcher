const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
// ==== Simulate máy CHƯA rebuild: ném lỗi khi require better-sqlite3 ====
const Module = require('node:module')
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'better-sqlite3') {
    throw new Error('NODE_MODULE_VERSION mismatch (simulated)')
  }
  return origLoad.apply(this, arguments)
}

const {
  getActiveDriverName,
  readCopilotUsername,
  collectCopilotEntries,
  filterEntriesForApply,
  assertImportableGithubAccount,
  applyCopilotEntries
} = require(process.env.DRIVER_BUNDLE || './bundle.cjs')

let passed = 0, failed = 0
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name) }
  catch (e) { failed++; console.log('  ✗', name, '—', e.message.slice(0, 140)) }
}

function makeDb() {
  const dbPath = path.join(os.tmpdir(), `fix-review-${Date.now()}-${Math.random().toString(36).slice(2)}.vscdb`)
  fs.writeFileSync(dbPath, '')
  const sh = (sql) => execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8' })
  sh("CREATE TABLE ItemTable (key TEXT PRIMARY KEY ON CONFLICT REPLACE, value BLOB);")
  return { dbPath, sh }
}

const AUTH_KEY = 'secret://{"extensionId":"vscode.github-authentication","key":"github.auth"}'

async function main() {
  const { dbPath, sh } = makeDb()
  sh(`INSERT INTO ItemTable VALUES ('github.copilot-github', 'testuser');`)
  sh(`INSERT INTO ItemTable VALUES ('${AUTH_KEY.replace(/'/g, "''")}', 'tok123');`)

  const driverName = await getActiveDriverName()
  console.log('driver =', driverName, '(fallback test)')

  // ===== Reads qua public API =====
  // R6 L7: label cũ copy từ native suite gây hiểu lầm khi đọc log — driver
  // của suite này là sqlite3-cli (require better-sqlite3 bị giả lập fail).
  await t('driver name = sqlite3-cli (native require fail → fallback)', async () => {
    assert.equal(driverName, 'sqlite3-cli')
  })
  await t('assertImportableGithubAccount: đọc username + auth từ DB thật', async () => {
    const username = await assertImportableGithubAccount(dbPath)
    assert.equal(username, 'testuser')
  })
  await t('assertImportableGithubAccount: sai username → lỗi tiếng Việt có tên', async () => {
    await assert.rejects(() => assertImportableGithubAccount(dbPath, 'otheruser'), /otheruser/)
  })
  await t('assertImportableGithubAccount: DB không tồn tại → lỗi', async () => {
    await assert.rejects(() => assertImportableGithubAccount('/tmp/nope-missing.vscdb'))
  })
  await t('readCopilotUsername: DB thiếu username → null', async () => {
    const { dbPath: db2 } = makeDb()
    assert.equal(await readCopilotUsername(db2), null)
  })
  await t('collectCopilotEntries: gom đủ static keys + auth', async () => {
    const { username, entries } = await collectCopilotEntries(dbPath)
    assert.equal(username, 'testuser')
    assert.equal(entries[AUTH_KEY], 'tok123')
    assert.equal(entries['github.copilot-github'], 'testuser')
  })

  // ===== Writes/Deletes qua applyCopilotEntries (parameterized native path) =====
  await t('applyCopilotEntries: ghi entry chứa quote/newline/unicode + username đúng', async () => {
    const trickyAuth = 'eyJhbGciOiJFUzI1NiJ9."qu\"ote\'\nnew-line-🚀'
    await applyCopilotEntries(dbPath, {
      [AUTH_KEY]: trickyAuth,
      'github.copilot-github': 'testuser',
      'github-testuser-usages': '{"n":9}',
      'random-key': 'SHOULD_NOT_BE_APPLIED'
    }, 'testuser')
    const entries = (await collectCopilotEntries(dbPath)).entries
    assert.equal(entries[AUTH_KEY], trickyAuth, 'auth tricky được ghi đúng nguyên vẹn')
    assert.equal(entries['github-testuser-usages'], '{"n":9}')
    assert.equal(entries['random-key'], undefined, 'key lạ không được apply')
  })
  await t('applyCopilotEntries: xóa entry của username khác (switch sạch)', async () => {
    sh(`INSERT INTO ItemTable VALUES ('github-otheruser-usages', 'stale');`)
    await applyCopilotEntries(dbPath, { [AUTH_KEY]: 'tok123' }, 'testuser')
    const all = execFileSync('sqlite3', [dbPath, 'SELECT key FROM ItemTable;'], { encoding: 'utf8' })
    assert.ok(!all.includes('github-otheruser'), 'entry user cũ phải bị clear')
  })

  // ===== N1: applyCopilotEntries TỰ finalize (WAL checkpoint + dọn sidecar) =====
  await t('N1: apply trên DB WAL → không còn -wal/-shm tồn đọng, data đọc lại đúng', async () => {
    const { dbPath: walDb, sh: shW } = makeDb()
    shW('PRAGMA journal_mode=WAL;')
    shW(`INSERT INTO ItemTable VALUES ('github.copilot-github', 'waluser');`)
    await applyCopilotEntries(walDb, { [AUTH_KEY]: 'wal-token' }, 'waluser')
    assert.ok(!fs.existsSync(walDb + '-wal'), 'WAL sidecar phải được checkpoint + xóa sau apply')
    assert.ok(!fs.existsSync(walDb + '-shm'), 'SHM sidecar phải được xóa sau apply')
    const entries = (await collectCopilotEntries(walDb)).entries
    assert.equal(entries[AUTH_KEY], 'wal-token', 'data vẫn đọc đúng sau finalize')
    fs.rmSync(walDb, { force: true })
  })

  // ===== R5 LOW 2: checkpoint busy (process ngoài giữ WAL) → GIỮ sidecar =====
  // Kiểm chứng thực nghiệm: CLI wal_checkpoint(TRUNCATE) khi bị chặn trả exit 0
  // + stdout "1|log|ckpt" (busy=1, KHÔNG throw) → guard phải đọc cột busy.
  // (CLI không có busy timeout mặc định → busy tức thì, test nhanh.)
  await t('R5 LOW 2: reader ngoài giữ WAL snapshot → finalize busy → giữ -wal, data nguyên vẹn', async () => {
    const { dbPath: busyDb, sh: shB } = makeDb()
    shB('PRAGMA journal_mode=WAL;')
    shB(`INSERT INTO ItemTable VALUES ('github.copilot-github', 'busyuser');`)

    const reader = require('node:child_process').spawn('sqlite3', [busyDb], {
      stdio: ['pipe', 'ignore', 'ignore']
    })
    reader.on('error', () => undefined)
    reader.stdin.write('BEGIN;\nSELECT count(*) FROM ItemTable;\n')
    await new Promise((r) => setTimeout(r, 500)) // reader kịp lấy read snapshot

    await applyCopilotEntries(busyDb, { [AUTH_KEY]: 'busy-token' }, 'busyuser')
    assert.ok(
      fs.existsSync(busyDb + '-wal'),
      'checkpoint blocked → -wal phải được GIỮ LẠI (chứa frame đã commit, chưa flush)'
    )
    const entriesBusy = (await collectCopilotEntries(busyDb)).entries
    assert.equal(entriesBusy[AUTH_KEY], 'busy-token', 'đọc xuyên WAL: token đã commit không mất')

    // applyCopilotEntries đã return ⇒ finalize đã chạy xong (busy). Nhả reader
    // → lượt apply kế tiếp hết contention → checkpoint OK → sidecar được dọn.
    reader.stdin.write('COMMIT;\n')
    reader.stdin.end()
    await new Promise((r) => reader.on('close', r))
    await applyCopilotEntries(busyDb, { [AUTH_KEY]: 'busy-token' }, 'busyuser')
    assert.ok(!fs.existsSync(busyDb + '-wal'), 'hết contention → finalize dọn sạch sidecar')
    const entriesAfter = (await collectCopilotEntries(busyDb)).entries
    assert.equal(entriesAfter[AUTH_KEY], 'busy-token', 'data bền vững sau checkpoint thật')
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(busyDb + suffix, { force: true })
  })

  // ===== R6 INFO 4: batch write/delete bọc BEGIN/COMMIT — atomic trên CLI =====
  await t('R6 INFO 4: write batch fail giữa dòng → SQLite rollback toàn batch', async () => {
    const { dbPath: atDb, sh: shA } = makeDb()
    // Câu SQL thứ 2 văng lỗi thật ("no such table") giữa transaction →
    // process sqlite3 exit 1 → implicit rollback → row 1 KHÔNG được ghi.
    // (Lưu ý: CAST(readfile(...)) với file thiếu chỉ trả NULL, không lỗi —
    // đã kiểm chứng, không dùng để fake fail.)
    const sql =
      'BEGIN;\n' +
      `INSERT INTO ItemTable VALUES ('ok-key', 'first');\n` +
      `INSERT INTO NoSuchTable VALUES ('bad-key', 'x');\n` +
      'COMMIT;'
    const runBatch = () =>
      new Promise((resolve, reject) => {
        require('node:child_process').execFile('sqlite3', [atDb, sql], (error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    await assert.rejects(runBatch)
    const rows = shA(`SELECT key FROM ItemTable;`)
    assert.ok(!rows.includes('ok-key'), 'rollback: row đầu TIÊU sau khi batch fail')
    assert.ok(!rows.includes('bad-key'), 'row fail không tồn tại')
    fs.rmSync(atDb, { force: true })
  })

  // ===== R6 L2: busy timeout + message tiếng Việt khi DB bị IDE giữ =====
  await t('R6 L2: write khi DB bị giữ → chờ busy timeout rồi trả lỗi tiếng Việt (không còn raw English)', async () => {
    const { dbPath: lockDb, sh: shL } = makeDb()
    shL('PRAGMA journal_mode=WAL;')
    shL(`INSERT INTO ItemTable VALUES ('github.copilot-github', 'lockuser');`)

    // Writer ngoài giữ EXCLUSIVE lock bằng BEGIN IMMEDIATE (không nhả)
    const writer = require('node:child_process').spawn('sqlite3', [lockDb], {
      stdio: ['pipe', 'ignore', 'ignore']
    })
    writer.on('error', () => undefined)
    writer.stdin.write('BEGIN IMMEDIATE;\n')
    await new Promise((r) => setTimeout(r, 500)) // writer kịp giữ lock

    const started = Date.now()
    // writeValues giờ qua applyCopilotEntries (batch DELETE+INSERT bọc transaction).
    // Reader giữ snapshot đọc được WAL nhưng DELETE cần write lock → phải chờ
    // .timeout 10000 (CLI) / busy_timeout 10000 (native) → hết hạn → throw.
    await assert.rejects(
      () => applyCopilotEntries(lockDb, { [AUTH_KEY]: 'lock-token' }, 'lockuser'),
      (error) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.ok(
          /state\.vscdb đang bị khóa/.test(message),
          `message phải dịch tiếng Việt, nhận: ${message.slice(0, 160)}`
        )
        return true
      }
    )
    // Đã qua busy timeout (không fail tức thì như bản thiếu .timeout)
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 3000, `phải chờ busy timeout trước khi báo lỗi (elapsed ${elapsed}ms)`)

    writer.stdin.write('ROLLBACK;\n')
    writer.stdin.end()
    await new Promise((r) => writer.on('close', r))
    fs.rmSync(lockDb, { force: true })
  })

  // ===== JSONC: C1 — settings.json có comment KHÔNG bị wipe (test qua jsonc-parser trực tiếp) =====
  await t('jsonc modify: chèn preferredAccount giữ nguyên comment (C1)', () => {
    const { modify, applyEdits, parse } = require('jsonc-parser')
    const raw = `{\n  // editor theme của user\n  "workbench.colorTheme": "Default Dark",\n  "editor.fontSize": 14\n}`
    const parsed = parse(raw)
    assert.equal(typeof parsed, 'object', 'jsonc parse OK với comment')
    const edits = modify(raw, ['github.copilot.preferredAccount'], 'testuser', { formattingOptions: { tabSize: 4, insertSpaces: true, eol: '\n' } })
    const next = applyEdits(raw, edits)
    assert.ok(next.includes('// editor theme của user'), 'comment phải còn nguyên')
    assert.ok(next.includes('"workbench.colorTheme"'), 'settings cũ phải còn nguyên')
    assert.ok(next.includes('"github.copilot.preferredAccount": "testuser"'), 'key mới được chèn')
  })
  await t('jsonc parse: input rác → undefined (không throw) → code phải skip write', () => {
    const { parse } = require('jsonc-parser')
    assert.equal(parse('this is not json at all <<<'), undefined)
  })

  // ===== filterEntriesForApply: giữ đúng key =====
  await t('filterEntriesForApply: giữ auth + username key, loại key lạ', () => {
    const filtered = filterEntriesForApply({
      [AUTH_KEY]: 'tok',
      'github.copilot-github': 'stale-user',
      'github-otheruser': 'x',
      'github-testuser-usages': 'u',
      'random-key': 'v'
    }, 'testuser')
    assert.deepEqual(Object.keys(filtered).sort(), [AUTH_KEY, 'github.copilot-github', 'github-testuser-usages'].sort())
    assert.equal(filtered['github.copilot-github'], 'testuser', 'WORKSPACE_USERNAME_KEY được ghi đè bằng username slot')
  })

  // ===== Multi-line value read-back (L4) qua collectCopilotEntries =====
  await t('read value nhiều dòng không bị cắt (L4)', async () => {
    sh(`INSERT INTO ItemTable VALUES ('github.copilot-github', 'testuser');`)
    sh(`INSERT OR REPLACE INTO ItemTable VALUES ('github-testuser-usages', 'line1
line2
line3');`)
    const entries = (await collectCopilotEntries(dbPath)).entries
    assert.equal(entries['github-testuser-usages'], 'line1\nline2\nline3')
  })

  fs.rmSync(dbPath, { force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}
main().catch(e => { console.error('FATAL', e); process.exit(1) })
