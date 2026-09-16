import { execFile } from 'child_process'
import { mkdir, readdir, readFile, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser'
import { backupDatabase, fileExists, getSqliteDriver, withDbLock } from './sqlite-db'
import { shouldApplyCopilotIde } from './env'

const execFileAsync = promisify(execFile)

export type CopilotIdeTarget = 'vscode' | 'vscode-insiders' | 'cursor'

export interface CopilotIdeInfo {
  target: CopilotIdeTarget
  appName: string
  dbPath: string
}

export interface CopilotIdeApplyResult {
  applied: boolean
  targets: CopilotIdeTarget[]
  message?: string
}

const GITHUB_AUTH_SECRET_KEY =
  'secret://{"extensionId":"vscode.github-authentication","key":"github.auth"}'

const COPILOT_CHAT_KEY = 'GitHub.copilot-chat'
const WORKSPACE_USERNAME_KEY = 'github.copilot-github'

const STATIC_KEYS = [
  GITHUB_AUTH_SECRET_KEY,
  'vscode.github',
  'vscode.github-authentication',
  COPILOT_CHAT_KEY,
  WORKSPACE_USERNAME_KEY,
  'vscode.github-github',
  'defaultAccount.cachedPolicyData'
]

const STATIC_PREFIXES = ['extensionsAssignmentFilterProvider.copilot']

const USERNAME_KEYS = ['github.copilot-github', 'vscode.github-github']

/**
 * Cho phép trỏ DB của target 'vscode' vào file khác (test/dev sandbox):
 * COPILOT_IDE_DB_PATH=/path/to/state.vscdb
 */
function getIdeDbPathOverride(): string | null {
  const value = process.env.COPILOT_IDE_DB_PATH?.trim()
  return value || null
}

function getIdeDefinitions(): Array<CopilotIdeInfo> {
  const home = homedir()
  let definitions: Array<CopilotIdeInfo>

  if (process.platform === 'darwin') {
    definitions = [
      {
        target: 'vscode',
        appName: 'Visual Studio Code',
        dbPath: join(home, 'Library/Application Support/Code/User/globalStorage/state.vscdb')
      },
      {
        target: 'vscode-insiders',
        appName: 'Visual Studio Code - Insiders',
        dbPath: join(
          home,
          'Library/Application Support/Code - Insiders/User/globalStorage/state.vscdb'
        )
      },
      {
        target: 'cursor',
        appName: 'Cursor',
        dbPath: join(home, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb')
      }
    ]
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    definitions = [
      {
        target: 'vscode',
        appName: 'Code',
        dbPath: join(appData, 'Code', 'User', 'globalStorage', 'state.vscdb')
      },
      {
        target: 'vscode-insiders',
        appName: 'Code - Insiders',
        dbPath: join(appData, 'Code - Insiders', 'User', 'globalStorage', 'state.vscdb')
      },
      {
        target: 'cursor',
        appName: 'Cursor',
        dbPath: join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb')
      }
    ]
  } else {
    definitions = [
      {
        target: 'vscode',
        appName: 'code',
        dbPath: join(home, '.config/Code/User/globalStorage/state.vscdb')
      },
      {
        target: 'vscode-insiders',
        appName: 'code-insiders',
        dbPath: join(home, '.config/Code - Insiders/User/globalStorage/state.vscdb')
      },
      {
        target: 'cursor',
        appName: 'cursor',
        dbPath: join(home, '.config/Cursor/User/globalStorage/state.vscdb')
      }
    ]
  }

  const override = getIdeDbPathOverride()
  if (override) {
    const vscode = definitions.find((definition) => definition.target === 'vscode')
    if (vscode) {
      vscode.dbPath = override
    }
  }

  return definitions
}

export function getCopilotIdeCandidates(): CopilotIdeInfo[] {
  return getIdeDefinitions()
}

// ---------------------------------------------------------------------------
// High-level helpers (driver-based)
// ---------------------------------------------------------------------------

/** Tên driver SQLite đang dùng — cho test + log debug ('better-sqlite3' | 'sqlite3-cli'). */
export async function getActiveDriverName(): Promise<string> {
  const driver = await getSqliteDriver()
  return driver.name
}

async function readDbValue(dbPath: string, key: string): Promise<string | null> {
  const driver = await getSqliteDriver()
  return driver.readValue(dbPath, key)
}

async function listMatchingKeys(dbPath: string, likePattern: string): Promise<string[]> {
  const driver = await getSqliteDriver()
  return driver.listKeys(dbPath, likePattern)
}

async function finalizeDbWrite(dbPath: string): Promise<void> {
  const driver = await getSqliteDriver()
  await driver.finalize(dbPath)
}

export async function readCopilotUsername(dbPath: string): Promise<string | null> {
  for (const key of USERNAME_KEYS) {
    const value = await readDbValue(dbPath, key)
    if (value?.trim()) {
      return value.trim()
    }
  }
  return null
}

function isCopilotRelatedKey(key: string, username?: string): boolean {
  if (STATIC_KEYS.includes(key)) return true
  if (STATIC_PREFIXES.some((prefix) => key.startsWith(prefix))) return true
  if (key.startsWith('vscode.github-github')) return true
  if (username) {
    if (key === `github-${username}` || key === `github-${username}-usages`) return true
  }
  if (/^github-[A-Za-z0-9._-]+(-usages)?$/.test(key)) return true
  return false
}

export async function collectCopilotEntries(
  dbPath: string
): Promise<{ username: string | null; entries: Record<string, string> }> {
  const username = await readCopilotUsername(dbPath)
  const keys = new Set<string>(STATIC_KEYS)

  for (const prefix of STATIC_PREFIXES) {
    const matched = await listMatchingKeys(dbPath, `${prefix}%`)
    matched.forEach((key) => keys.add(key))
  }

  const scopedGithubKeys = await listMatchingKeys(dbPath, 'vscode.github-github%')
  scopedGithubKeys.forEach((key) => keys.add(key))

  if (username) {
    keys.add(`github-${username}`)
    keys.add(`github-${username}-usages`)
  }

  const allKeys = await listMatchingKeys(dbPath, 'github-%')
  allKeys
    .filter((key) => isCopilotRelatedKey(key, username ?? undefined))
    .forEach((key) => keys.add(key))

  const entries: Record<string, string> = {}
  for (const key of keys) {
    const value = await readDbValue(dbPath, key)
    if (value !== null) {
      entries[key] = value
    }
  }

  return { username, entries }
}

export function filterEntriesForApply(
  entries: Record<string, string>,
  username: string
): Record<string, string> {
  const normalized = username.trim().toLowerCase()
  const filtered: Record<string, string> = {}

  for (const [key, value] of Object.entries(entries)) {
    if (key === GITHUB_AUTH_SECRET_KEY) {
      filtered[key] = value
      continue
    }
    if (key === WORKSPACE_USERNAME_KEY) {
      filtered[key] = username.trim()
      continue
    }
    if (key === 'defaultAccount.cachedPolicyData') {
      filtered[key] = value
      continue
    }
    if (key.startsWith('extensionsAssignmentFilterProvider.copilot')) {
      filtered[key] = value
      continue
    }
    if (key === `github-${username}` || key === `github-${username}-usages`) {
      filtered[key] = value
      continue
    }
    const usageMatch = key.match(/^github-(.+)-usages$/)
    if (usageMatch && usageMatch[1]!.toLowerCase() === normalized) {
      filtered[key] = value
    }
  }

  return filtered
}

export async function assertImportableGithubAccount(
  dbPath: string,
  expectedUsername?: string
): Promise<string> {
  if (!(await fileExists(dbPath))) {
    throw new Error('Không tìm thấy VS Code state.vscdb')
  }

  const activeUsername = await readCopilotUsername(dbPath)
  if (!activeUsername?.trim()) {
    throw new Error(
      'Không đọc được GitHub username từ VS Code. Hãy đăng nhập GitHub Copilot trong VS Code trước.'
    )
  }

  if (
    expectedUsername &&
    activeUsername.toLowerCase() !== expectedUsername.trim().toLowerCase()
  ) {
    throw new Error(
      `VS Code đang đăng nhập @${activeUsername}, không phải @${expectedUsername}. Hãy đăng nhập đúng tài khoản trong VS Code rồi import lại.`
    )
  }

  const auth = await readDbValue(dbPath, GITHUB_AUTH_SECRET_KEY)
  if (!auth) {
    throw new Error(
      'Không tìm thấy github.auth trong VS Code. Hãy đăng nhập GitHub trong VS Code (Accounts menu) rồi thử lại.'
    )
  }

  return activeUsername.trim()
}

function getVscodeUserDir(ide: CopilotIdeInfo): string {
  return join(ide.dbPath, '..', '..')
}

function getVscodeUserSettingsPath(ide: CopilotIdeInfo): string {
  return join(getVscodeUserDir(ide), 'settings.json')
}

const PREFERRED_ACCOUNT_PATH = ['github.copilot.preferredAccount']

/**
 * settings.json của VS Code là JSONC (cho phép comment/trailing comma).
 * Dùng jsonc-parser để chèn key mà GIỮ NGUYÊN phần còn lại;
 * không bao giờ ghi đè cả file khi parse lỗi (xem CODE_REVIEW C1).
 */
async function updateCopilotPreferredAccount(ide: CopilotIdeInfo, username: string): Promise<void> {
  const settingsPath = getVscodeUserSettingsPath(ide)
  const value = username.trim()

  let raw: string | null = null
  if (await fileExists(settingsPath)) {
    raw = await readFile(settingsPath, 'utf-8').catch(() => null)
  }

  if (raw === null) {
    await writeFile(
      settingsPath,
      `${JSON.stringify({ [PREFERRED_ACCOUNT_PATH[0]!]: value }, null, 4)}\n`,
      'utf-8'
    )
    return
  }

  const parsed = parseJsonc(raw)
  if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
    console.warn(
      `[ai-switcher] ${settingsPath} không parse được (JSONC hỏng?) — bỏ qua cập nhật ${PREFERRED_ACCOUNT_PATH[0]}`
    )
    return
  }

  const edits = modify(raw, PREFERRED_ACCOUNT_PATH, value, {
    formattingOptions: { tabSize: 4, insertSpaces: true, eol: '\n' }
  })
  if (!edits.length) return

  await writeFile(settingsPath, applyEdits(raw, edits), 'utf-8')
}

/** Trả về số dòng THỰC SỰ bị xóa (R5 INFO 1: phục vụ gate finalize). */
async function clearCopilotEntries(dbPath: string, username?: string): Promise<number> {
  const keysToDelete = new Set<string>(STATIC_KEYS)

  for (const prefix of STATIC_PREFIXES) {
    const matched = await listMatchingKeys(dbPath, `${prefix}%`)
    matched.forEach((key) => keysToDelete.add(key))
  }

  const scopedGithubKeys = await listMatchingKeys(dbPath, 'vscode.github-github%')
  scopedGithubKeys.forEach((key) => keysToDelete.add(key))

  const githubKeys = await listMatchingKeys(dbPath, 'github-%')
  githubKeys
    .filter((key) => isCopilotRelatedKey(key, username))
    .forEach((key) => keysToDelete.add(key))

  // R8 L1 (sửa lại comment R6 L3 cho trung thực): COPILOT_CHAT_KEY ĐÃ nằm sẵn
  // trong STATIC_KEYS (`:36`, từ trước HEAD 8105688) — batch dưới vốn đã xóa nó,
  // không cần (và không được) `add` tách riêng. Bản cũ có lệnh
  // deleteDbValue(COPILOT_CHAT_KEY) thứ hai chỉ là redundant (Set đã chứa key —
  // DELETE chạy 2 lần ra cùng kết quả), không phải vì key vắng mặt. Không có
  // guard `!keysToDelete.size` (R8 INFO 3): STATIC_KEYS luôn non-empty.
  const driver = await getSqliteDriver()
  return driver.deleteValues(dbPath, [...keysToDelete])
}

export async function applyCopilotEntries(
  dbPath: string,
  entries: Record<string, string>,
  username?: string
): Promise<void> {
  // R6 L3: COPILOT_CHAT_KEY được xóa trong cùng batch clearCopilotEntries.
  const cleared = await clearCopilotEntries(dbPath, username)

  const toApply = Object.fromEntries(
    Object.entries(entries).filter(([key]) => key !== COPILOT_CHAT_KEY)
  )
  const driver = await getSqliteDriver()
  const hasWrites = Object.keys(toApply).length > 0
  if (hasWrites) {
    await driver.writeValues(dbPath, toApply)
  }
  // WAL checkpoint + dọn sidecar ngay trong write API (CODE_REVIEW N1):
  // API exported này còn được gọi trực tiếp (test/import flow) — không được
  // tin tưởng caller luôn gọi finalize hộ.
  // R5 INFO 1: chỉ finalize khi flow này THỰC SỰ chạm dữ liệu (có entry ghi
  // mới hoặc có dòng bị xóa). No-op thuần (DB sạch, entries rỗng) không còn
  // mở connection + checkpoint vô ích.
  if (hasWrites || cleared > 0) {
    await driver.finalize(dbPath)
  }
}

function getWorkspaceStorageDir(ide: CopilotIdeInfo): string {
  const userDir = join(ide.dbPath, '..', '..')
  return join(userDir, 'workspaceStorage')
}

async function listWorkspaceDbPaths(ide: CopilotIdeInfo): Promise<string[]> {
  const workspaceDir = getWorkspaceStorageDir(ide)
  if (!(await fileExists(workspaceDir))) {
    return []
  }

  const entries = await readdir(workspaceDir, { withFileTypes: true })
  const dbPaths: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dbPath = join(workspaceDir, entry.name, 'state.vscdb')
    if (await fileExists(dbPath)) {
      dbPaths.push(dbPath)
    }
  }
  return dbPaths
}

