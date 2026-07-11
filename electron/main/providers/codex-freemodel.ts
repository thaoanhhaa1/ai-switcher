import { mkdir, readFile, writeFile } from 'fs/promises'
import TOML from '@iarna/toml'
import type { Account, AccountQuota, CodexFreeModelSettings, ProviderModelOption, QuotaWindow } from '../../src/types'
import { fetchFreeModelUsageWithSession } from '../freemodel-auth'
import { getCodexAuthPath, getCodexConfigPath, getCodexHome } from '../paths'

export const FREEMODEL_CODEX_DOCS = 'https://freemodel.dev/dashboard/docs#codex'
export const FREEMODEL_BASE_URL = 'https://api.freemodel.dev'
export const FREEMODEL_DASHBOARD_URL = 'https://freemodel.dev'

interface FreeModelQuotaWindow {
  usedCents?: number
  limitCents?: number
  resetsAt?: number
}

interface FreeModelUsageResponse {
  window5h?: FreeModelQuotaWindow
  windowWeek?: FreeModelQuotaWindow
  totalRequests?: number
  totalTokens?: number
}

function formatResetLabel(resetsAt?: number): string {
  if (!resetsAt) return ''

  const seconds = resetsAt - Math.floor(Date.now() / 1000)
  if (seconds <= 0) return 'Đang reset...'
  if (seconds < 60) return `Reset sau ${seconds}s`
  if (seconds < 3600) return `Reset sau ${Math.ceil(seconds / 60)} phút`

  const hours = Math.floor(seconds / 3600)
  const minutes = Math.ceil((seconds % 3600) / 60)
  if (seconds < 86400) return `Reset sau ${hours}h ${minutes}p`

  const days = Math.floor(seconds / 86400)
  return `Reset sau ${days} ngày`
}

function normalizeQuotaWindow(window?: FreeModelQuotaWindow): QuotaWindow {
  const usedCents = window?.usedCents ?? 0
  const limitCents = window?.limitCents ?? 0
  const remainingCents = Math.max(0, limitCents - usedCents)
  const usedPercent = limitCents > 0 ? Math.min(100, Math.round((usedCents / limitCents) * 100)) : 0

  return {
    usedCents,
    limitCents,
    remainingCents,
    usedPercent,
    remainingPercent: limitCents > 0 ? Math.max(0, 100 - usedPercent) : 0,
    resetsAt: window?.resetsAt ?? null,
    resetsInLabel: formatResetLabel(window?.resetsAt)
  }
}

function buildEmptyQuota(message?: string): AccountQuota {
  const empty = normalizeQuotaWindow()
  return {
    available: false,
    hasActiveLimits: false,
    message,
    hourly: empty,
    weekly: empty,
    updatedAt: new Date().toISOString()
  }
}

function normalizeUsageResponse(data: FreeModelUsageResponse): AccountQuota {
  const hourly = normalizeQuotaWindow(data.window5h)
  const weekly = normalizeQuotaWindow(data.windowWeek)
  const hasActiveLimits = hourly.limitCents > 0 || weekly.limitCents > 0

  return {
    available: true,
    hasActiveLimits,
    message: hasActiveLimits ? undefined : 'Tài khoản Free — chưa có cửa sổ quota active',
    hourly,
    weekly,
    updatedAt: new Date().toISOString()
  }
}

async function fetchUsageFromEndpoint(
  url: string,
  apiKey: string
): Promise<FreeModelUsageResponse | null> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      Accept: 'application/json'
    }
  })

  if (!response.ok) {
    return null
  }

  return (await response.json()) as FreeModelUsageResponse
}

export async function fetchFreeModelQuota(accountId: string, apiKey: string): Promise<AccountQuota> {
  const trimmedKey = apiKey.trim()

  try {
    const sessionResponse = await fetchFreeModelUsageWithSession(accountId)
    if (sessionResponse) {
      const data = (await sessionResponse.json()) as FreeModelUsageResponse
      return normalizeUsageResponse(data)
    }

    if (!trimmedKey) {
      return buildEmptyQuota('Đăng nhập FreeModel để xem quota')
    }

    const endpoints = [
      `${FREEMODEL_DASHBOARD_URL}/api/usage`,
      `${FREEMODEL_BASE_URL}/api/usage`
    ]

    for (const endpoint of endpoints) {
      const data = await fetchUsageFromEndpoint(endpoint, trimmedKey)
      if (data) {
        return normalizeUsageResponse(data)
      }
    }

    return buildEmptyQuota('Cần đăng nhập FreeModel để đọc quota usage')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Lỗi mạng'
    return buildEmptyQuota(`Không thể lấy quota: ${message}`)
  }
}

