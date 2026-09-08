import { readFile } from 'fs/promises'
import type { Account, AccountQuota, QuotaWindow } from '../../../src/types'
import {
  deleteStoredAntigravityAccount,
  findAccountIndexByEmail,
  isValidAntigravityEntry,
  loadStoredAntigravityAccount,
  mergeAccountEntry,
  normalizeAntigravityEntry,
  readLiveAntigravityAccounts,
  saveStoredAntigravityAccount,
  writeLiveAntigravityAccounts,
  type AntigravityAccountEntry,
  type AntigravityAccountsFile
} from '../antigravity-auth-storage'
import {
  parseAntigravityModelQuotas,
  type AvailableModelsResponse,
  type QuotaSummaryResponse
} from '../antigravity-quota'
import { applyAntigravityIdeAccount } from '../antigravity-ide'
import { runAntigravityOAuthLogin } from '../antigravity-oauth'
import { getAntigravityOAuthCredentials } from '../antigravity-oauth-config'
import { getAntigravityAccountsPath, getOpencodeConfigDir } from '../paths'
import { loadAppData } from '../storage'

export const ANTIGRAVITY_DOCS = 'https://github.com/NoeFabris/opencode-antigravity-auth'

const CLOUD_CODE_BASE = 'https://cloudcode-pa.googleapis.com'
// Antigravity IDE route qua host daily trước — model list + quota trên daily mới nhất
// (vd gemini-3.8-flash-tiered chỉ xuất hiện trên daily). Prod là fallback.
const CLOUD_CODE_BASES = [
  'https://daily-cloudcode-pa.googleapis.com',
  CLOUD_CODE_BASE
] as const
const USER_AGENT = 'antigravity/windows/amd64'
const FALLBACK_PROJECT_ID = 'bamboo-precept-lgxtn'

export const DEFAULT_ANTIGRAVITY_SETTINGS = {
  model: 'claude',
  modelReasoningEffort: 'high' as const
}

export interface AntigravityLoginStatus {
  loggedIn: boolean
  email?: string
  projectId?: string
  message?: string
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

async function postJson(url: string, token: string, body: unknown, extraHeaders: Record<string, string> = {}) {
  return fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      ...extraHeaders
    },
    body: JSON.stringify(body)
  })
}

interface RefreshedGoogleToken {
  accessToken: string
  expiresIn: number
}