async function syncWorkspaceCopilotUsername(
  ide: CopilotIdeInfo,
  username: string
): Promise<number> {
  const dbPaths = await listWorkspaceDbPaths(ide)
  let updated = 0

  for (const dbPath of dbPaths) {
    try {
      const current = await readDbValue(dbPath, WORKSPACE_USERNAME_KEY)
      if (current === null || current === username) {
        continue
      }
      const driver = await getSqliteDriver()
      await driver.writeValue(dbPath, WORKSPACE_USERNAME_KEY, username)
      await finalizeDbWrite(dbPath)
      updated += 1
    } catch {
      // workspace DB may be locked or malformed
    }
  }

  return updated
}

/** null = không xác định được (thiếu lsof — ví dụ Windows tối giản) */
async function isDbLocked(dbPath: string): Promise<boolean | null> {
  try {
    const { stdout } = await execFileAsync('lsof', [dbPath], { encoding: 'utf8' })
    return stdout.trim().length > 0
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null // không có lsof trên máy
    return false // lsof chạy được nhưng không tìm thấy handle mở
  }
}

async function waitForDbUnlock(dbPath: string): Promise<boolean> {
  let sawUnknown = false
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const locked = await isDbLocked(dbPath)
    if (locked === null) {
      sawUnknown = true
      break
    }
    if (!locked) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  if (sawUnknown) {
    // Không có lsof: chờ tĩnh ngắn để process kịp thoát hẳn
    await new Promise((resolve) => setTimeout(resolve, 1500))
    return true
  }
  return false
}

