import { execFile, spawn } from 'child_process'
import { access, copyFile, mkdir } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import type { AntigravityAccountEntry } from './antigravity-auth-storage'
import {
  createMinimalUserStatusPayload,
  createOAuthInfo,
  createStringValuePayload,
  createUnifiedStateEntry,
  createUnifiedTopicEntry,
  removeUnifiedTopicEntry
} from './antigravity-protobuf'

const execFileAsync = promisify(execFile)
const IDE_APP_NAMES = ['Antigravity IDE', 'Antigravity'] as const
const OAUTH_TOKEN_KEY = 'antigravityUnifiedStateSync.oauthToken'
const USER_STATUS_KEY = 'antigravityUnifiedStateSync.userStatus'
const ENTERPRISE_PREFS_KEY = 'antigravityUnifiedStateSync.enterprisePreferences'

export interface AntigravityIdeApplyResult {
  applied: boolean
  dbPath?: string
  restarted?: boolean
  message?: string
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export function getAntigravityIdeDbCandidates(): string[] {
  const home = homedir()

  if (process.platform === 'darwin') {
    return IDE_APP_NAMES.map((name) =>
      join(home, 'Library/Application Support', name, 'User/globalStorage/state.vscdb')
    )
  }

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    return IDE_APP_NAMES.map((name) =>
      join(appData, name, 'User', 'globalStorage', 'state.vscdb')
    )
  }

  return IDE_APP_NAMES.map((name) =>
    join(home, '.config', name, 'User/globalStorage/state.vscdb')
  )
}

export async function resolveAntigravityIdeDbPath(): Promise<string | null> {
  for (const candidate of getAntigravityIdeDbCandidates()) {
    if (await fileExists(candidate)) {
      return candidate
    }
  }
  return getAntigravityIdeDbCandidates()[0] ?? null
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''")
}

async function sqliteQuery(dbPath: string, sql: string): Promise<string> {
  const { stdout } = await execFileAsync('sqlite3', [dbPath, sql], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  })
  return stdout.trimEnd()
}

async function sqliteExec(dbPath: string, sql: string): Promise<void> {
  await execFileAsync('sqlite3', [dbPath, sql], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
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
  await sqliteExec(
    dbPath,
    `INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('${escapeSqlString(key)}', '${escapeSqlString(value)}');`
  )
}

async function deleteDbValue(dbPath: string, key: string): Promise<void> {
  await sqliteExec(
    dbPath,
    `DELETE FROM ItemTable WHERE key = '${escapeSqlString(key)}';`
  )
}

async function isAntigravityIdeRunning(): Promise<boolean> {
  if (process.platform === 'darwin') {
    for (const appName of IDE_APP_NAMES) {
      try {
        const { stdout } = await execFileAsync(
          'osascript',
          ['-e', `application "${appName}" is running`],
          { encoding: 'utf8' }
        )
        if (stdout.trim() === 'true') {
          return true
        }
      } catch {
        // try next app name
      }
    }
    return false
  }

  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync(
        'tasklist',
        ['/FI', 'IMAGENAME eq Antigravity IDE.exe'],
        { encoding: 'utf8' }
      )
      return stdout.includes('Antigravity IDE.exe')
    } catch {
      return false
    }
  }

  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', 'antigravity'], { encoding: 'utf8' })
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

async function quitAntigravityIde(): Promise<void> {
  if (process.platform === 'darwin') {
    for (const appName of IDE_APP_NAMES) {
      try {
        await execFileAsync('osascript', ['-e', `tell application "${appName}" to quit`], {
          encoding: 'utf8'
        })
      } catch {
        // ignore missing app
      }
    }
  } else if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/IM', 'Antigravity IDE.exe'], { encoding: 'utf8' }).catch(
      () => undefined
    )
  } else {
    await execFileAsync('pkill', ['-f', 'antigravity'], { encoding: 'utf8' }).catch(() => undefined)
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await isAntigravityIdeRunning())) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

async function openAntigravityIde(): Promise<void> {
  if (process.platform === 'darwin') {
    for (const appName of IDE_APP_NAMES) {
      try {
        await execFileAsync('open', ['-a', appName], { encoding: 'utf8' })
        return
      } catch {
        // try next app name
      }
    }
    throw new Error('Không tìm thấy Antigravity IDE trên máy')
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    const exePath = join(localAppData, 'Programs', 'Antigravity IDE', 'Antigravity IDE.exe')
    if (await fileExists(exePath)) {
      spawn(exePath, [], { detached: true, stdio: 'ignore' }).unref()
      return
    }
    throw new Error('Không tìm thấy Antigravity IDE.exe')
  }

  await execFileAsync('antigravity-ide', [], { encoding: 'utf8' })
}

