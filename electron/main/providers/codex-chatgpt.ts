import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Account, AccountQuota, CodexFreeModelSettings } from '../../src/types'
import { runCodexLogin } from '../codex-cli'
import {
  deleteStoredAuth,
  isChatGptAuth,
  loadStoredAuth,
  parseChatGptIdentity,
  readLiveAuth,
  saveStoredAuth,
  writeLiveAuth,
  type CodexAuthJson
} from '../codex-auth-storage'
import { getCodexConfigPath, getCodexHome } from '../paths'
import {
  formatPlanType,
  formatResetAt,
  formatResetLabelFromSeconds,
  formatResetLabelFromTimestamp,
  inferWindowLabel
} from '../quota-utils'
import type { QuotaWindow } from '../../src/types'

export const CODEX_CHATGPT_DOCS = 'https://developers.openai.com/codex/auth'

export const DEFAULT_CHATGPT_SETTINGS: CodexFreeModelSettings = {
  model: 'gpt-5.4',
  modelReasoningEffort: 'xhigh'
}

interface WhamUsageWindow {
  used_percent?: number
  reset_after_seconds?: number
  reset_at?: number
  limit_window_seconds?: number
  limit?: number
  used?: number
}

interface WhamRateLimit {
  allowed?: boolean
  limit_reached?: boolean
  primary_window?: WhamUsageWindow
  secondary_window?: WhamUsageWindow
}

interface WhamUsageResponse {
  plan_type?: string
  email?: string
  rate_limit?: WhamRateLimit
  code_review_rate_limit?: WhamRateLimit
  credits?: {
    has_credits?: boolean
    unlimited?: boolean
    balance?: string
  }
}

function mapPercentWindow(window?: WhamUsageWindow): QuotaWindow {
  const usedPercent = Math.min(100, Math.max(0, Math.round(window?.used_percent ?? 0)))
  const remainingPercent = Math.max(0, 100 - usedPercent)
  const now = Math.floor(Date.now() / 1000)
  const resetsAt =
    window?.reset_at ??
    (window?.reset_after_seconds ? now + window.reset_after_seconds : null)
  const windowLabel = inferWindowLabel(window?.limit_window_seconds)

  return {
    usedCents: usedPercent,
    limitCents: 100,
    remainingCents: remainingPercent,
    usedPercent,
    remainingPercent,
    usedUnits: window?.used,
    limitUnits: window?.limit,
    resetsAt,
    resetsInLabel: window?.reset_after_seconds
      ? formatResetLabelFromSeconds(window.reset_after_seconds)
      : formatResetLabelFromTimestamp(resetsAt ?? undefined),
    windowLabel,
    windowSeconds: window?.limit_window_seconds,
    resetAtLabel: resetsAt ? formatResetAt(resetsAt) : ''
  }
}

function buildEmptyQuota(message?: string): AccountQuota {
  const empty = mapPercentWindow()
  return {
    available: false,
    hasActiveLimits: false,
    message,
    hourly: empty,
    weekly: empty,
    updatedAt: new Date().toISOString()
  }
}

function buildConfigToml(settings: CodexFreeModelSettings): string {
  return [
    `model = "${settings.model}"`,
    `model_reasoning_effort = "${settings.modelReasoningEffort}"`,
    'cli_auth_credentials_store = "file"',
    'preferred_auth_method = "chatgpt"'
  ].join('\n')
}

export async function importChatGptAuthFromLive(accountId: string): Promise<CodexAuthJson> {
  const auth = await readLiveAuth()
  if (!isChatGptAuth(auth)) {
    throw new Error('~/.codex/auth.json hiện không phải tài khoản ChatGPT OAuth')
  }

  await saveStoredAuth(accountId, auth)
  return auth
}

export async function importChatGptAuthFromFile(
  accountId: string,
  filePath: string
): Promise<CodexAuthJson> {
  const raw = await readFile(filePath, 'utf-8')
  const auth = JSON.parse(raw) as CodexAuthJson
  if (!isChatGptAuth(auth)) {
    throw new Error('File auth.json không hợp lệ hoặc không phải ChatGPT OAuth')
  }

  await saveStoredAuth(accountId, auth)
  return auth
}

