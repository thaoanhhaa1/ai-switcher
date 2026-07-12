import { readFile } from 'fs/promises'
import type { Account, AccountQuota, QuotaWindow } from '../../src/types'
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
import { applyAntigravityIdeAccount } from '../antigravity-ide'
import { runAntigravityOAuthLogin } from '../antigravity-oauth'
import { getAntigravityAccountsPath, getOpencodeConfigDir } from '../paths'
import { formatResetAt, formatResetLabelFromTimestamp } from '../quota-utils'
import { loadAppData } from '../storage'

export const ANTIGRAVITY_DOCS = 'https://github.com/NoeFabris/opencode-antigravity-auth'

const CLIENT_ID = 'REDACTED_ANTIGRAVITY_CLIENT_ID'
const CLIENT_SECRET = 'REDACTED_ANTIGRAVITY_CLIENT_SECRET'
const CLOUD_CODE_BASE = 'https://cloudcode-pa.googleapis.com'
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

interface QuotaGroup {
  remaining?: number
  resetTime?: string
  count: number
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

function mapQuotaGroup(group?: QuotaGroup, label?: string): QuotaWindow {
  const remainingFraction = group?.remaining
  const usedPercent =
    typeof remainingFraction === 'number'
      ? Math.min(100, Math.max(0, Math.round((1 - remainingFraction) * 100)))
      : 0
  const remainingPercent = Math.max(0, 100 - usedPercent)
  const resetTimestamp = group?.resetTime ? Date.parse(group.resetTime) : NaN
  const resetsAt = Number.isFinite(resetTimestamp) ? Math.floor(resetTimestamp / 1000) : null

  return {
    usedCents: usedPercent,
    limitCents: group && group.count > 0 ? 100 : 0,
    remainingCents: remainingPercent,
    usedPercent,
    remainingPercent,
    resetsAt,
    resetsInLabel: resetsAt ? formatResetLabelFromTimestamp(resetsAt) : '',
    windowLabel: label,
    resetAtLabel: resetsAt ? formatResetAt(resetsAt) : ''
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
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
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

function classifyGroup(modelName: string): 'claude' | 'gemini-pro' | 'gemini-flash' | null {
  const lower = modelName.toLowerCase()
  if (lower.includes('claude')) return 'claude'
  if (!lower.includes('gemini-3')) return null
  if (lower.includes('flash')) return 'gemini-flash'
  return 'gemini-pro'
}

function updateGroup(
  groups: Record<string, QuotaGroup>,
  group: string,
  remainingFraction: number,
  resetTime?: string
) {
  const entry = groups[group] ?? { count: 0 }
  entry.count += 1
  if (typeof remainingFraction === 'number') {
    entry.remaining =
      entry.remaining === undefined ? remainingFraction : Math.min(entry.remaining, remainingFraction)
  }
  if (resetTime) {
    const timestamp = Date.parse(resetTime)
    if (Number.isFinite(timestamp)) {
      if (!entry.resetTime) {
        entry.resetTime = resetTime
      } else {
        const existing = Date.parse(entry.resetTime)
        if (!Number.isFinite(existing) || timestamp < existing) {
          entry.resetTime = resetTime
        }
      }
    }
  }
  groups[group] = entry
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

    const response = await postJson(
      `${CLOUD_CODE_BASE}/v1internal:fetchAvailableModels`,
      accessToken,
      projectId ? { project: projectId } : {}
    )

    if (response.status === 401) {
      return buildEmptyQuota('Phiên Google hết hạn. Hãy đăng nhập lại')
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return buildEmptyQuota(`Không thể lấy quota Antigravity (HTTP ${response.status}): ${text.slice(0, 120)}`)
    }

    const data = (await response.json()) as {
      models?: Record<string, { quotaInfo?: { remainingFraction?: number; resetTime?: string } }>
    }

    const groups: Record<string, QuotaGroup> = {}
    for (const [modelName, info] of Object.entries(data.models ?? {})) {
      const group = classifyGroup(modelName)
      if (!group || !info?.quotaInfo) continue
      updateGroup(
        groups,
        group,
        info.quotaInfo.remainingFraction ?? 0,
        info.quotaInfo.resetTime
      )
    }

    const claude = mapQuotaGroup(groups.claude, 'Claude')
    const geminiPro = mapQuotaGroup(groups['gemini-pro'], 'Gemini 3 Pro')
    const geminiFlash = mapQuotaGroup(groups['gemini-flash'], 'Gemini 3 Flash')
    const hasActiveLimits =
      claude.limitCents > 0 || geminiPro.limitCents > 0 || geminiFlash.limitCents > 0

    const limitedGroups = [claude, geminiPro, geminiFlash].filter((item) => item.usedPercent >= 100)
    const messageParts = [
      entry.email ? `Google: ${entry.email}` : undefined,
      projectId ? `Project: ${projectId}` : undefined,
      limitedGroups.length ? `${limitedGroups.length} nhóm đã chạm giới hạn` : undefined
    ].filter(Boolean)

    return {
      available: true,
      hasActiveLimits,
      displayMode: 'percent',
      email: entry.email,
      message: messageParts.join(' · ') || undefined,
      limitReached: limitedGroups.length > 0,
      windowLabels: {
        hourly: 'Claude',
        weekly: 'Gemini 3 Pro',
        codeReview: 'Gemini 3 Flash'
      },
      hourly: claude,
      weekly: geminiPro,
      codeReview: geminiFlash.limitCents > 0 ? geminiFlash : null,
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