async function killIdeHelperProcesses(appName: string): Promise<void> {
  if (process.platform === 'darwin') {
    if (appName.includes('Visual Studio Code')) {
      const patterns = ['Code Helper', 'Visual Studio Code']
      for (const pattern of patterns) {
        await execFileAsync('pkill', ['-if', pattern], { encoding: 'utf8' }).catch(() => undefined)
      }
    } else if (appName === 'Cursor') {
      await execFileAsync('pkill', ['-if', 'Cursor Helper'], { encoding: 'utf8' }).catch(() => undefined)
    }
    return
  }

  if (process.platform === 'win32') {
    const imageName = appName.includes('Cursor') ? 'Cursor.exe' : 'Code.exe'
    await execFileAsync('taskkill', ['/F', '/IM', imageName], { encoding: 'utf8' }).catch(() => undefined)
  }
}

async function stopIdeForWrite(appName: string, dbPath: string): Promise<void> {
  // DB được override (test/sandbox) không nằm trong IDE thật → không quit/kill IDE
  if (getIdeDbPathOverride()) {
    return
  }

  if (await isIdeRunning(appName)) {
    await quitIde(appName)
  }
  await killIdeHelperProcesses(appName)
  if (!(await waitForDbUnlock(dbPath))) {
    throw new Error(
      'VS Code vẫn đang giữ state.vscdb sau 10 giây. Hãy đóng hoàn toàn VS Code rồi chuyển tài khoản lại.'
    )
  }
}

