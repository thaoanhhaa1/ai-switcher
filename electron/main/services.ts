import { access, constants } from 'fs/promises'
import { shell } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import type {
  Account,
  AccountQuota,
  CodexFreeModelSettings,
  FreeModelLoginStatus,
  ProviderId,
  ProviderInfo,
  ProviderOptions
} from '../../src/types'
import { hashApiKey } from './crypto'
import {
  clearFreeModelSession,
  getFreeModelLoginStatus,
  logoutFreeModel,
  sendFreeModelOtp,
  verifyFreeModelOtp
} from './freemodel-auth'
import {
  applyCodexFreeModelAccount,
  DEFAULT_CODEX_SETTINGS,
  FREEMODEL_CODEX_DOCS,
  getCodexFreeModelOptions,
  fetchFreeModelQuota,
  readCodexAuthKey,
  validateFreeModelKey
} from './providers/codex-freemodel'
import { getCodexAuthPath, getCodexConfigPath, getCodexHome } from './paths'
import { appendUsageEvent, findAccount, loadAppData, saveAppData } from './storage'

const PROVIDERS: ProviderInfo[] = [
  {
    id: 'codex-freemodel',
    name: 'Codex + FreeModel',
    toolName: 'OpenAI Codex CLI',
    configDir: getCodexHome(),
    docsUrl: FREEMODEL_CODEX_DOCS
  }
]

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export function getProviders(): ProviderInfo[] {
  return PROVIDERS
}

export async function getActiveStatus(data?: AppData): Promise<ActiveConfigStatus> {
  const appData = data ?? (await loadAppData())
  const currentKey = await readCodexAuthKey()
  const configExists = await fileExists(getCodexConfigPath())
  const authExists = await fileExists(getCodexAuthPath())

  if (!currentKey) {
    return {
      provider: null,
      accountId: null,
      accountName: null,
      codexHome: getCodexHome(),
      configExists,
      authExists
    }
  }

  const currentHash = hashApiKey(currentKey)
  const matched = appData.accounts.find((account) => hashApiKey(account.apiKey) === currentHash)

  return {
    provider: matched?.provider ?? 'codex-freemodel',
    accountId: matched?.id ?? null,
    accountName: matched?.name ?? null,
    codexHome: getCodexHome(),
    configExists,
    authExists
  }
}

export async function addAccount(input: {
  name: string
  provider: ProviderId
  apiKey: string
  settings?: Partial<CodexFreeModelSettings>
  note?: string
}): Promise<{ data: AppData; account: Account }> {
  const data = await loadAppData()
  const account: Account = {
    id: uuidv4(),
    name: input.name.trim(),
    provider: input.provider,
    apiKey: input.apiKey.trim(),
    settings: {
      ...DEFAULT_CODEX_SETTINGS,
      ...input.settings
    },
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    switchCount: 0,
    note: input.note?.trim() || undefined
  }

  const next: AppData = {
    ...data,
    accounts: [...data.accounts, account]
  }

  await saveAppData(next)
  const withLog = await appendUsageEvent(next, {
    accountId: account.id,
    accountName: account.name,
    provider: account.provider,
    action: 'add',
    success: true,
    message: 'Đã thêm tài khoản'
  })

  return { data: withLog, account }
}

export async function updateAccount(
  id: string,
  input: {
    name?: string
    apiKey?: string
    settings?: Partial<CodexFreeModelSettings>
    note?: string
  }
): Promise<{ data: AppData; account: Account }> {
  const data = await loadAppData()
  const existing = findAccount(data, id)
  if (!existing) {
    throw new Error('Không tìm thấy tài khoản')
  }

  const updated: Account = {
    ...existing,
    name: input.name?.trim() ?? existing.name,
    apiKey: input.apiKey?.trim() ?? existing.apiKey,
    settings: {
      ...existing.settings,
      ...input.settings
    },
    note: input.note !== undefined ? input.note.trim() || undefined : existing.note
  }

  const next: AppData = {
    ...data,
    accounts: data.accounts.map((account) => (account.id === id ? updated : account))
  }

  await saveAppData(next)

  if (data.activeAccountId === id) {
    await applyCodexFreeModelAccount(updated)
  }

  const withLog = await appendUsageEvent(next, {
    accountId: updated.id,
    accountName: updated.name,
    provider: updated.provider,
    action: 'update',
    success: true,
    message: 'Đã cập nhật tài khoản'
  })

  return { data: withLog, account: updated }
}

