import { access, constants } from 'fs/promises'
import { dialog, shell } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import type {
  Account,
  AccountQuota,
  ActiveConfigStatus,
  AntigravityLoginStatus,
  AppData,
  ChatGptLoginStatus,
  CodexSettings,
  FreeModelLoginStatus,
  ProviderId,
  ProviderInfo,
  ProviderOptions
} from '../../src/types'
import { hashApiKey } from './crypto'
import { readLiveAuth, isChatGptAuth, parseChatGptIdentity, saveStoredAuth } from './codex-auth-storage'
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
import {
  applyCodexChatGptAccount,
  clearChatGptAuth,
  CODEX_CHATGPT_DOCS,
  DEFAULT_CHATGPT_SETTINGS,
  fetchChatGptQuota,
  getChatGptLoginStatus,
  importChatGptAuthFromFile,
  importChatGptAuthFromLive,
  readLiveChatGptAccountId,
  runChatGptLogin,
  snapshotLiveAuthToAccount
} from './providers/codex-chatgpt'
import {
  ANTIGRAVITY_DOCS,
  applyAntigravityAccount,
  clearAntigravityAuth,
  DEFAULT_ANTIGRAVITY_SETTINGS,
  fetchAntigravityQuota,
  getAntigravityConfigDirPath,
  getAntigravityLoginStatus,
  importAntigravityFromFile,
  importAntigravityFromLive,
  readLiveAntigravityEmail,
  runAntigravityLogin,
  snapshotLiveAntigravityToAccount
} from './providers/antigravity'
import {
  getAntigravityAccountsPath,
  getAntigravityConfigPath,
  getCodexAuthPath,
  getCodexConfigPath,
  getCodexHome,
  getOpencodeConfigDir
} from './paths'
import { appendUsageEvent, findAccount, loadAppData, saveAppData } from './storage'

