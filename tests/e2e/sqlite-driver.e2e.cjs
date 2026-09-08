const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
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
  console.log('driver =', driverName)

  // ===== Reads qua public API =====
  await t('driver name = better-sqlite3 (sau rebuild:native)', async () => {
    assert.equal(driverName, 'better-sqlite3')
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

  // ===== JSONC: C1 — settings.json có comment KHÔNG bị wipe (test qua jsonc-parser trực tiếp) =====
  await t('jsonc modify: chèn preferredAccount giữ nguyên comment (C1)', () => {
    const { modify, applyEdits, parse } = require('/Users/thaoanhhaa1/Documents/IT/Personal/Projects/ai-switcher/node_modules/jsonc-parser')
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
    const { parse } = require('/Users/thaoanhhaa1/Documents/IT/Personal/Projects/ai-switcher/node_modules/jsonc-parser')
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
