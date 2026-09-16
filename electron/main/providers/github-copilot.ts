import { readFile, readdir } from 'fs/promises'
import { execFile } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import type { Account, AccountQuota, CopilotLoginStatus, QuotaWindow } from '../../../src/types'
import {
  deleteStoredCopilotAccount,
  isValidCopilotEntry,
  loadStoredCopilotAccount,
  saveStoredCopilotAccount,
  type CopilotAccountEntry,
  type CopilotIdeSnapshot
} from '../copilot-auth-storage'
import {
  applyCopilotIdeSnapshots,
  assertImportableGithubAccount,
  collectCopilotEntries,
  filterEntriesForApply,
  getCopilotIdeCandidates,
  readLiveCopilotUsername,
  type CopilotIdeTarget
} from '../copilot-ide'
import { formatResetAt } from '../quota-utils'
import { getAppDataDir } from '../paths'
import { findAccount, loadAppData } from '../storage'
import { pollForToken, requestDeviceCode, type GithubTokenResult } from '../copilot-device-flow'

const execFileAsync = promisify(execFile)

const GITHUB_AUTH_SECRET_KEY =
  'secret://{"extensionId":"vscode.github-authentication","key":"github.auth"}'

function validateCopilotSnapshot(
  snapshot: CopilotIdeSnapshot,
  expectedUsername?: string
): string {
  const username =
    snapshot.entries['github.copilot-github']?.trim() ||
    snapshot.username?.trim() ||
    ''

  if (!username) {
    throw new Error('Snapshot thiếu github.copilot-github')
  }

  const copilotGithub = snapshot.entries['github.copilot-github']?.trim()
  if (copilotGithub && copilotGithub.toLowerCase() !== username.toLowerCase()) {
    throw new Error('Snapshot không nhất quán giữa metadata và github.copilot-github')
  }

  if (!snapshot.entries[GITHUB_AUTH_SECRET_KEY]) {
    throw new Error('Snapshot thiếu github.auth secret')
  }

  if (
    expectedUsername &&
    username.toLowerCase() !== expectedUsername.trim().toLowerCase()
  ) {
    throw new Error(
      `VS Code đang đăng nhập @${username}, không phải @${expectedUsername}. Hãy đăng nhập đúng tài khoản trong VS Code rồi import lại.`
    )
  }

  return username
}

async function assertAuthUniqueForAccount(accountId: string, authValue: string): Promise<void> {
  const dir = join(getAppDataDir(), 'copilot-auth')
  let files: string[] = []
  try {
    files = await readdir(dir)
  } catch {
    return
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const otherId = file.replace(/\.json$/, '')
    if (otherId === accountId) continue

    const other = await loadStoredCopilotAccount(otherId)
    const otherAuth = other?.snapshots?.vscode?.entries?.[GITHUB_AUTH_SECRET_KEY]
    if (otherAuth && otherAuth === authValue) {
      throw new Error(
        `Auth này trùng với slot @${other?.username ?? otherId}. Hãy đăng xuất account kia trong VS Code trước khi import slot này.`
      )
    }
  }
}

export const COPILOT_DOCS = 'https://docs.github.com/en/copilot'

export const DEFAULT_COPILOT_SETTINGS = {
  model: 'default',
  modelReasoningEffort: 'medium' as const
}

interface CopilotQuotaCategory {
  percent_remaining?: number
  remaining?: number
  entitlement?: number
  unlimited?: boolean
}

interface CopilotQuotaResponse {
  login?: string
  copilot_plan?: string
  access_type_sku?: string
  quota_reset_date?: string
  quota_reset_date_utc?: string
  limited_user_reset_date?: string
  quota_snapshots?: Record<string, CopilotQuotaCategory>
  limited_user_quotas?: Record<string, number>
  monthly_quotas?: Record<string, number>
}

