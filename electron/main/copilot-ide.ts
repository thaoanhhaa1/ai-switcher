import { execFile, spawn } from 'child_process'
import { access, copyFile, mkdir, readdir, readFile, unlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { homedir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
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
  restarted: CopilotIdeTarget[]
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

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''")
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function getIdeDefinitions(): Array<{ target: CopilotIdeTarget; appName: string; dbPath: string }> {
  const home = homedir()

  if (process.platform === 'darwin') {
    return [
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
  }

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    return [
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
  }

  return [
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

export function getCopilotIdeCandidates(): CopilotIdeInfo[] {
  return getIdeDefinitions()
}

export async function listAvailableCopilotIdes(): Promise<CopilotIdeInfo[]> {
  const candidates: CopilotIdeInfo[] = []
  for (const definition of getIdeDefinitions()) {
    if (await fileExists(definition.dbPath)) {
      candidates.push(definition)
    }
  }
  return candidates
}

async function sqliteQuery(dbPath: string, sql: string): Promise<string> {
  const { stdout } = await execFileAsync('sqlite3', [dbPath, sql], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  })
  return stdout.trimEnd()
}

async function sqliteExec(dbPath: string, sql: string): Promise<void> {
  await execFileAsync('sqlite3', [dbPath, sql], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  })
}

async function readDbValue(dbPath: string, key: string): Promise<string | null> {
  const row = await sqliteQuery(
    dbPath,
    `SELECT value FROM ItemTable WHERE key = '${escapeSqlString(key)}' LIMIT 1;`
  )
  return row.length > 0 ? row : null
}

async function writeDbValue(dbPath: string, key: string, value: string): Promise<void> {
  const valuePath = join(tmpdir(), `ai-switcher-copilot-${Date.now()}.txt`)
  try {
    await writeFile(valuePath, value, 'utf8')
    await execFileAsync(
      'python3',
      [
        '-c',
        `import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
with open(sys.argv[3], 'r', encoding='utf-8') as handle:
    payload = handle.read()
conn.execute('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)', (sys.argv[2], payload))
conn.commit()
conn.close()`,
        dbPath,
        key,
        valuePath
      ],
      { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
    )
  } finally {
    await unlink(valuePath).catch(() => undefined)
  }
}

async function deleteDbValue(dbPath: string, key: string): Promise<void> {
  await sqliteExec(
    dbPath,
    `DELETE FROM ItemTable WHERE key = '${escapeSqlString(key)}';`
  )
}

async function listMatchingKeys(dbPath: string, likePattern: string): Promise<string[]> {
  const output = await sqliteQuery(
    dbPath,
    `SELECT key FROM ItemTable WHERE key LIKE '${escapeSqlString(likePattern)}' ESCAPE '\\';`
  )
  if (!output) return []
  return output.split('\n').filter(Boolean)
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

async function updateCopilotPreferredAccount(ide: CopilotIdeInfo, username: string): Promise<void> {
  const settingsPath = getVscodeUserSettingsPath(ide)
  let settings: Record<string, unknown> = {}

  if (await fileExists(settingsPath)) {
    try {
      const raw = await readFile(settingsPath, 'utf-8')
      settings = JSON.parse(raw) as Record<string, unknown>
    } catch {
      settings = {}
    }
  }

  settings['github.copilot.preferredAccount'] = username.trim()
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 4)}\n`, 'utf-8')
}

async function clearCopilotEntries(dbPath: string, username?: string): Promise<void> {
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

  for (const key of keysToDelete) {
    await deleteDbValue(dbPath, key)
  }
}

export async function applyCopilotEntries(
  dbPath: string,
  entries: Record<string, string>,
  username?: string
): Promise<void> {
  await clearCopilotEntries(dbPath, username)
  await deleteDbValue(dbPath, COPILOT_CHAT_KEY)

  for (const [key, value] of Object.entries(entries)) {
    if (key === COPILOT_CHAT_KEY) {
      continue
    }
    await writeDbValue(dbPath, key, value)
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
      await writeDbValue(dbPath, WORKSPACE_USERNAME_KEY, username)
      await finalizeDbWrite(dbPath)
      updated += 1
    } catch {
      // workspace DB may be locked or malformed
    }
  }

  return updated
}

async function isDbLocked(dbPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('lsof', [dbPath], { encoding: 'utf8' })
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

async function waitForDbUnlock(dbPath: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!(await isDbLocked(dbPath))) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
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

async function finalizeDbWrite(dbPath: string): Promise<void> {
  try {
    await sqliteExec(dbPath, 'PRAGMA wal_checkpoint(TRUNCATE);')
  } catch {
    // ignore
  }

  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${dbPath}${suffix}`
    if (await fileExists(sidecar)) {
      await unlink(sidecar).catch(() => undefined)
    }
  }
}

async function stopIdeForWrite(appName: string, dbPath: string): Promise<void> {
  if (await isIdeRunning(appName)) {
    await quitIde(appName)
  }
  await killIdeHelperProcesses(appName)
  await waitForDbUnlock(dbPath)
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

  const processPattern = appName.toLowerCase().includes('cursor') ? 'cursor' : 'code'
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', processPattern], { encoding: 'utf8' })
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
    const processPattern = appName.toLowerCase().includes('cursor') ? 'cursor' : 'code'
    await execFileAsync('pkill', ['-f', processPattern], { encoding: 'utf8' }).catch(() => undefined)
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await isIdeRunning(appName))) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

async function openIde(appName: string): Promise<void> {
  if (process.platform === 'darwin') {
    await execFileAsync('open', ['-a', appName], { encoding: 'utf8' })
    return
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    const exeName = appName.includes('Cursor') ? 'Cursor.exe' : 'Code.exe'
    const folder = appName.includes('Cursor') ? 'cursor' : 'Programs\\Microsoft VS Code'
    const exePath = join(localAppData, folder, exeName)
    if (await fileExists(exePath)) {
      spawn(exePath, [], { detached: true, stdio: 'ignore' }).unref()
      return
    }
    throw new Error(`Không tìm thấy ${exeName}`)
  }

  const command = appName.toLowerCase().includes('cursor') ? 'cursor' : 'code'
  await execFileAsync(command, [], { encoding: 'utf8' })
}

async function ensureSqliteAvailable(): Promise<void> {
  await execFileAsync('sqlite3', ['--version'], { encoding: 'utf8' })
}

async function applyToIde(
  ide: CopilotIdeInfo,
  entries: Record<string, string>,
  username?: string
): Promise<{ restarted: boolean }> {
  await mkdir(join(ide.dbPath, '..'), { recursive: true })

  await stopIdeForWrite(ide.appName, ide.dbPath)

  const backupPath = `${ide.dbPath}.ai-switcher.bak`
  if (await fileExists(ide.dbPath)) {
    await copyFile(ide.dbPath, backupPath)
  } else {
    await sqliteExec(
      ide.dbPath,
      'CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY ON CONFLICT REPLACE, value BLOB);'
    )
  }

  const resolvedUsername =
    username?.trim() || entries[WORKSPACE_USERNAME_KEY]?.trim() || (await readCopilotUsername(ide.dbPath))

  if (!resolvedUsername) {
    throw new Error('Không xác định được GitHub username cho snapshot Copilot')
  }

  const applyEntries = filterEntriesForApply(entries, resolvedUsername)

  await applyCopilotEntries(ide.dbPath, applyEntries, resolvedUsername)
  await syncWorkspaceCopilotUsername(ide, resolvedUsername)
  await updateCopilotPreferredAccount(ide, resolvedUsername)
  await finalizeDbWrite(ide.dbPath)
  await new Promise((resolve) => setTimeout(resolve, 300))

  // Không tự mở lại VS Code: extension Copilot có thể khôi phục token cache cũ khi startup.
  return { restarted: false }
}

export async function applyCopilotIdeSnapshots(
  snapshots: Partial<Record<CopilotIdeTarget, { username: string; entries: Record<string, string> }>>
): Promise<CopilotIdeApplyResult> {
  if (!shouldApplyCopilotIde()) {
    return {
      applied: false,
      targets: [],
      restarted: [],
      message:
        'Dev mode: bỏ qua đồng bộ IDE. Đặt AI_SWITCHER_APPLY_COPILOT_IDE=1 trong .env.development để bật.'
    }
  }

  try {
    await ensureSqliteAvailable()
  } catch {
    return {
      applied: false,
      targets: [],
      restarted: [],
      message: 'Cần cài sqlite3 CLI để đồng bộ GitHub Copilot'
    }
  }

  const appliedTargets: CopilotIdeTarget[] = []
  const restartedTargets: CopilotIdeTarget[] = []

  for (const ide of getCopilotIdeCandidates()) {
    const snapshot = snapshots[ide.target]
    if (!snapshot?.entries || !Object.keys(snapshot.entries).length) {
      continue
    }

    const result = await applyToIde(ide, snapshot.entries, snapshot.username)
    appliedTargets.push(ide.target)
    if (result.restarted) {
      restartedTargets.push(ide.target)
    }
  }

  if (!appliedTargets.length) {
    return {
      applied: false,
      targets: [],
      restarted: [],
      message: 'Không có snapshot IDE nào để áp dụng'
    }
  }

  const label = appliedTargets.join(', ')
  const message = `Đã chuyển Copilot sang @${snapshots[appliedTargets[0]!]?.username ?? 'target'} trong ${label}. Mở VS Code và chạy "Developer: Reload Window".`

  return {
    applied: true,
    targets: appliedTargets,
    restarted: [],
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