export const DEFAULT_CODEX_SETTINGS: CodexFreeModelSettings = {
  model: 'gpt-5.5-codex',
  modelReasoningEffort: 'xhigh'
}

export const CODEX_REASONING_EFFORTS: Array<{
  value: CodexFreeModelSettings['modelReasoningEffort']
  label: string
}> = [
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' }
]

interface FreeModelListResponse {
  data?: Array<{
    id: string
    owned_by?: string
  }>
}

type TomlRecord = Record<string, unknown>

function buildConfigToml(settings: CodexFreeModelSettings): string {
  const doc = {
    model_provider: 'freemodel',
    model: settings.model,
    model_reasoning_effort: settings.modelReasoningEffort,
    disable_response_storage: true,
    preferred_auth_method: 'apikey',
    model_providers: {
      freemodel: {
        name: 'freemodel',
        base_url: FREEMODEL_BASE_URL,
        wire_api: 'responses',
        requires_openai_auth: false,
        env_key: 'FREEMODEL_API_KEY'
      }
    }
  }

  return TOML.stringify(doc as TOML.JsonMap)
}

export async function applyCodexFreeModelAccount(account: Account): Promise<void> {
  const codexHome = getCodexHome()
  await mkdir(codexHome, { recursive: true })

  const auth = {
    OPENAI_API_KEY: account.apiKey,
    FREEMODEL_API_KEY: account.apiKey
  }

  await writeFile(getCodexAuthPath(), JSON.stringify(auth, null, 2), 'utf-8')
  await writeFile(getCodexConfigPath(), buildConfigToml(account.settings), 'utf-8')
}

export async function readCodexAuthKey(): Promise<string | null> {
  try {
    const raw = await readFile(getCodexAuthPath(), 'utf-8')
    const auth = JSON.parse(raw) as Record<string, string>
    return auth.FREEMODEL_API_KEY ?? auth.OPENAI_API_KEY ?? null
  } catch {
    return null
  }
}

export async function fetchFreeModelModels(apiKey?: string): Promise<ProviderModelOption[]> {
  const headers: Record<string, string> = {}
  if (apiKey?.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`
  }

  const response = await fetch(`${FREEMODEL_BASE_URL}/v1/models`, { headers })

  if (!response.ok) {
    throw new Error(`Không thể tải danh sách model (HTTP ${response.status})`)
  }

  const payload = (await response.json()) as FreeModelListResponse
  const models = (payload.data ?? [])
    .map((item) => ({
      id: item.id,
      ownedBy: item.owned_by
    }))
    .sort((a, b) => a.id.localeCompare(b.id))

  return models
}

export async function getCodexFreeModelOptions(apiKey?: string): Promise<{
  models: ProviderModelOption[]
  reasoningEfforts: typeof CODEX_REASONING_EFFORTS
}> {
  const models = await fetchFreeModelModels(apiKey)
  return {
    models,
    reasoningEfforts: CODEX_REASONING_EFFORTS
  }
}

export async function validateFreeModelKey(apiKey: string): Promise<{ valid: boolean; message: string }> {
  try {
    const response = await fetch(`${FREEMODEL_BASE_URL}/v1/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    })

    if (response.ok) {
      return { valid: true, message: 'API key hợp lệ' }
    }

    if (response.status === 401 || response.status === 403) {
      return { valid: false, message: 'API key không hợp lệ hoặc đã hết hạn' }
    }

    return {
      valid: false,
      message: `Không thể xác thực key (HTTP ${response.status})`
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Lỗi mạng'
    return { valid: false, message: `Không thể kết nối FreeModel: ${message}` }
  }
}

export function parseCodexConfig(raw: string): Partial<CodexFreeModelSettings> {
  try {
    const parsed = TOML.parse(raw) as TomlRecord
    return {
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
      modelReasoningEffort:
        parsed.model_reasoning_effort === 'low' ||
        parsed.model_reasoning_effort === 'medium' ||
        parsed.model_reasoning_effort === 'high' ||
        parsed.model_reasoning_effort === 'xhigh'
          ? parsed.model_reasoning_effort
          : undefined
    }
  } catch {
    return {}
  }
}