function buildEmptyQuota(message?: string): AccountQuota {
  const empty: QuotaWindow = {
    usedCents: 0,
    limitCents: 0,
    remainingCents: 0,
    usedPercent: 0,
    remainingPercent: 0,
    resetsAt: null,
    resetsInLabel: ''
  }

  return {
    available: false,
    hasActiveLimits: false,
    message,
    displayMode: 'percent',
    hourly: empty,
    weekly: empty,
    updatedAt: new Date().toISOString()
  }
}

export function mapPercentCategory(
  category?: CopilotQuotaCategory,
  label?: string
): QuotaWindow | null {
  if (!category) return null

  const windowLabel = label ? `${label} · Unlimited` : 'Unlimited'
  if (category.unlimited) {
    return {
      usedCents: 0,
      limitCents: 100,
      remainingCents: 100,
      usedPercent: 0,
      remainingPercent: 100,
      resetsAt: null,
      resetsInLabel: '',
      windowLabel
    }
  }

  const hasPercent =
    typeof category.percent_remaining === 'number' &&
    Number.isFinite(category.percent_remaining)
  const hasCounts =
    typeof category.remaining === 'number' &&
    Number.isFinite(category.remaining) &&
    typeof category.entitlement === 'number' &&
    category.entitlement > 0

  // Không có bất kỳ số liệu nào → coi như chưa có data (ẩn card),
  // KHÔNG suy ra "100% đã dùng" (xem CODE_REVIEW M4).
  if (!hasPercent && !hasCounts) return null

  const remainingPercent = hasPercent
    ? Math.min(100, Math.max(0, Math.round(category.percent_remaining!)))
    : Math.min(100, Math.max(0, Math.round((category.remaining! / category.entitlement!) * 100)))
  const usedPercent = Math.max(0, 100 - remainingPercent)

  return {
    usedCents: usedPercent,
    limitCents: 100,
    remainingCents: remainingPercent,
    usedPercent,
    remainingPercent,
    usedUnits: category.entitlement
      ? category.entitlement - (category.remaining ?? 0)
      : undefined,
    limitUnits: category.entitlement,
    resetsAt: null,
    resetsInLabel: '',
    windowLabel: label
  }
}

function mapCountCategory(used: number, limit: number, label: string): QuotaWindow {
  const usedPercent = limit > 0 ? Math.min(100, Math.max(0, Math.round((used / limit) * 100))) : 0
  const remainingPercent = Math.max(0, 100 - usedPercent)

  return {
    usedCents: usedPercent,
    limitCents: limit,
    remainingCents: remainingPercent,
    usedPercent,
    remainingPercent,
    usedUnits: used,
    limitUnits: limit,
    resetsAt: null,
    resetsInLabel: '',
    windowLabel: label
  }
}

async function readGhToken(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], { encoding: 'utf8' })
    const token = stdout.trim()
    return token || null
  } catch {
    return null
  }
}