export async function runChatGptLogin(): Promise<CodexAuthJson> {
  const tempHome = await mkdtemp(join(tmpdir(), 'ai-switcher-codex-'))
  const authPath = join(tempHome, 'auth.json')

  await runCodexLogin(tempHome)

  const raw = await readFile(authPath, 'utf-8')
  const auth = JSON.parse(raw) as CodexAuthJson
  if (!isChatGptAuth(auth)) {
    throw new Error('Đăng nhập không thành công hoặc auth.json không hợp lệ')
  }

  try {
    await unlink(authPath)
  } catch {
    // ignore cleanup
  }

  return auth
}

export async function snapshotLiveAuthToAccount(accountId: string): Promise<void> {
  const live = await readLiveAuth()
  if (!isChatGptAuth(live)) {
    return
  }
  await saveStoredAuth(accountId, live)
}

export async function applyCodexChatGptAccount(account: Account): Promise<void> {
  const auth = await loadStoredAuth(account.id)
  if (!isChatGptAuth(auth)) {
    throw new Error('Tài khoản ChatGPT chưa đăng nhập. Hãy login hoặc import auth.json')
  }

  await mkdir(getCodexHome(), { recursive: true })
  await writeLiveAuth(auth)
  await writeFile(getCodexConfigPath(), buildConfigToml(account.settings), 'utf-8')
}

export async function readLiveChatGptAccountId(): Promise<string | null> {
  const auth = await readLiveAuth()
  if (!isChatGptAuth(auth)) {
    return null
  }
  return parseChatGptIdentity(auth).accountId ?? auth.tokens.account_id ?? null
}

export async function fetchChatGptQuota(accountId: string): Promise<AccountQuota> {
  const auth = await loadStoredAuth(accountId)
  if (!isChatGptAuth(auth)) {
    return buildEmptyQuota('Chưa đăng nhập ChatGPT. Hãy login hoặc import auth.json')
  }

  try {
    const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      headers: {
        Authorization: `Bearer ${auth.tokens.access_token}`,
        'chatgpt-account-id': auth.tokens.account_id,
        'User-Agent': 'codex-cli',
        Accept: 'application/json'
      }
    })

    if (response.status === 401) {
      return buildEmptyQuota('Phiên ChatGPT hết hạn. Hãy đăng nhập lại')
    }

    if (!response.ok) {
      return buildEmptyQuota(`Không thể lấy quota ChatGPT (HTTP ${response.status})`)
    }

    const payload = (await response.json()) as WhamUsageResponse
    const primary = payload.rate_limit?.primary_window
    const secondary = payload.rate_limit?.secondary_window
    const hasActiveLimits = Boolean(primary || secondary)
    const hourly = mapPercentWindow(primary)
    const weekly = mapPercentWindow(secondary)
    const codeReviewPrimary = payload.code_review_rate_limit?.primary_window
    const planLabel = formatPlanType(payload.plan_type)
    const limitReached = Boolean(payload.rate_limit?.limit_reached)
    const allowed = payload.rate_limit?.allowed

    let message: string | undefined
    if (planLabel) {
      message = `Gói: ${planLabel}`
    }
    if (limitReached) {
      message = message ? `${message} · Đã chạm giới hạn` : 'Đã chạm giới hạn rate limit'
    } else if (allowed === false) {
      message = message ? `${message} · Tạm thời không được phép dùng` : 'Tạm thời không được phép dùng'
    }

    return {
      available: true,
      hasActiveLimits,
      displayMode: 'percent',
      planType: payload.plan_type,
      email: payload.email,
      allowed,
      limitReached,
      message,
      credits: payload.credits
        ? {
            hasCredits: Boolean(payload.credits.has_credits),
            unlimited: Boolean(payload.credits.unlimited),
            balance: payload.credits.balance
          }
        : undefined,
      codeReview: codeReviewPrimary ? mapPercentWindow(codeReviewPrimary) : null,
      hourly,
      weekly,
      updatedAt: new Date().toISOString()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Lỗi mạng'
    return buildEmptyQuota(`Không thể lấy quota ChatGPT: ${message}`)
  }
}

export async function getChatGptLoginStatus(accountId: string): Promise<{
  loggedIn: boolean
  email?: string
  accountId?: string
  planType?: string
  message?: string
}> {
  const auth = await loadStoredAuth(accountId)
  if (!isChatGptAuth(auth)) {
    return { loggedIn: false, message: 'Chưa có auth ChatGPT' }
  }

  const identity = parseChatGptIdentity(auth)
  return {
    loggedIn: true,
    email: identity.email,
    accountId: identity.accountId,
    planType: identity.planType
  }
}

export async function clearChatGptAuth(accountId: string): Promise<void> {
  await deleteStoredAuth(accountId)
}