const PROVIDERS: ProviderInfo[] = [
  {
    id: 'codex-freemodel',
    name: 'Codex + FreeModel',
    toolName: 'OpenAI Codex CLI',
    configDir: getCodexHome(),
    docsUrl: FREEMODEL_CODEX_DOCS
  },
  {
    id: 'codex-chatgpt',
    name: 'Codex + ChatGPT',
    toolName: 'OpenAI Codex CLI',
    configDir: getCodexHome(),
    docsUrl: CODEX_CHATGPT_DOCS
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    toolName: 'OpenCode + Antigravity Auth',
    configDir: getOpencodeConfigDir(),
    docsUrl: ANTIGRAVITY_DOCS
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

function defaultSettings(provider: ProviderId): CodexSettings {
  if (provider === 'codex-chatgpt') return { ...DEFAULT_CHATGPT_SETTINGS }
  if (provider === 'antigravity') return { ...DEFAULT_ANTIGRAVITY_SETTINGS }
  return { ...DEFAULT_CODEX_SETTINGS }
}

async function persistAntigravityIdentity(
  accountId: string,
  identity: { email?: string; projectId?: string }
): Promise<Account | null> {
  const data = await loadAppData()
  const account = findAccount(data, accountId)
  if (!account) return null

  const updated: Account = {
    ...account,
    antigravityEmail: identity.email ?? account.antigravityEmail
  }

  const next: AppData = {
    ...data,
    accounts: data.accounts.map((item) => (item.id === accountId ? updated : item))
  }
  await saveAppData(next)
  return updated
}

async function persistChatGptIdentity(accountId: string, identity: {
  email?: string
  accountId?: string
  planType?: string
}): Promise<Account | null> {
  const data = await loadAppData()
  const account = findAccount(data, accountId)
  if (!account) return null

  const updated: Account = {
    ...account,
    chatgptEmail: identity.email ?? account.chatgptEmail,
    chatgptAccountId: identity.accountId ?? account.chatgptAccountId,
    planType: identity.planType ?? account.planType
  }

  const next: AppData = {
    ...data,
    accounts: data.accounts.map((item) => (item.id === accountId ? updated : item))
  }
  await saveAppData(next)
  return updated
}

async function snapshotActiveAccountAuth(data: AppData): Promise<void> {
  if (!data.activeAccountId) return

  const active = findAccount(data, data.activeAccountId)
  if (!active) return

  if (active.provider === 'codex-chatgpt') {
    await snapshotLiveAuthToAccount(active.id)
    return
  }

  if (active.provider === 'antigravity') {
    await snapshotLiveAntigravityToAccount(active.id)
    return
  }

  if (active.provider === 'codex-freemodel') {
    // FreeModel uses API key in data.json; live auth refresh not needed for key mode.
  }
}

export function getProviders(): ProviderInfo[] {
  return PROVIDERS
}

export async function getActiveStatus(data?: AppData): Promise<ActiveConfigStatus> {
  const appData = data ?? (await loadAppData())

  if (appData.activeAccountId) {
    const active = findAccount(appData, appData.activeAccountId)
    if (active?.provider === 'antigravity') {
      const authExists = await fileExists(getAntigravityAccountsPath())
      return {
        provider: 'antigravity',
        accountId: active.id,
        accountName: active.name,
        codexHome: getAntigravityConfigDirPath(),
        configExists: await fileExists(getAntigravityConfigPath()),
        authExists,
        authMode: 'google-oauth'
      }
    }
  }

  const liveAntigravityEmail = await readLiveAntigravityEmail()
  if (liveAntigravityEmail) {
    const matched = appData.accounts.find(
      (account) =>
        account.provider === 'antigravity' &&
        account.antigravityEmail?.toLowerCase() === liveAntigravityEmail.toLowerCase()
    )

    return {
      provider: matched?.provider ?? 'antigravity',
      accountId: matched?.id ?? null,
      accountName: matched?.name ?? null,
      codexHome: getAntigravityConfigDirPath(),
      configExists: await fileExists(getAntigravityConfigPath()),
      authExists: await fileExists(getAntigravityAccountsPath()),
      authMode: 'google-oauth'
    }
  }

  const configExists = await fileExists(getCodexConfigPath())
  const authExists = await fileExists(getCodexAuthPath())
  const liveAuth = await readLiveAuth()

  if (isChatGptAuth(liveAuth)) {
    const liveAccountId = await readLiveChatGptAccountId()
    const matched = appData.accounts.find(
      (account) =>
        account.provider === 'codex-chatgpt' && account.chatgptAccountId === liveAccountId
    )

    return {
      provider: matched?.provider ?? 'codex-chatgpt',
      accountId: matched?.id ?? null,
      accountName: matched?.name ?? null,
      codexHome: getCodexHome(),
      configExists,
      authExists,
      authMode: 'chatgpt'
    }
  }

  const currentKey = await readCodexAuthKey()
  if (!currentKey) {
    return {
      provider: null,
      accountId: null,
      accountName: null,
      codexHome: getCodexHome(),
      configExists,
      authExists,
      authMode: authExists ? 'unknown' : undefined
    }
  }

  const currentHash = hashApiKey(currentKey)
  const matched = appData.accounts.find(
    (account) => account.provider === 'codex-freemodel' && hashApiKey(account.apiKey) === currentHash
  )

  return {
    provider: matched?.provider ?? 'codex-freemodel',
    accountId: matched?.id ?? null,
    accountName: matched?.name ?? null,
    codexHome: getCodexHome(),
    configExists,
    authExists,
    authMode: 'apikey'
  }
}

export async function addAccount(input: {
  name: string
  provider: ProviderId
  apiKey?: string
  settings?: Partial<CodexSettings>
  note?: string
}): Promise<{ data: AppData; account: Account }> {
  const data = await loadAppData()
  const account: Account = {
    id: uuidv4(),
    name: input.name.trim(),
    provider: input.provider,
    apiKey: input.apiKey?.trim() ?? '',
    settings: {
      ...defaultSettings(input.provider),
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
    settings?: Partial<CodexSettings>
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
    if (updated.provider === 'codex-freemodel') {
      await applyCodexFreeModelAccount(updated)
    } else if (updated.provider === 'codex-chatgpt') {
      await applyCodexChatGptAccount(updated)
    } else if (updated.provider === 'antigravity') {
      await applyAntigravityAccount(updated)
    }
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
  await clearChatGptAuth(id)
  await clearAntigravityAuth(id)

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

  await snapshotActiveAccountAuth(data)

  if (account.provider === 'codex-freemodel') {
    await applyCodexFreeModelAccount(account)
  } else if (account.provider === 'codex-chatgpt') {
    await applyCodexChatGptAccount(account)
  } else if (account.provider === 'antigravity') {
    await applyAntigravityAccount(account)
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

  if (provider === 'antigravity') {
    return { valid: false, message: 'Antigravity dùng Google OAuth, không dùng API key' }
  }

  return { valid: false, message: 'ChatGPT dùng OAuth, không dùng API key' }
}

export async function getProviderOptions(
  provider: ProviderId,
  apiKey?: string
): Promise<ProviderOptions> {
  if (provider === 'codex-freemodel') {
    return getCodexFreeModelOptions(apiKey)
  }

  if (provider === 'codex-chatgpt') {
    return {
      models: [
        { id: 'gpt-5.4', ownedBy: 'openai' },
        { id: 'gpt-5.3-codex', ownedBy: 'openai' },
        { id: 'gpt-5.5-codex', ownedBy: 'openai' }
      ],
      reasoningEfforts: [
        { value: 'low', label: 'low' },
        { value: 'medium', label: 'medium' },
        { value: 'high', label: 'high' },
        { value: 'xhigh', label: 'xhigh' }
      ]
    }
  }

  if (provider === 'antigravity') {
    return {
      models: [
        { id: 'claude-opus-4-5-thinking', ownedBy: 'anthropic' },
        { id: 'gemini-3-pro', ownedBy: 'google' },
        { id: 'gemini-3-flash', ownedBy: 'google' }
      ],
      reasoningEfforts: [
        { value: 'low', label: 'low' },
        { value: 'medium', label: 'medium' },
        { value: 'high', label: 'high' }
      ]
    }
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

  if (provider === 'codex-chatgpt') {
    return fetchChatGptQuota(accountId)
  }

  if (provider === 'antigravity') {
    return fetchAntigravityQuota(accountId)
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

export async function getChatGptStatus(accountId: string): Promise<ChatGptLoginStatus> {
  return getChatGptLoginStatus(accountId)
}

export async function loginChatGptAccount(accountId: string): Promise<ChatGptLoginStatus> {
  const auth = await runChatGptLogin()
  const identity = parseChatGptIdentity(auth)
  await saveStoredAuth(accountId, auth)
  await persistChatGptIdentity(accountId, identity)

  const data = await loadAppData()
  await appendUsageEvent(data, {
    accountId,
    accountName: findAccount(data, accountId)?.name ?? accountId,
    provider: 'codex-chatgpt',
    action: 'login',
    success: true,
    message: 'Đăng nhập ChatGPT thành công'
  })

  return getChatGptLoginStatus(accountId)
}

export async function importChatGptLiveAccount(accountId: string): Promise<ChatGptLoginStatus> {
  const auth = await importChatGptAuthFromLive(accountId)
  const identity = parseChatGptIdentity(auth)
  await persistChatGptIdentity(accountId, identity)
  return getChatGptLoginStatus(accountId)
}

export async function importChatGptFileAccount(
  accountId: string,
  filePath: string
): Promise<ChatGptLoginStatus> {
  const auth = await importChatGptAuthFromFile(accountId, filePath)
  const identity = parseChatGptIdentity(auth)
  await persistChatGptIdentity(accountId, identity)
  return getChatGptLoginStatus(accountId)
}

export async function logoutChatGptAccount(accountId: string): Promise<void> {
  await clearChatGptAuth(accountId)
}

export async function getAntigravityStatus(accountId: string): Promise<AntigravityLoginStatus> {
  return getAntigravityLoginStatus(accountId)
}

export async function loginAntigravityAccount(accountId: string): Promise<AntigravityLoginStatus> {
  const status = await runAntigravityLogin(accountId)
  await persistAntigravityIdentity(accountId, {
    email: status.email,
    projectId: status.projectId
  })

  const data = await loadAppData()
  await appendUsageEvent(data, {
    accountId,
    accountName: findAccount(data, accountId)?.name ?? accountId,
    provider: 'antigravity',
    action: 'login',
    success: true,
    message: 'Đăng nhập Antigravity thành công'
  })

  return status
}

export async function importAntigravityLiveAccount(accountId: string): Promise<AntigravityLoginStatus> {
  const status = await importAntigravityFromLive(accountId)
  await persistAntigravityIdentity(accountId, {
    email: status.email,
    projectId: status.projectId
  })
  return status
}

export async function importAntigravityFileAccount(
  accountId: string,
  filePath: string
): Promise<AntigravityLoginStatus> {
  const status = await importAntigravityFromFile(accountId, filePath)
  await persistAntigravityIdentity(accountId, {
    email: status.email,
    projectId: status.projectId
  })
  return status
}

export async function logoutAntigravityAccount(accountId: string): Promise<void> {
  await clearAntigravityAuth(accountId)
}

export async function pickAuthJsonFile(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: 'Chọn file auth.json',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })

  if (result.canceled || !result.filePaths.length) {
    return null
  }

  return result.filePaths[0]
}

export async function pickAntigravityAccountsFile(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: 'Chọn file antigravity-accounts.json',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })

  if (result.canceled || !result.filePaths.length) {
    return null
  }

  return result.filePaths[0]
}

export async function openCodexDir(): Promise<void> {
  await shell.openPath(getCodexHome())
}

export async function openAntigravityDir(): Promise<void> {
  await shell.openPath(getOpencodeConfigDir())
}

export async function openDocs(provider: ProviderId): Promise<void> {
  const info = PROVIDERS.find((item) => item.id === provider)
  if (info) {
    await shell.openExternal(info.docsUrl)
  }
}