async function refreshGoogleToken(refreshToken: string): Promise<RefreshedGoogleToken> {
  const { clientId, clientSecret } = await getAntigravityOAuthCredentials()
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret
    })
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Token refresh failed (${response.status}): ${text.slice(0, 200)}`)
  }

  const payload = (await response.json()) as { access_token?: string; expires_in?: number }
  if (!payload.access_token) {
    throw new Error('Token refresh không trả về access_token')
  }
  return {
    accessToken: payload.access_token,
    expiresIn: payload.expires_in ?? 3600
  }
}

async function loadProjectId(accessToken: string): Promise<string> {
  const response = await postJson(`${CLOUD_CODE_BASE}/v1internal:loadCodeAssist`, accessToken, {
    metadata: { ideType: 'ANTIGRAVITY' }
  })
  if (!response.ok) {
    return ''
  }

  const payload = (await response.json()) as {
    cloudaicompanionProject?: string | { id?: string }
  }

  if (typeof payload.cloudaicompanionProject === 'string') {
    return payload.cloudaicompanionProject
  }
  if (payload.cloudaicompanionProject && typeof payload.cloudaicompanionProject.id === 'string') {
    return payload.cloudaicompanionProject.id
  }
  return ''
}

/**
 * retrieveUserQuotaSummary — quota THẬT theo nhóm model (weekly/5h).
 * fetchAvailableModels chỉ là placeholder (=1) với model còn hạn mức nhóm,
 * nên phải gọi thêm endpoint này mới ra con số usage thật.
 */
async function loadQuotaSummary(
  accessToken: string,
  projectId: string
): Promise<QuotaSummaryResponse | null> {
  for (const base of CLOUD_CODE_BASES) {
    try {
      const response = await postJson(
        `${base}/v1internal:retrieveUserQuotaSummary`,
        accessToken,
        projectId ? { project: projectId } : {}
      )
      if (response.status === 401) return null
      if (!response.ok) continue
      const payload = (await response.json()) as QuotaSummaryResponse
      if (payload?.groups?.length) return payload
    } catch {
      // thử host kế tiếp
    }
  }
  return null
}

/**
 * fetchAvailableModels — try daily first (model list mới nhất, match IDE), prod fallback.
 */
async function fetchAvailableModels(
  accessToken: string,
  projectId: string
): Promise<{ data?: AvailableModelsResponse; status: number; text: string }> {
  let lastStatus = 0
  let lastText = ''
  for (const base of CLOUD_CODE_BASES) {
    try {
      const response = await postJson(
        `${base}/v1internal:fetchAvailableModels`,
        accessToken,
        projectId ? { project: projectId } : {}
      )
      lastStatus = response.status
      if (response.ok) {
        return { data: (await response.json()) as AvailableModelsResponse, status: response.status, text: '' }
      }
      lastText = await response.text().catch(() => '')
      if (response.status === 401) {
        return { status: response.status, text: lastText }
      }
    } catch {
      // thử host kế tiếp
    }
  }
  return { status: lastStatus, text: lastText }
}

function extractEntryFromPayload(payload: unknown): AntigravityAccountEntry {
  if (!payload || typeof payload !== 'object') {
    throw new Error('File JSON không hợp lệ')
  }

  const data = payload as AntigravityAccountsFile & AntigravityAccountEntry
  if (Array.isArray(data.accounts) && data.accounts.length > 0) {
    const activeIndex = data.activeIndex ?? 0
    const entry = data.accounts[activeIndex] ?? data.accounts[0]
    if (!isValidAntigravityEntry(entry)) {
      throw new Error('File không chứa refreshToken hợp lệ')
    }
    return entry
  }

  if (isValidAntigravityEntry(data)) {
    return data
  }

  throw new Error('File không chứa tài khoản Antigravity hợp lệ')
}

export async function buildLiveAccountsFile(activeAccountId: string): Promise<AntigravityAccountsFile> {
  const appData = await loadAppData()
  const antigravityAccounts = appData.accounts.filter((account) => account.provider === 'antigravity')
  const entries: AntigravityAccountEntry[] = []

  for (const account of antigravityAccounts) {
    const stored = await loadStoredAntigravityAccount(account.id)
    if (isValidAntigravityEntry(stored)) {
      entries.splice(0, entries.length, ...mergeAccountEntry(entries, stored))
    }
  }

  const activeEntry = await loadStoredAntigravityAccount(activeAccountId)
  if (!isValidAntigravityEntry(activeEntry)) {
    throw new Error('Tài khoản Antigravity chưa có auth. Hãy login hoặc import antigravity-accounts.json')
  }

  const accounts = mergeAccountEntry(entries, activeEntry)
  const activeIndex = findAccountIndexByEmail({ accounts }, activeEntry.email)
  const live = await readLiveAntigravityAccounts()

  return {
    version: 3,
    accounts,
    activeIndex: activeIndex >= 0 ? activeIndex : 0,
    activeIndexByFamily: live?.activeIndexByFamily ?? {
      claude: activeIndex >= 0 ? activeIndex : 0,
      gemini: activeIndex >= 0 ? activeIndex : 0
    }
  }
}

export async function applyAntigravityAccount(account: Account): Promise<void> {
  const live = await buildLiveAccountsFile(account.id)
  await writeLiveAntigravityAccounts(live)

  const activeIndex = live.activeIndex ?? 0
  const activeEntry = normalizeAntigravityEntry(live.accounts[activeIndex])
  if (!isValidAntigravityEntry(activeEntry)) {
    return
  }

  const tokens = await refreshGoogleToken(activeEntry.refreshToken)
  await applyAntigravityIdeAccount(activeEntry, tokens)
}

export async function snapshotLiveAntigravityToAccount(accountId: string): Promise<void> {
  const live = await readLiveAntigravityAccounts()
  if (!live?.accounts.length) return

  const activeIndex = live.activeIndex ?? 0
  const entry = live.accounts[activeIndex]
  if (!isValidAntigravityEntry(entry)) return

  await saveStoredAntigravityAccount(accountId, entry)
}

export async function readLiveAntigravityEmail(): Promise<string | null> {
  const live = await readLiveAntigravityAccounts()
  if (!live?.accounts.length) return null
  const activeIndex = live.activeIndex ?? 0
  return live.accounts[activeIndex]?.email ?? null
}

export async function getAntigravityLoginStatus(accountId: string): Promise<AntigravityLoginStatus> {
  const entry = await loadStoredAntigravityAccount(accountId)
  if (!isValidAntigravityEntry(entry)) {
    return { loggedIn: false, message: 'Chưa có auth Antigravity' }
  }

  return {
    loggedIn: true,
    email: entry.email,
    projectId: entry.projectId ?? entry.managedProjectId
  }
}

export async function runAntigravityLogin(accountId: string): Promise<AntigravityLoginStatus> {
  const entry = normalizeAntigravityEntry(await runAntigravityOAuthLogin())
  await saveStoredAntigravityAccount(accountId, entry)
  return getAntigravityLoginStatus(accountId)
}

export async function importAntigravityFromLive(accountId: string): Promise<AntigravityLoginStatus> {
  const livePath = getAntigravityAccountsPath()
  const live = await readLiveAntigravityAccounts()
  if (!live?.accounts.length) {
    throw new Error(
      `Chưa có file tại ${livePath}. Dùng "Đăng nhập Google OAuth" hoặc chọn file antigravity-accounts.json.`
    )
  }

  const activeIndex = live.activeIndex ?? 0
  const entry = normalizeAntigravityEntry(live.accounts[activeIndex])
  if (!isValidAntigravityEntry(entry)) {
    throw new Error('File live không có refreshToken hợp lệ')
  }

  await saveStoredAntigravityAccount(accountId, entry)
  return getAntigravityLoginStatus(accountId)
}

export async function importAntigravityFromFile(
  accountId: string,
  filePath: string
): Promise<AntigravityLoginStatus> {
  const raw = await readFile(filePath, 'utf-8')
  const entry = normalizeAntigravityEntry(extractEntryFromPayload(JSON.parse(raw) as unknown))
  await saveStoredAntigravityAccount(accountId, entry)
  return getAntigravityLoginStatus(accountId)
}

export async function clearAntigravityAuth(accountId: string): Promise<void> {
  await deleteStoredAntigravityAccount(accountId)
}

export async function fetchAntigravityQuota(accountId: string): Promise<AccountQuota> {
  const stored = await loadStoredAntigravityAccount(accountId)
  const entry = stored ? normalizeAntigravityEntry(stored) : null
  if (!isValidAntigravityEntry(entry)) {
    return buildEmptyQuota('Chưa đăng nhập Antigravity. Hãy login hoặc import antigravity-accounts.json')
  }

  try {
    const { accessToken } = await refreshGoogleToken(entry.refreshToken)
    let projectId = await loadProjectId(accessToken)
    if (!projectId) {
      projectId = entry.managedProjectId ?? entry.projectId ?? FALLBACK_PROJECT_ID
    }

    const [modelsResult, summary] = await Promise.all([
      fetchAvailableModels(accessToken, projectId),
      loadQuotaSummary(accessToken, projectId)
    ])

    if (modelsResult.status === 401) {
      return buildEmptyQuota('Phiên Google hết hạn. Hãy đăng nhập lại')
    }

    if (!modelsResult.data) {
      return buildEmptyQuota(
        `Không thể lấy quota Antigravity (HTTP ${modelsResult.status}): ${modelsResult.text.slice(0, 120)}`
      )
    }

    // Quota ĐỘNG theo model: danh sách model từ fetchAvailableModels
    // (agentModelSorts/command/image/tiered) + usage THẬT từ retrieveUserQuotaSummary.
    const models = parseAntigravityModelQuotas(modelsResult.data, summary)

    const emptyWindow: QuotaWindow = {
      usedCents: 0,
      limitCents: 0,
      remainingCents: 0,
      usedPercent: 0,
      remainingPercent: 0,
      resetsAt: null,
      resetsInLabel: ''
    }

    const hasActiveLimits = models.length > 0
    const limitedModels = models.filter((model) => model.usedPercent >= 100)
    const messageParts = [
      entry.email ? `Google: ${entry.email}` : undefined,
      projectId ? `Project: ${projectId}` : undefined,
      limitedModels.length
        ? `${limitedModels.length}/${models.length} model đã chạm giới hạn`
        : undefined
    ].filter(Boolean)

    return {
      available: true,
      hasActiveLimits,
      displayMode: 'percent',
      email: entry.email,
      message: messageParts.join(' · ') || undefined,
      limitReached: limitedModels.length > 0,
      models,
      // hourly/weekly là field legacy (chỉ render khi models rỗng — QuotaPanel
      // ưu tiên models). Điền giá trị trung tính thay vì ép models[0..1] vào
      // ngữ nghĩa "Quota 5 giờ/7 ngày" sai lệch (CODE_REVIEW L6).
      hourly: emptyWindow,
      weekly: emptyWindow,
      codeReview: null,
      updatedAt: new Date().toISOString()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Lỗi mạng'
    return buildEmptyQuota(`Không thể lấy quota Antigravity: ${message}`)
  }
}

export function getAntigravityConfigDirPath(): string {
  return getOpencodeConfigDir()
}

export function getAntigravityLiveAccountsPath(): string {
  return getAntigravityAccountsPath()
}