export async function deleteAccount(id: string): Promise<AppData> {
  const data = await loadAppData()
  const existing = findAccount(data, id)
  if (!existing) {
    throw new Error('Không tìm thấy tài khoản')
  }

  const next: AppData = {
    ...data,
    accounts: data.accounts.filter((account) => account.id !== id),
    activeAccountId: data.activeAccountId === id ? null : data.activeAccountId
  }

  await saveAppData(next)

  await clearFreeModelSession(id)

  return appendUsageEvent(next, {
    accountId: existing.id,
    accountName: existing.name,
    provider: existing.provider,
    action: 'delete',
    success: true,
    message: 'Đã xóa tài khoản'
  })
}

export async function switchAccount(id: string): Promise<{ data: AppData; status: ActiveConfigStatus }> {
  const data = await loadAppData()
  const account = findAccount(data, id)
  if (!account) {
    throw new Error('Không tìm thấy tài khoản')
  }

  if (account.provider === 'codex-freemodel') {
    await applyCodexFreeModelAccount(account)
  }

  const updatedAccount: Account = {
    ...account,
    lastUsedAt: new Date().toISOString(),
    switchCount: account.switchCount + 1
  }

  const next: AppData = {
    ...data,
    activeAccountId: id,
    accounts: data.accounts.map((item) => (item.id === id ? updatedAccount : item))
  }

  await saveAppData(next)

  const withLog = await appendUsageEvent(next, {
    accountId: updatedAccount.id,
    accountName: updatedAccount.name,
    provider: updatedAccount.provider,
    action: 'switch',
    success: true,
    message: 'Đã chuyển sang tài khoản này'
  })

  const status = await getActiveStatus(withLog)
  return { data: withLog, status }
}

export async function validateApiKey(
  provider: ProviderId,
  apiKey: string
): Promise<{ valid: boolean; message: string }> {
  if (provider === 'codex-freemodel') {
    return validateFreeModelKey(apiKey.trim())
  }

  return { valid: false, message: 'Provider chưa được hỗ trợ' }
}

export async function getProviderOptions(
  provider: ProviderId,
  apiKey?: string
): Promise<ProviderOptions> {
  if (provider === 'codex-freemodel') {
    return getCodexFreeModelOptions(apiKey)
  }

  throw new Error('Provider chưa được hỗ trợ')
}

export async function getAccountQuota(provider: ProviderId, accountId: string): Promise<AccountQuota> {
  const data = await loadAppData()
  const account = findAccount(data, accountId)
  if (!account) {
    throw new Error('Không tìm thấy tài khoản')
  }

  if (provider === 'codex-freemodel') {
    return fetchFreeModelQuota(accountId, account.apiKey)
  }

  throw new Error('Provider chưa được hỗ trợ')
}

export async function getAccountsQuota(accountIds?: string[]): Promise<Record<string, AccountQuota>> {
  const data = await loadAppData()
  const targets = accountIds?.length
    ? data.accounts.filter((account) => accountIds.includes(account.id))
    : data.accounts

  const entries = await Promise.all(
    targets.map(async (account) => {
      const quota = await getAccountQuota(account.provider, account.id)
      return [account.id, quota] as const
    })
  )

  return Object.fromEntries(entries)
}

export async function getAccountLoginStatus(accountId: string): Promise<FreeModelLoginStatus> {
  return getFreeModelLoginStatus(accountId)
}

export async function sendAccountOtp(email: string): Promise<{ success: boolean; message: string }> {
  return sendFreeModelOtp(email)
}

export async function verifyAccountOtp(
  accountId: string,
  email: string,
  code: string
): Promise<{ success: boolean; message: string; loginStatus?: FreeModelLoginStatus }> {
  const result = await verifyFreeModelOtp(accountId, email, code)
  if (!result.success) {
    return result
  }

  const data = await loadAppData()
  const account = findAccount(data, accountId)
  if (account) {
    const next: AppData = {
      ...data,
      accounts: data.accounts.map((item) =>
        item.id === accountId
          ? {
              ...item,
              freemodelEmail: email.trim().toLowerCase()
            }
          : item
      )
    }
    await saveAppData(next)
  }

  return result
}

export async function logoutAccount(accountId: string): Promise<void> {
  await logoutFreeModel(accountId)
}

export async function openCodexDir(): Promise<void> {
  await shell.openPath(getCodexHome())
}

export async function openDocs(provider: ProviderId): Promise<void> {
  const info = PROVIDERS.find((item) => item.id === provider)
  if (info) {
    await shell.openExternal(info.docsUrl)
  }
}