async function injectOAuthToken(
  dbPath: string,
  accessToken: string,
  refreshToken: string,
  expiry: number,
  email: string
): Promise<void> {
  const oauthInfo = createOAuthInfo(accessToken, refreshToken, expiry, email)
  const currentB64 = await readDbValue(dbPath, OAUTH_TOKEN_KEY)
  const currentTopic = currentB64 ? Buffer.from(currentB64, 'base64') : Buffer.alloc(0)
  const mergedTopic = Buffer.concat([
    removeUnifiedTopicEntry(currentTopic, 'oauthTokenInfoSentinelKey'),
    createUnifiedTopicEntry('oauthTokenInfoSentinelKey', oauthInfo)
  ])
  await writeDbValue(dbPath, OAUTH_TOKEN_KEY, mergedTopic.toString('base64'))

  const userStatusPayload = createMinimalUserStatusPayload(email)
  await writeDbValue(
    dbPath,
    USER_STATUS_KEY,
    createUnifiedStateEntry('userStatusSentinelKey', userStatusPayload)
  )

  await writeDbValue(dbPath, 'antigravityOnboarding', 'true')
  await deleteDbValue(dbPath, 'jetskiStateSync.agentManagerInitState')
}

async function injectEnterpriseProject(dbPath: string, projectId?: string): Promise<void> {
  const trimmed = projectId?.trim()
  if (!trimmed) {
    await deleteDbValue(dbPath, ENTERPRISE_PREFS_KEY)
    return
  }

  const payload = createStringValuePayload(trimmed)
  await writeDbValue(
    dbPath,
    ENTERPRISE_PREFS_KEY,
    createUnifiedStateEntry('enterpriseGcpProjectId', payload)
  )
}

export async function applyAntigravityIdeAccount(
  entry: AntigravityAccountEntry,
  tokens: { accessToken: string; expiresIn: number }
): Promise<AntigravityIdeApplyResult> {
  const dbPath = await resolveAntigravityIdeDbPath()
  if (!dbPath) {
    return {
      applied: false,
      message: 'Không tìm thấy Antigravity IDE (state.vscdb)'
    }
  }

  const email = entry.email?.trim()
  if (!email) {
    return {
      applied: false,
      dbPath,
      message: 'Tài khoản Antigravity thiếu email, không thể đồng bộ IDE'
    }
  }

  try {
    await execFileAsync('sqlite3', ['--version'], { encoding: 'utf8' })
  } catch {
    return {
      applied: false,
      dbPath,
      message: 'Cần cài sqlite3 CLI để đồng bộ Antigravity IDE'
    }
  }

  const parentDir = join(dbPath, '..')
  await mkdir(parentDir, { recursive: true })

  const wasRunning = await isAntigravityIdeRunning()
  if (wasRunning) {
    await quitAntigravityIde()
  }

  const backupPath = `${dbPath}.ai-switcher.bak`
  if (await fileExists(dbPath)) {
    await copyFile(dbPath, backupPath)
  } else {
    await sqliteExec(
      dbPath,
      'CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY ON CONFLICT REPLACE, value BLOB);'
    )
  }

  const expiry = Math.floor(Date.now() / 1000) + Math.max(tokens.expiresIn, 300)
  await injectOAuthToken(dbPath, tokens.accessToken, entry.refreshToken, expiry, email)
  await injectEnterpriseProject(dbPath, entry.projectId ?? entry.managedProjectId)

  let restarted = false
  if (wasRunning) {
    await openAntigravityIde()
    restarted = true
  }

  return {
    applied: true,
    dbPath,
    restarted,
    message: restarted
      ? 'Đã chuyển tài khoản trong Antigravity IDE và khởi động lại IDE'
      : 'Đã chuyển tài khoản trong Antigravity IDE. Mở IDE để áp dụng.'
  }
}

export async function readAntigravityIdeEmail(): Promise<string | null> {
  const dbPath = await resolveAntigravityIdeDbPath()
  if (!dbPath || !(await fileExists(dbPath))) {
    return null
  }

  try {
    const userStatusB64 = await readDbValue(dbPath, USER_STATUS_KEY)
    if (!userStatusB64) {
      return null
    }
    const decoded = Buffer.from(userStatusB64, 'base64').toString('utf8')
    const match = decoded.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
    return match?.[0] ?? null
  } catch {
    return null
  }
}
