export type ProviderId = 'codex-freemodel'

export interface CodexFreeModelSettings {
  model: string
  modelReasoningEffort: 'low' | 'medium' | 'high' | 'xhigh'
}

export interface Account {
  id: string
  name: string
  provider: ProviderId
  apiKey: string
  settings: CodexFreeModelSettings
  createdAt: string
  lastUsedAt: string | null
  switchCount: number
  note?: string
  freemodelEmail?: string
}

export interface FreeModelLoginStatus {
  loggedIn: boolean
  email?: string
  userId?: string
  updatedAt?: string
  message?: string
}

export interface UsageEvent {
  id: string
  accountId: string
  accountName: string
  provider: ProviderId
  action: 'switch' | 'add' | 'update' | 'delete' | 'validate'
  timestamp: string
  success: boolean
  message?: string
}

export interface AppData {
  version: number
  activeAccountId: string | null
  accounts: Account[]
  usageLog: UsageEvent[]
}

export interface ProviderInfo {
  id: ProviderId
  name: string
  toolName: string
  configDir: string
  docsUrl: string
}

export interface ActiveConfigStatus {
  provider: ProviderId | null
  accountId: string | null
  accountName: string | null
  codexHome: string
  configExists: boolean
  authExists: boolean
}

export interface ValidateKeyResult {
  valid: boolean
  message: string
}

export interface ProviderModelOption {
  id: string
  ownedBy?: string
}

export interface ProviderOptions {
  models: ProviderModelOption[]
  reasoningEfforts: Array<{
    value: CodexFreeModelSettings['modelReasoningEffort']
    label: string
  }>
}

export interface QuotaWindow {
  usedCents: number
  limitCents: number
  remainingCents: number
  usedPercent: number
  remainingPercent: number
  resetsAt: number | null
  resetsInLabel: string
}

export interface AccountQuota {
  available: boolean
  hasActiveLimits: boolean
  message?: string
  hourly: QuotaWindow
  weekly: QuotaWindow
  updatedAt: string
}

export interface Api {
  getProviders: () => Promise<ProviderInfo[]>
  getAppData: () => Promise<AppData>
  getActiveStatus: () => Promise<ActiveConfigStatus>
  addAccount: (input: {
    name: string
    provider: ProviderId
    apiKey: string
    settings?: Partial<CodexFreeModelSettings>
    note?: string
  }) => Promise<Account>
  updateAccount: (
    id: string,
    input: {
      name?: string
      apiKey?: string
      settings?: Partial<CodexFreeModelSettings>
      note?: string
    }
  ) => Promise<Account>
  deleteAccount: (id: string) => Promise<void>
  switchAccount: (id: string) => Promise<ActiveConfigStatus>
  validateApiKey: (provider: ProviderId, apiKey: string) => Promise<ValidateKeyResult>
  getProviderOptions: (provider: ProviderId, apiKey?: string) => Promise<ProviderOptions>
  getAccountQuota: (provider: ProviderId, accountId: string) => Promise<AccountQuota>
  getAccountsQuota: (accountIds?: string[]) => Promise<Record<string, AccountQuota>>
  getFreeModelLoginStatus: (accountId: string) => Promise<FreeModelLoginStatus>
  sendFreeModelOtp: (email: string) => Promise<{ success: boolean; message: string }>
  verifyFreeModelOtp: (
    accountId: string,
    email: string,
    code: string
  ) => Promise<{ success: boolean; message: string; loginStatus?: FreeModelLoginStatus }>
  logoutFreeModel: (accountId: string) => Promise<void>
  openCodexDir: () => Promise<void>
  openDocs: (provider: ProviderId) => Promise<void>
}

declare global {
  interface Window {
    api: Api
  }
}