function ideProcessName(appName: string): string {
  return appName.toLowerCase().includes('cursor') ? 'cursor' : 'code'
}

async function isIdeRunning(appName: string): Promise<boolean> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync(
        'osascript',
        ['-e', `application "${appName}" is running`],
        { encoding: 'utf8' }
      )
      return stdout.trim() === 'true'
    } catch {
      return false
    }
  }

  if (process.platform === 'win32') {
    const imageName = appName.includes('Cursor') ? 'Cursor.exe' : 'Code.exe'
    try {
      const { stdout } = await execFileAsync('tasklist', ['/FI', `IMAGENAME eq ${imageName}`], {
        encoding: 'utf8'
      })
      return stdout.includes(imageName)
    } catch {
      return false
    }
  }

  try {
    // -x: khớp CHÍNH XÁC tên process (argv0), không match command line tự do
    // (pattern 'code' cũ với -f có thể giết cả code-server/codium/process lạ — CODE_REVIEW H2)
    const { stdout } = await execFileAsync('pgrep', ['-x', ideProcessName(appName)], {
      encoding: 'utf8'
    })
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

async function quitIde(appName: string): Promise<void> {
  if (process.platform === 'darwin') {
    try {
      await execFileAsync('osascript', ['-e', `tell application "${appName}" to quit`], {
        encoding: 'utf8'
      })
    } catch {
      // ignore missing app
    }
  } else if (process.platform === 'win32') {
    const imageName = appName.includes('Cursor') ? 'Cursor.exe' : 'Code.exe'
    await execFileAsync('taskkill', ['/IM', imageName], { encoding: 'utf8' }).catch(() => undefined)
  } else {
    await execFileAsync('pkill', ['-x', ideProcessName(appName)], { encoding: 'utf8' }).catch(
      () => undefined
    )
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await isIdeRunning(appName))) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

async function applyToIde(
  ide: CopilotIdeInfo,
  entries: Record<string, string>,
  username?: string
): Promise<void> {
  await withDbLock(ide.dbPath, async () => {
    await mkdir(join(ide.dbPath, '..'), { recursive: true })

    await stopIdeForWrite(ide.appName, ide.dbPath)

    if (await fileExists(ide.dbPath)) {
      await backupDatabase(ide.dbPath)
    } else {
      const driver = await getSqliteDriver()
      await driver.ensureSchema(ide.dbPath)
    }

    const resolvedUsername =
      username?.trim() || entries[WORKSPACE_USERNAME_KEY]?.trim() || (await readCopilotUsername(ide.dbPath))

    if (!resolvedUsername) {
      throw new Error('Không xác định được GitHub username cho snapshot Copilot')
    }

    const applyEntries = filterEntriesForApply(entries, resolvedUsername)

    // R6 L4: applyCopilotEntries đã TỰ finalize sau write/delete (N1 + INFO 1
    // gate) — không còn finalize kép ở đây; no-op thuần không touch DB nữa.
    await applyCopilotEntries(ide.dbPath, applyEntries, resolvedUsername)
    await syncWorkspaceCopilotUsername(ide, resolvedUsername)
    await updateCopilotPreferredAccount(ide, resolvedUsername)
    await new Promise((resolve) => setTimeout(resolve, 300))
  })

  // Không tự mở lại VS Code: extension Copilot có thể khôi phục token cache cũ khi startup.
}

export async function applyCopilotIdeSnapshots(
  snapshots: Partial<Record<CopilotIdeTarget, { username: string; entries: Record<string, string> }>>
): Promise<CopilotIdeApplyResult> {
  if (!shouldApplyCopilotIde()) {
    return {
      applied: false,
      targets: [],
      message:
        'Dev mode: bỏ qua đồng bộ IDE. Đặt AI_SWITCHER_APPLY_COPILOT_IDE=1 trong .env.development để bật.'
    }
  }

  let driverName: string
  try {
    driverName = (await getSqliteDriver()).name
  } catch (error) {
    return {
      applied: false,
      targets: [],
      message: error instanceof Error ? error.message : 'Không khởi tạo được SQLite'
    }
  }

  const appliedTargets: CopilotIdeTarget[] = []

  for (const ide of getCopilotIdeCandidates()) {
    const snapshot = snapshots[ide.target]
    if (!snapshot?.entries || !Object.keys(snapshot.entries).length) {
      continue
    }

    await applyToIde(ide, snapshot.entries, snapshot.username)
    appliedTargets.push(ide.target)
  }

  if (!appliedTargets.length) {
    return {
      applied: false,
      targets: [],
      message: 'Không có snapshot IDE nào để áp dụng'
    }
  }

  const label = appliedTargets.join(', ')
  const driverNote = driverName === 'sqlite3-cli' ? ' (sqlite3 CLI fallback)' : ''
  const message = `Đã chuyển Copilot sang @${snapshots[appliedTargets[0]!]?.username ?? 'target'} trong ${label}${driverNote}. Mở VS Code và chạy "Developer: Reload Window".`

  return {
    applied: true,
    targets: appliedTargets,
    message
  }
}

export async function readLiveCopilotUsername(): Promise<string | null> {
  for (const ide of getCopilotIdeCandidates()) {
    if (!(await fileExists(ide.dbPath))) continue
    try {
      const username = await readCopilotUsername(ide.dbPath)
      if (username) return username
    } catch {
      // try next IDE
    }
  }
  return null
}

export async function hasLiveCopilotAuth(): Promise<boolean> {
  for (const ide of getCopilotIdeCandidates()) {
    if (!(await fileExists(ide.dbPath))) continue
    try {
      const secret = await readDbValue(ide.dbPath, GITHUB_AUTH_SECRET_KEY)
      if (secret) return true
    } catch {
      // try next IDE
    }
  }
  return false
}
