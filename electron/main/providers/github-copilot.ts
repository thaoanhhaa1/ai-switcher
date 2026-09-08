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

function mapPercentCategory(
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
    targets: getSnapshotTargets(entry)
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

  const token = await resolveCopilotToken()
  if (!token) {
    return buildEmptyQuota(
      'Không tìm thấy GitHub token. Chạy `gh auth login` hoặc đăng nhập Copilot trong IDE.'
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

    // Token dùng để đọc quota là token MACHINE-LEVEL (gh CLI / apps.json),
    // không phải token của slot → phải cảnh báo khi login của token ≠ username slot
    // (xem CODE_REVIEW H1 — tránh hiển thị quota của account khác như của slot này).
    const slotUsername = stored.username?.trim()
    const loginMismatch = Boolean(
      data.login && slotUsername && data.login.toLowerCase() !== slotUsername.toLowerCase()
    )

    const messageParts = [
      loginMismatch
        ? `⚠ Quota của @${data.login} (token máy), không phải @${slotUsername} của slot này`
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
