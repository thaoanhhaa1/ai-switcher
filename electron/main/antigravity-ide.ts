import { execFile, spawn } from 'child_process'
import { chmod, mkdir, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { promisify } from 'util'
import type { AntigravityAccountEntry } from './antigravity-auth-storage'
import { shouldApplyAntigravityIde } from './env'
import {
  backupDatabase,
  fileExists,
  getSqliteDriver,
  withDbLock
} from './sqlite-db'
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
const KEYCHAIN_SERVICE = 'gemini'
const KEYCHAIN_ACCOUNT = 'antigravity'
const GO_KEYRING_PREFIX = 'go-keyring-base64:'
const STANDALONE_TOKEN_FILE = 'jetski-standalone-oauth-token'

export interface AntigravityOAuthTokens {
  accessToken: string
  expiresIn: number
}

export interface AntigravityIdeApplyResult {
  applied: boolean
  dbPath?: string
  restarted?: boolean
  message?: string
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
    // -x: khớp chính xác tên process, tránh giết nhầm process có 'antigravity' trong path
    const { stdout } = await execFileAsync('pgrep', ['-x', 'antigravity'], { encoding: 'utf8' })
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
    await execFileAsync('pkill', ['-x', 'antigravity'], { encoding: 'utf8' }).catch(() => undefined)
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
  driver: Awaited<ReturnType<typeof getSqliteDriver>>,
  dbPath: string,
  accessToken: string,
  refreshToken: string,
  expiry: number,
  email: string
): Promise<void> {
  const oauthInfo = createOAuthInfo(accessToken, refreshToken, expiry, email)
  const currentB64 = await driver.readValue(dbPath, OAUTH_TOKEN_KEY)
  const currentTopic = currentB64 ? Buffer.from(currentB64, 'base64') : Buffer.alloc(0)
  const mergedTopic = Buffer.concat([
    removeUnifiedTopicEntry(currentTopic, 'oauthTokenInfoSentinelKey'),
    createUnifiedTopicEntry('oauthTokenInfoSentinelKey', oauthInfo)
  ])

  const userStatusPayload = createMinimalUserStatusPayload(email)

  await driver.writeValues(dbPath, {
    [OAUTH_TOKEN_KEY]: mergedTopic.toString('base64'),
    [USER_STATUS_KEY]: createUnifiedStateEntry('userStatusSentinelKey', userStatusPayload),
    antigravityOnboarding: 'true'
  })
  await driver.deleteValues(dbPath, ['jetskiStateSync.agentManagerInitState'])
}

async function injectEnterpriseProject(
  driver: Awaited<ReturnType<typeof getSqliteDriver>>,
  dbPath: string,
  projectId?: string
): Promise<void> {
  const trimmed = projectId?.trim()
  if (!trimmed) {
    await driver.deleteValues(dbPath, [ENTERPRISE_PREFS_KEY])
    return
  }

  const payload = createStringValuePayload(trimmed)
  await driver.writeValue(
    dbPath,
    ENTERPRISE_PREFS_KEY,
    createUnifiedStateEntry('enterpriseGcpProjectId', payload)
  )
}

export function getAntigravityStandaloneTokenPath(): string {
  return join(homedir(), '.gemini', STANDALONE_TOKEN_FILE)
}

/**
 * Antigravity 2.x (hub `agy --app_data_dir=antigravity`) không còn đọc token
 * từ state.vscdb. Token được lưu ở system keyring (service `gemini`, account
 * `antigravity`) hoặc file standalone `~/.gemini/jetski-standalone-oauth-token`.
 * Cả hai nơi đều dùng cùng một JSON token store.
 */
export function buildAntigravityTokenStorePayload(
  entry: AntigravityAccountEntry,
  tokens: AntigravityOAuthTokens,
  now = Date.now()
): string {
  const email = entry.email?.trim()
  if (!email) {
    throw new Error('Tài khoản Antigravity thiếu email, không thể đồng bộ credential store')
  }

  const expiresIn = Math.max(Math.floor(tokens.expiresIn), 300)
  return JSON.stringify({
    token: {
      access_token: tokens.accessToken,
      token_type: 'Bearer',
      refresh_token: entry.refreshToken,
      expiry: new Date(now + expiresIn * 1000).toISOString(),
      expires_in: expiresIn
    },
    auth_method: 'consumer',
    id_token_email: email
  })
}

export function buildAntigravityKeyringPassword(payload: string): string {
  return `${GO_KEYRING_PREFIX}${Buffer.from(payload, 'utf8').toString('base64')}`
}

async function writeAntigravityStandaloneToken(payload: string): Promise<void> {
  const tokenPath = getAntigravityStandaloneTokenPath()
  await mkdir(dirname(tokenPath), { recursive: true })
  await writeFile(tokenPath, payload, { mode: 0o600 })
  await chmod(tokenPath, 0o600)
}

async function writeAntigravityKeychainToken(payload: string): Promise<void> {
  if (process.platform !== 'darwin') {
    return
  }

  await execFileAsync(
    'security',
    [
      'add-generic-password',
      '-U',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      KEYCHAIN_ACCOUNT,
      '-w',
      buildAntigravityKeyringPassword(payload)
    ],
    { encoding: 'utf8' }
  )
}

async function applyAntigravityTokenStore(
  entry: AntigravityAccountEntry,
  tokens: AntigravityOAuthTokens
): Promise<void> {
  const payload = buildAntigravityTokenStorePayload(entry, tokens)
  await writeAntigravityStandaloneToken(payload)
  await writeAntigravityKeychainToken(payload)
}

export async function applyAntigravityIdeAccount(
  entry: AntigravityAccountEntry,
  tokens: AntigravityOAuthTokens
): Promise<AntigravityIdeApplyResult> {
  if (!shouldApplyAntigravityIde()) {
    return {
      applied: false,
      message:
        'Dev mode: bỏ qua đồng bộ Antigravity IDE. Đặt AI_SWITCHER_APPLY_ANTIGRAVITY_IDE=1 trong .env.development để bật.'
    }
  }

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
    await getSqliteDriver()
  } catch (error) {
    return {
      applied: false,
      dbPath,
      message: error instanceof Error ? error.message : 'Không khởi tạo được SQLite'
    }
  }

  const wasRunning = await isAntigravityIdeRunning()
  if (wasRunning) {
    await quitAntigravityIde()
  }

  try {
    await applyAntigravityTokenStore(entry, tokens)

    await withDbLock(dbPath, async () => {
      if (await fileExists(dbPath)) {
        await backupDatabase(dbPath)
      }

      const driver = await getSqliteDriver()
      const expiry = Math.floor(Date.now() / 1000) + Math.max(tokens.expiresIn, 300)
      await injectOAuthToken(driver, dbPath, tokens.accessToken, entry.refreshToken, expiry, email)
      await injectEnterpriseProject(driver, dbPath, entry.projectId ?? entry.managedProjectId)
      await driver.finalize(dbPath)
    })
  } catch (error) {
    // IDE đã bị đóng trước khi ghi; mở lại để user không bị mất cửa sổ làm việc.
    if (wasRunning) {
      await openAntigravityIde().catch(() => undefined)
    }
    throw error
  }

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
    const driver = await getSqliteDriver()
    const userStatusB64 = await driver.readValue(dbPath, USER_STATUS_KEY)
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