async function readCopilotAppsToken(): Promise<string | null> {
  const candidates = [
    join(homedir(), '.config/github-copilot/apps.json'),
    join(homedir(), '.config/github-copilot/hosts.json')
  ]

  for (const path of candidates) {
    try {
      const raw = await readFile(path, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      for (const value of Object.values(parsed)) {
        if (typeof value === 'string' && value.startsWith('gho_')) {
          return value
        }
        if (value && typeof value === 'object') {
          const token = (value as { oauth_token?: string; token?: string }).oauth_token
            ?? (value as { oauth_token?: string; token?: string }).token
          if (token?.startsWith('gho_') || token?.startsWith('ghu_')) {
            return token
          }
        }
      }
    } catch {
      // try next file
    }
  }

  return null
}

async function resolveCopilotToken(): Promise<string | null> {
  return (await readGhToken()) ?? (await readCopilotAppsToken())
}

function getSnapshotTargets(entry: CopilotAccountEntry): CopilotIdeTarget[] {
  const filtered = filterSnapshotsForAccount(entry, entry.username)
  return Object.entries(filtered)
    .filter(([, snapshot]) => snapshot && Object.keys(snapshot.entries).length > 0)
    .map(([target]) => target as CopilotIdeTarget)
}

async function captureLiveSnapshots(
  expectedUsername?: string,
  ideTargets?: CopilotIdeTarget[]
): Promise<{ snapshots: Partial<Record<CopilotIdeTarget, CopilotIdeSnapshot>>; username: string }> {
  const snapshots: Partial<Record<CopilotIdeTarget, CopilotIdeSnapshot>> = {}
  const usernames = new Set<string>()
  const skipped: Array<{ target: CopilotIdeTarget; username: string }> = []
  const allowedTargets = ideTargets?.length ? new Set(ideTargets) : null

  for (const ide of getCopilotIdeCandidates()) {
    if (allowedTargets && !allowedTargets.has(ide.target)) {
      continue
    }

    let collected: { username: string | null; entries: Record<string, string> }
    try {
      await assertImportableGithubAccount(ide.dbPath, expectedUsername)
      collected = await collectCopilotEntries(ide.dbPath)
    } catch (error) {
      if (allowedTargets?.has(ide.target)) {
        throw error instanceof Error ? error : new Error(String(error))
      }
      continue
    }

    if (!Object.keys(collected.entries).length) {
      if (allowedTargets?.has(ide.target)) {
        throw new Error('Không đọc được dữ liệu auth Copilot từ VS Code.')
      }
      continue
    }

    const username = collected.username?.trim()
    if (!username) {
      if (allowedTargets?.has(ide.target)) {
        throw new Error('Không đọc được GitHub username từ VS Code.')
      }
      continue
    }

    if (
      expectedUsername &&
      username.toLowerCase() !== expectedUsername.trim().toLowerCase()
    ) {
      skipped.push({ target: ide.target, username })
      continue
    }

    usernames.add(username)
    snapshots[ide.target] = {
      username,
      entries: collected.entries
    }
  }

  if (!Object.keys(snapshots).length) {
    if (expectedUsername && skipped.length) {
      const details = skipped.map((item) => `${item.target}: @${item.username}`).join(', ')
      throw new Error(
        `Không tìm thấy auth @${expectedUsername} trong IDE. IDE hiện tại: ${details}. Hãy đăng nhập đúng tài khoản GitHub Copilot rồi import lại.`
      )
    }

    throw new Error(
      allowedTargets?.has('vscode')
        ? 'Không tìm thấy auth Copilot trong VS Code. Hãy đăng nhập GitHub Copilot trong VS Code trước.'
        : 'Không tìm thấy auth Copilot trong VS Code/Cursor. Hãy đăng nhập GitHub Copilot trong IDE trước.'
    )
  }

  if (usernames.size > 1) {
    throw new Error(
      `Phát hiện nhiều tài khoản GitHub khác nhau trong các IDE: ${[...usernames].map((u) => `@${u}`).join(', ')}. Hãy đăng nhập cùng một tài khoản trên tất cả IDE trước khi import, hoặc import từng IDE sau khi đăng nhập đúng tài khoản cho slot này.`
    )
  }

  return {
    snapshots,
    username: [...usernames][0]!
  }
}

function filterSnapshotsForAccount(
  entry: CopilotAccountEntry,
  accountUsername?: string
): Partial<Record<CopilotIdeTarget, CopilotIdeSnapshot>> {
  const username = (accountUsername ?? entry.username)?.trim().toLowerCase()
  if (!username) {
    return entry.snapshots
  }

  const filtered: Partial<Record<CopilotIdeTarget, CopilotIdeSnapshot>> = {}
  for (const [target, snapshot] of Object.entries(entry.snapshots) as Array<
    [CopilotIdeTarget, CopilotIdeSnapshot | undefined]
  >) {
    if (!snapshot?.entries || !Object.keys(snapshot.entries).length) continue
    if (snapshot.username?.trim().toLowerCase() === username) {
      filtered[target] = snapshot
    }
  }

  return filtered
}

export async function applyCopilotAccount(account: Account): Promise<void> {
  const entry = await loadStoredCopilotAccount(account.id)
  if (!isValidCopilotEntry(entry)) {
    throw new Error('Tài khoản Copilot chưa có auth. Hãy import từ VS Code đang đăng nhập.')
  }

  const snapshots = filterSnapshotsForAccount(entry, account.copilotUsername ?? entry.username)
  const vscodeSnapshot = snapshots.vscode
  if (!vscodeSnapshot?.entries || !Object.keys(vscodeSnapshot.entries).length) {
    throw new Error(
      `Không có snapshot VS Code cho @${account.copilotUsername ?? entry.username}. Hãy đăng nhập tài khoản này trong VS Code rồi import lại.`
    )
  }

  validateCopilotSnapshot(vscodeSnapshot, account.copilotUsername ?? entry.username)

  const result = await applyCopilotIdeSnapshots({ vscode: vscodeSnapshot })
  if (!result.applied) {
    throw new Error(result.message ?? 'Không thể áp dụng auth Copilot vào IDE')
  }
}

export async function snapshotLiveCopilotToAccount(
  accountId: string,
  accountUsername?: string
): Promise<void> {
  try {
    const { snapshots, username } = await captureLiveSnapshots(accountUsername, ['vscode'])
    if (!Object.keys(snapshots).length) return

    const existing = await loadStoredCopilotAccount(accountId)
    const vscode = snapshots.vscode
    if (!vscode) return

    const filteredEntries = filterEntriesForApply(vscode.entries, vscode.username)
    await saveStoredCopilotAccount(accountId, {
      username: accountUsername ?? username ?? existing?.username ?? '',
      snapshots: {
        ...existing?.snapshots,
        vscode: {
          username: vscode.username,
          entries: filteredEntries
        }
      }
    })
  } catch {
    // Best-effort snapshot before switching; don't block switch if IDE state mismatches.
  }
}

export async function readLiveCopilotUsernameForStatus(): Promise<string | null> {
  return readLiveCopilotUsername()
}

export async function getCopilotLoginStatus(accountId: string): Promise<CopilotLoginStatus> {
  const entry = await loadStoredCopilotAccount(accountId)
  if (!isValidCopilotEntry(entry)) {
    return { loggedIn: false, message: 'Chưa có auth Copilot' }
  }

  return {
    loggedIn: true,
    username: entry.username,
    targets: getSnapshotTargets(entry),
    hasOwnToken: Boolean(entry.githubToken)
  }
}

// ---------------------------------------------------------------------------
// GitHub device flow login (token riêng per-slot cho quota — CODE_REVIEW H1)
// ---------------------------------------------------------------------------

interface PendingLoginSession {
  controller: AbortController
  /** poll + lưu token đã kết thúc (thành công hoặc thất bại) */
  settled: boolean
  result?: GithubTokenResult
  error?: string
}

const pendingLogins = new Map<string, PendingLoginSession>()

/**
 * Mirror literal convention `COPILOT_DEVICE_FLOW_CANCELLED` của
 * copilot-device-flow.ts (dialog cũng mirror cùng literal). Không import value
 * qua mock boundary để tránh `undefined` trong unit test.
 */
const CANCELLED_LOGIN_MESSAGE = 'Đã hủy đăng nhập GitHub'

export interface CopilotDeviceLoginStart {
  userCode: string
  verificationUri: string
  expiresInSeconds: number
}

export async function startCopilotDeviceLogin(accountId: string): Promise<CopilotDeviceLoginStart> {
  const existingSession = pendingLogins.get(accountId)
  if (existingSession && !existingSession.settled) {
    throw new Error('Đang có phiên đăng nhập GitHub cho slot này. Hãy đợi hoặc hủy trước.')
  }
  // Cho phép ghi đè nếu lỡ còn entry đã settle trong map. Thực tế (R5 INFO 2):
  // cả `.then` lẫn `.catch` đều set `settled = true` rồi guard-delete ngay
  // KHÔNG có `await` nào xen giữa, nên map không bao giờ giữ entry đã settle
  // làm giá trị hiện tại — `existingSession` tồn tại ở đây đồng nghĩa chưa
  // settle. Giữ thêm `&& !settled` làm phòng thủ cho tương lai (vd nếu ai đó
  // chèn `await` giữa settle và delete), và để token đã lưu không bị chặn ghi đè.

  // R6 L6: register placeholder TRƯỚC await requestDeviceCode() — cửa sổ
  // network RTT (~0.5-2s) trước đây để cancel/unmount là no-op (map còn trống,
  // phiên vào map SAU khi cancel đã chạy) và double-click tạo 2 phiên song
  // song. Giờ: (a) cancel trong cửa sổ này abort placeholder → requestDeviceCode
  // nhận signal → fetch ném AbortError → catch dưới set settled, cleanup;
  // (b) start thứ 2 trong cửa sổ này thấy placeholder chưa settle → bị chặn đúng.
  const controller = new AbortController()
  const session: PendingLoginSession = { controller, settled: false }
  pendingLogins.set(accountId, session)

  let device
  try {
    device = await requestDeviceCode(controller.signal)
  } catch (error) {
    // requestDeviceCode fail (mạng/abort vì cancel) → phiên phải settle + cleanup
    // ngay để không chặn lần start sau (R6 L6): không có device code để poll.
    session.settled = true
    session.error = error instanceof Error ? error.message : String(error)
    if (pendingLogins.get(accountId) === session) pendingLogins.delete(accountId)
    throw error
  }

  // Poll ngầm; kết quả được lấy qua waitForCopilotDeviceLogin
  void pollForToken(device.device_code, device.interval, controller.signal)
    .then(async (result) => {
      const existing = await loadStoredCopilotAccount(accountId)
      if (!existing) {
        throw new Error('Slot chưa có auth Copilot. Hãy import auth từ VS Code trước.')
      }
      await saveStoredCopilotAccount(accountId, {
        ...existing,
        githubToken: result.accessToken,
        // N2: chỉ lưu login khi GitHub /user thực sự trả về — không "đoán"
        // login = username của slot khi verify lỗi (metadata phải trung thực;
        // fetchCopilotQuota vẫn so data.login thật khi hiển thị quota).
        // CODE_REVIEW_QUOTA_GROUPS_R3 M1: giữ githubLogin cũ khi verify lỗi
        // để không mất metadata của lần đăng nhập trước (result.login undefined
        // khi /user gặp lỗi mạng/rate limit). fetchCopilotQuota so data.login
        // thật nên githubLogin chỉ là metadata, giữ trung thực bằng null-threshold:
        // undefined = chưa verify được, '' = rỗng rõ ràng, string = xác thực.
        githubLogin: result.login ?? existing.githubLogin
      })
      session.settled = true
      session.result = result
      // M2a: cleanup phiên sau khi poll kết thúc, tránh leak khi UI không consume.
      // R4 M1: guard identity — poll của phiên cũ có thể settle MUỘN (save/IPC
      // chậm) sau khi waitFor timeout đã xóa map và user bắt đầu phiên mới;
      // delete vô điều kiện sẽ xóa mất session mới trong map.
      if (pendingLogins.get(accountId) === session) pendingLogins.delete(accountId)
    })
    .catch((error: unknown) => {
      // N2: giữ lại lỗi thật để waitForCopilotDeviceLogin ném đúng nguyên nhân
      // thay vì UI chỉ thấy "thất bại hoặc bị hủy"
      session.settled = true
      session.error = error instanceof Error ? error.message : String(error)
      // M2a: cleanup kể cả khi lỗi, phiên đã kết thúc.
      // R4 M1: cùng guard identity như nhánh then (race với cancel + start lại,
      // catch của abort chạy sau khi map đã chứa session mới).
      if (pendingLogins.get(accountId) === session) pendingLogins.delete(accountId)
    })

  return {
    userCode: device.user_code,
    verificationUri: device.verification_uri,
    expiresInSeconds: device.expires_in
  }
}

export async function waitForCopilotDeviceLogin(accountId: string): Promise<CopilotLoginStatus> {
  const session = pendingLogins.get(accountId)
  if (!session) {
    // Không có phiên pending — phiên đã tự cleanup sau khi settle (M2a) hoặc
    // chưa bắt đầu. Kiểm tra xem token đã lưu chưa.
    // R7 L2 (ghi chú, không đổi hành vi): nếu poll settle THẤT BẠI và map
    // đã trống, branch này đọc token của LẦN ĐĂNG NHẬP TRƯỚC — user có thể
    // thấy "thành công" của token cũ. Hiếm (đòi UI gọi waitFor muộn sau khi
    // settle + cleanup); giữ nguyên vì token cũ vẫn là trạng thái thật của slot.
    const status = await getCopilotLoginStatus(accountId)
    if (!status.hasOwnToken) {
      throw new Error('Không có phiên đăng nhập GitHub đang chạy. Hãy bắt đầu lại.')
    }
    return status
  }

  // Chờ tới khi phiên settle (hoàn tất/thất bại/hủy), tối đa 10 phút
  const startedAt = Date.now()
  while (!session.settled && Date.now() - startedAt < 600_000) {
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  if (!session.settled) {
    session.controller.abort()
    // M2b: chờ một lát cho catch handler của pollForToken kịp chạy và set settled
    await new Promise((resolve) => setTimeout(resolve, 500))
    // R7 M1: từ R6 L5, poll phản ứng abort NGAY (abortableSleep + fetch signal)
    // nên mọi lần timeout thật đều settle trong cửa sổ 500ms này với
    // session.error = CANCELLED_LOGIN_MESSAGE — chính vụ abort của TA gây ra,
    // không phải user hủy. Trước fix, waitFor ném session.error → dialog so
    // khớp message coi là user-cancel → nuốt lỗi im lặng, UI kẹt trạng thái
    // chờ vĩnh viễn và message timeout thành dead code. Giờ: settle vì abort
    // của ta (error == message hủy) hoặc chưa settle → ném lỗi TIMEOUT. Lỗi
    // THẬT khác (expired_token, 'Slot chưa có auth', save fail...) vẫn
    // propagate qua nhánh session.error bên dưới (giữ semantics N2), và settle
    // THÀNH CÔNG (session.result) rơi xuống path bình thường.
    const settledByOurAbort = session.settled && session.error === CANCELLED_LOGIN_MESSAGE
    if (!session.settled || settledByOurAbort) {
      // R5 LOW 1: guard identity — trong 500ms sleep này, cancel + start phiên
      // mới (IPC khác cùng slot) có thể đã put session KHÁC vào map; delete vô
      // điều kiện sẽ xóa nhầm session mới (cùng họ bug R4 M1).
      if (pendingLogins.get(accountId) === session) pendingLogins.delete(accountId)
      throw new Error('Hết thời gian chờ đăng nhập GitHub. Hãy thử lại.')
    }
  }

  // M2a: phiên đã tự cleanup khỏi map sau khi settle; ta vẫn còn reference session
  // để đọc kết quả. Xóa map nếu còn sót.
  if (pendingLogins.get(accountId) === session) pendingLogins.delete(accountId)

  if (session.error) {
    throw new Error(session.error)
  }

  const status = await getCopilotLoginStatus(accountId)
  if (!status.hasOwnToken) {
    throw new Error('Đăng nhập GitHub thất bại hoặc bị hủy. Hãy thử lại.')
  }

  // N2: token đã lưu nhưng KHÔNG xác minh được chủ token qua /user (mạng lỗi/
  // rate limit) → cảnh báo rõ trong status thay vì im lặng hiển thị thành công.
  if (session.result && !session.result.loginVerified) {
    const warning =
      '⚠ Chưa xác minh được tài khoản GitHub của token (không gọi được /user). ' +
      'Nếu token không đúng account, quota sẽ cảnh báo lệch khi tải.'
    status.message = status.message ? `${status.message} · ${warning}` : warning
  }

  return status
}

export async function cancelCopilotDeviceLogin(accountId: string): Promise<void> {
  const session = pendingLogins.get(accountId)
  if (session) {
    session.controller.abort()
    pendingLogins.delete(accountId)
  }
}

export async function importCopilotFromLive(accountId: string): Promise<CopilotLoginStatus> {
  const appData = await loadAppData()
  const account = findAccount(appData, accountId)
  const expectedUsername = account?.copilotUsername

  const { snapshots, username } = await captureLiveSnapshots(expectedUsername, ['vscode'])
  const vscodeSnapshot = snapshots.vscode
  if (!vscodeSnapshot) {
    throw new Error('Không đọc được snapshot VS Code')
  }

  const resolvedUsername = validateCopilotSnapshot(vscodeSnapshot, expectedUsername)
  const filteredEntries = filterEntriesForApply(vscodeSnapshot.entries, resolvedUsername)
  const authValue = filteredEntries[GITHUB_AUTH_SECRET_KEY]
  if (!authValue) {
    throw new Error('Snapshot thiếu github.auth secret sau khi lọc')
  }
  await assertAuthUniqueForAccount(accountId, authValue)

  const existing = await loadStoredCopilotAccount(accountId)
  await saveStoredCopilotAccount(accountId, {
    username: expectedUsername ?? resolvedUsername ?? existing?.username ?? '',
    snapshots: {
      ...existing?.snapshots,
      vscode: {
        username: resolvedUsername,
        entries: filteredEntries
      }
    }
  })

  return getCopilotLoginStatus(accountId)
}

function extractEntryFromPayload(payload: unknown): CopilotAccountEntry {
  if (!payload || typeof payload !== 'object') {
    throw new Error('File JSON không hợp lệ')
  }

  const data = payload as CopilotAccountEntry
  if (isValidCopilotEntry(data)) {
    return data
  }

  throw new Error('File không chứa snapshot Copilot hợp lệ')
}

export async function importCopilotFromFile(
  accountId: string,
  filePath: string
): Promise<CopilotLoginStatus> {
  const raw = await readFile(filePath, 'utf-8')
  const entry = extractEntryFromPayload(JSON.parse(raw) as unknown)

  // Live import đã check trùng auth; file import cũng phải check (CODE_REVIEW M3)
  const authValue = entry.snapshots?.vscode?.entries?.[GITHUB_AUTH_SECRET_KEY]
  if (authValue) {
    await assertAuthUniqueForAccount(accountId, authValue)
  }

  await saveStoredCopilotAccount(accountId, entry)
  return getCopilotLoginStatus(accountId)
}

export async function clearCopilotAuth(accountId: string): Promise<void> {
  await deleteStoredCopilotAccount(accountId)
}

export async function fetchCopilotQuota(accountId: string): Promise<AccountQuota> {
  const stored = await loadStoredCopilotAccount(accountId)
  if (!isValidCopilotEntry(stored)) {
    return buildEmptyQuota('Chưa đăng nhập Copilot. Hãy import từ VS Code/Cursor.')
  }

  // Ưu tiên token riêng của slot (device flow — quota ĐÚNG account);
  // fallback token machine-level (gh CLI / apps.json) cho slot cũ (CODE_REVIEW H1).
  const ownToken = stored.githubToken?.trim() || null
  const token = ownToken ?? (await resolveCopilotToken())
  if (!token) {
    return buildEmptyQuota(
      'Không tìm thấy GitHub token. Đăng nhập GitHub trong dialog slot này hoặc chạy `gh auth login`.'
    )
  }

  try {
    const response = await fetch('https://api.github.com/copilot_internal/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'X-GitHub-Api-Version': '2025-04-01',
        'Editor-Version': 'vscode/1.96.0',
        'Editor-Plugin-Version': 'copilot-chat/0.26.0',
        'User-Agent': 'GitHubCopilotChat/0.26.0'
      }
    })

    if (response.status === 401 || response.status === 403) {
      return buildEmptyQuota('GitHub token hết hạn hoặc không có quyền Copilot')
    }

    if (response.status === 404) {
      return buildEmptyQuota('Tài khoản không có GitHub Copilot hoặc endpoint không khả dụng')
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return buildEmptyQuota(`Không thể lấy quota Copilot (HTTP ${response.status}): ${text.slice(0, 120)}`)
    }

    const data = (await response.json()) as CopilotQuotaResponse
    const resetRaw = data.quota_reset_date ?? data.quota_reset_date_utc ?? data.limited_user_reset_date
    const resetTimestamp = resetRaw ? Date.parse(resetRaw) : NaN
    const resetsAt = Number.isFinite(resetTimestamp) ? Math.floor(resetTimestamp / 1000) : null

    const premium = mapPercentCategory(data.quota_snapshots?.premium_interactions, 'Premium')
    const chat = mapPercentCategory(data.quota_snapshots?.chat, 'Chat')
    const completions = mapPercentCategory(data.quota_snapshots?.completions, 'Completions')

    let hourly = chat ?? premium ?? completions ?? buildEmptyQuota().hourly
    let weekly = completions ?? premium ?? chat ?? buildEmptyQuota().weekly

    if (data.limited_user_quotas && data.monthly_quotas) {
      const chatUsed = Math.max(
        0,
        (data.monthly_quotas.chat ?? 0) - (data.limited_user_quotas.chat ?? 0)
      )
      const completionUsed = Math.max(
        0,
        (data.monthly_quotas.completions ?? 0) - (data.limited_user_quotas.completions ?? 0)
      )
      hourly = mapCountCategory(chatUsed, data.monthly_quotas.chat ?? 0, 'Chat')
      weekly = mapCountCategory(
        completionUsed,
        data.monthly_quotas.completions ?? 0,
        'Completions'
      )
    }

    if (resetsAt) {
      hourly = { ...hourly, resetsAt, resetAtLabel: formatResetAt(resetsAt) }
      weekly = { ...weekly, resetsAt, resetAtLabel: formatResetAt(resetsAt) }
    }

    const hasActiveLimits = hourly.limitCents > 0 || weekly.limitCents > 0
    const plan = data.copilot_plan ?? data.access_type_sku

    const slotUsername = stored.username?.trim()
    const loginMismatch = Boolean(
      data.login && slotUsername && data.login.toLowerCase() !== slotUsername.toLowerCase()
    )

    const messageParts = [
      loginMismatch
        ? ownToken
          ? `⚠ Token của slot này thuộc @${data.login}, không phải @${slotUsername} — hãy đăng nhập lại GitHub`
          : `⚠ Quota của @${data.login} (token máy), không phải @${slotUsername} — đăng nhập GitHub trong slot để xem đúng quota`
        : undefined,
      !ownToken && !loginMismatch
        ? 'Đang dùng token máy (gh CLI) — đăng nhập GitHub trong slot để khóa quota theo account'
        : undefined,
      plan ? `Plan: ${plan}` : undefined,
      slotUsername ? `GitHub: @${slotUsername}` : undefined
    ].filter(Boolean)

    return {
      available: true,
      hasActiveLimits,
      displayMode: 'percent',
      planType: plan,
      email: data.login ?? stored.username,
      message: messageParts.join(' · ') || undefined,
      windowLabels: {
        hourly: hourly.windowLabel,
        weekly: weekly.windowLabel
      },
      hourly,
      weekly,
      updatedAt: new Date().toISOString()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Lỗi mạng'
    return buildEmptyQuota(`Không thể lấy quota Copilot: ${message}`)
  }
}
