import { readFile, access } from 'fs/promises'
import { constants } from 'fs'
import { v4 as uuidv4 } from 'uuid'
import type { Account, AppData, ProviderId, UsageEvent } from '../../src/types'
import { getAppDataDir, getAppDataPath } from './paths'
import {
  decodeSecureJson,
  ensurePrivateDir,
  isEncryptionAvailable,
  writeSecureJson
} from './secure-storage'
import { maskApiKey } from './crypto'

export const EMPTY_ACTIVE_ACCOUNT_IDS: Record<ProviderId, string | null> = {
  'codex-freemodel': null,
  'codex-chatgpt': null,
  antigravity: null,
  'github-copilot': null
}

/** Both Codex providers write to the same ~/.codex home. */
export const CODEX_PROVIDERS: ProviderId[] = ['codex-freemodel', 'codex-chatgpt']

export function isCodexProvider(provider: ProviderId): boolean {
  return provider === 'codex-freemodel' || provider === 'codex-chatgpt'
}

const DEFAULT_DATA: AppData = {
  version: 2,
  activeAccountIds: { ...EMPTY_ACTIVE_ACCOUNT_IDS },
  accounts: [],
  usageLog: []
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function accountLastUsedMs(account: Account | undefined): number {
  if (!account?.lastUsedAt) return 0
  const parsed = Date.parse(account.lastUsedAt)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Keep only one Codex active account — both share ~/.codex. */
function resolveSharedCodexActiveIds(
  activeAccountIds: Record<ProviderId, string | null>,
  accounts: Account[]
): Record<ProviderId, string | null> {
  const freemodelId = activeAccountIds['codex-freemodel']
  const chatgptId = activeAccountIds['codex-chatgpt']
  if (!freemodelId || !chatgptId) return activeAccountIds

  const freemodel = accounts.find((account) => account.id === freemodelId)
  const chatgpt = accounts.find((account) => account.id === chatgptId)
  const preferFreemodel = accountLastUsedMs(freemodel) >= accountLastUsedMs(chatgpt)

  return {
    ...activeAccountIds,
    'codex-freemodel': preferFreemodel ? freemodelId : null,
    'codex-chatgpt': preferFreemodel ? null : chatgptId
  }
}

function migrateAppData(parsed: Partial<AppData> & { activeAccountId?: string | null }): AppData {
  const accounts = parsed.accounts ?? []
  let activeAccountIds: Record<ProviderId, string | null> = {
    ...EMPTY_ACTIVE_ACCOUNT_IDS,
    ...(parsed.activeAccountIds ?? {})
  }

  if (parsed.activeAccountId) {
    const legacy = accounts.find((account) => account.id === parsed.activeAccountId)
    if (legacy && !activeAccountIds[legacy.provider]) {
      activeAccountIds[legacy.provider] = legacy.id
    }
  }

  activeAccountIds = resolveSharedCodexActiveIds(activeAccountIds, accounts)

  return {
    version: 2,
    activeAccountIds,
    accounts,
    usageLog: parsed.usageLog ?? []
  }
}

export function getActiveAccountIdForProvider(data: AppData, provider: ProviderId): string | null {
  return data.activeAccountIds[provider] ?? null
}

/** Active Codex account across FreeModel + ChatGPT (shared ~/.codex slot). */
export function getActiveCodexAccountId(data: AppData): string | null {
  for (const provider of CODEX_PROVIDERS) {
    const id = getActiveAccountIdForProvider(data, provider)
    if (id) return id
  }
  return null
}

export function withActiveAccountForProvider(
  data: AppData,
  provider: ProviderId,
  accountId: string | null
): AppData {
  const activeAccountIds: Record<ProviderId, string | null> = {
    ...data.activeAccountIds,
    [provider]: accountId
  }

  // Codex + FreeModel and Codex + ChatGPT share one live config — only one can be active.
  if (isCodexProvider(provider)) {
    for (const other of CODEX_PROVIDERS) {
      if (other !== provider) activeAccountIds[other] = null
    }
  }

  return {
    ...data,
    activeAccountIds
  }
}

export async function loadAppData(): Promise<AppData> {
  const path = getAppDataPath()
  if (!(await fileExists(path))) {
    return structuredClone(DEFAULT_DATA)
  }

  const raw = await readFile(path, 'utf-8')
  const decoded = decodeSecureJson<
    Partial<AppData> & { activeAccountId?: string | null }
  >(raw)
  const data = migrateAppData(decoded.value)

  if (!decoded.encrypted && isEncryptionAvailable()) {
    await writeSecureJson(path, data).catch(() => undefined)
  }

  return data
}

export async function saveAppData(data: AppData): Promise<void> {
  await ensurePrivateDir(getAppDataDir())
  await writeSecureJson(getAppDataPath(), data)
}

/** SEC-09: không bao giờ đưa apiKey nguyên bản qua ranh giới IPC tới Renderer. */
export function sanitizeAccountForRenderer(account: Account): Account {
  return {
    ...account,
    apiKey: '',
    apiKeyMasked: maskApiKey(account.apiKey)
  }
}

export function sanitizeAppDataForRenderer(data: AppData): AppData {
  return {
    ...data,
    accounts: data.accounts.map(sanitizeAccountForRenderer)
  }
}

export async function appendUsageEvent(
  data: AppData,
  event: Omit<UsageEvent, 'id' | 'timestamp'>
): Promise<AppData> {
  const usageEvent: UsageEvent = {
    ...event,
    id: uuidv4(),
    timestamp: new Date().toISOString()
  }

  const next: AppData = {
    ...data,
    usageLog: [usageEvent, ...data.usageLog].slice(0, 200)
  }

  await saveAppData(next)
  return next
}

export function findAccount(data: AppData, id: string): Account | undefined {
  return data.accounts.find((account) => account.id === id)
}
