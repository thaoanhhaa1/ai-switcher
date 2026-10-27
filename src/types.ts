export type ProviderId = 'codex-freemodel' | 'codex-chatgpt' | 'antigravity' | 'github-copilot'

export interface CodexSettings {
  model: string
  modelReasoningEffort: 'low' | 'medium' | 'high' | 'xhigh'
}

export type CodexFreeModelSettings = CodexSettings

export interface Account {
  id: string
  name: string
  provider: ProviderId
  /** Raw key — chỉ tồn tại trong Main process, không gửi qua IPC tới Renderer. */
  apiKey: string
  /** Bản đã che của apiKey dành cho Renderer (SEC-09). */
  apiKeyMasked?: string
  settings: CodexSettings
  createdAt: string
  lastUsedAt: string | null
  switchCount: number
  note?: string
  freemodelEmail?: string
  chatgptEmail?: string
  chatgptAccountId?: string
  antigravityEmail?: string
  copilotUsername?: string
  planType?: string
}

export interface FreeModelLoginStatus {
  loggedIn: boolean
  email?: string
  userId?: string
  updatedAt?: string
  message?: string
}

export interface ChatGptLoginStatus {
  loggedIn: boolean
  email?: string
  accountId?: string
  planType?: string
  message?: string
}

export interface AntigravityLoginStatus {
  loggedIn: boolean
  email?: string
  projectId?: string
  message?: string
}

export type AntigravitySortOption =
  | 'default'
  | 'gemini-desc'
  | 'gemini-asc'
  | 'claude-desc'
  | 'claude-asc'

export interface AntigravityTestChatResult {
  success: boolean
  message?: string
  status?: number
}


export interface CopilotDeviceLoginStart {
  userCode: string
  verificationUri: string
  expiresInSeconds: number
}

export interface CopilotLoginStatus {
  loggedIn: boolean
  username?: string
  targets?: string[]
  message?: string
  /** Slot có GitHub token riêng (device flow) để đọc quota đúng account */
  hasOwnToken?: boolean
}

export interface UsageEvent {
  id: string
  accountId: string
  accountName: string
  provider: ProviderId
  action: 'switch' | 'add' | 'update' | 'delete' | 'validate' | 'login'
  timestamp: string
  success: boolean
  message?: string
}

export interface AppData {
  version: number
  activeAccountIds: Record<ProviderId, string | null>
  accounts: Account[]
  usageLog: UsageEvent[]
}

export type ActiveStatuses = Record<ProviderId, ActiveConfigStatus>

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
  authMode?: 'apikey' | 'chatgpt' | 'google-oauth' | 'github-oauth' | 'unknown'
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
    value: CodexSettings['modelReasoningEffort']
    label: string
  }>
}

export interface QuotaWindow {
  /**
   * LƯU Ý (CODE_REVIEW_QUOTA_GROUPS N5): khi `displayMode = 'percent'`
   * (antigravity — cả layout 'models' lẫn 'groups'), bộ ba `*Cents` KHÔNG chứa
   * tiền. Theo pattern của `buildModelQuota`/`parseAntigravityGroupQuotas`,
   * chúng nạp giá trị PHẦN TRĂM: usedCents = usedPercent, limitCents = 100,
   * remainingCents = remainingPercent. Render '$' hay '%' phải dựa vào
   * `AccountQuota.displayMode`, không đoán từ độ lớn giá trị.
   */
  usedCents: number
  limitCents: number
  remainingCents: number
  usedPercent: number
  remainingPercent: number
  resetsAt: number | null
  resetsInLabel: string
  windowLabel?: string
  windowSeconds?: number
  resetAtLabel?: string
  usedUnits?: number
  limitUnits?: number
}

export interface QuotaCredits {
  hasCredits: boolean
  unlimited: boolean
  balance?: string
}

export interface ModelQuotaWindow {
  windowId: string
  windowLabel: string
  /**
   * bucketId gốc từ API (antigravity summary) nếu có — cho React key ổn định
   * khi 2 bucket trùng windowId + windowSeconds (CODE_REVIEW_QUOTA_GROUPS N2).
   */
  bucketId?: string
  windowSeconds?: number
  usedPercent: number
  remainingPercent: number
  resetsAt: number | null
  resetsInLabel: string
  resetAtLabel: string
  disabled?: boolean
}

export interface ModelQuota extends QuotaWindow {
  modelId: string
  label: string
  /** Từng cửa sổ quota riêng của model (5h / weekly / ...) — hiển thị theo tab */
  windows?: ModelQuotaWindow[]
}

export interface AccountQuota {
  available: boolean
  hasActiveLimits: boolean
  message?: string
  /** 'groups' = mỗi model entry là 1 NHÓM (Gemini / Claude&GPT), render cả windows inline */
  quotaLayout?: 'models' | 'groups'
  /**
   * Nguồn chân lý duy nhất để biết bộ ba `*Cents` là TIỀN hay PHẦN TRĂM
   * (xem ghi chú N5 trên `QuotaWindow`) — 'percent' = antigravity quota nhóm.
   */
  displayMode?: 'cents' | 'percent'
  planType?: string
  email?: string
  allowed?: boolean
  limitReached?: boolean
  credits?: QuotaCredits
  stats?: {
    totalRequests?: number
    totalTokens?: number
  }
  windowLabels?: {
    hourly?: string
    weekly?: string
    codeReview?: string
  }
  models?: ModelQuota[]
  codeReview?: QuotaWindow | null
  hourly: QuotaWindow
  weekly: QuotaWindow
  updatedAt: string
}

export interface AppRuntimeInfo {
  env: 'development' | 'production'
  appDataDir: string
  codexHome: string
  opencodeConfigDir: string
  applyAntigravityIde: boolean
  applyCopilotIde: boolean
}

export interface Api {
  getRuntimeInfo: () => Promise<AppRuntimeInfo>
  getProviders: () => Promise<ProviderInfo[]>
  getAppData: () => Promise<AppData>
  getActiveStatuses: () => Promise<ActiveStatuses>
  addAccount: (input: {
    name: string
    provider: ProviderId
    apiKey?: string
    settings?: Partial<CodexSettings>
    note?: string
  }) => Promise<Account>
  updateAccount: (
    id: string,
    input: {
      name?: string
      apiKey?: string
      settings?: Partial<CodexSettings>
      note?: string
    }
  ) => Promise<Account>
  deleteAccount: (id: string) => Promise<void>
  switchAccount: (id: string) => Promise<ActiveStatuses>
  validateApiKey: (
    provider: ProviderId,
    apiKey?: string,
    accountId?: string
  ) => Promise<ValidateKeyResult>
  getProviderOptions: (
    provider: ProviderId,
    apiKey?: string,
    accountId?: string
  ) => Promise<ProviderOptions>
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
  getChatGptLoginStatus: (accountId: string) => Promise<ChatGptLoginStatus>
  loginChatGpt: (accountId: string) => Promise<ChatGptLoginStatus>
  importChatGptFromLive: (accountId: string) => Promise<ChatGptLoginStatus>
  importChatGptFromFile: (accountId: string, filePath: string) => Promise<ChatGptLoginStatus>
  logoutChatGpt: (accountId: string) => Promise<void>
  pickAuthJsonFile: () => Promise<string | null>
  getAntigravityLoginStatus: (accountId: string) => Promise<AntigravityLoginStatus>
  loginAntigravity: (accountId: string) => Promise<AntigravityLoginStatus>
  importAntigravityFromLive: (accountId: string) => Promise<AntigravityLoginStatus>
  importAntigravityFromFile: (accountId: string, filePath: string) => Promise<AntigravityLoginStatus>
  logoutAntigravity: (accountId: string) => Promise<void>
  pickAntigravityAccountsFile: () => Promise<string | null>
  testAntigravityChat: (
    accountId: string,
    family: 'gemini' | 'claude'
  ) => Promise<AntigravityTestChatResult>
  getCopilotLoginStatus: (accountId: string) => Promise<CopilotLoginStatus>
  importCopilotFromLive: (accountId: string) => Promise<CopilotLoginStatus>
  importCopilotFromFile: (accountId: string, filePath: string) => Promise<CopilotLoginStatus>
  logoutCopilot: (accountId: string) => Promise<void>
  pickCopilotSnapshotFile: () => Promise<string | null>
  startCopilotDeviceLogin: (accountId: string) => Promise<CopilotDeviceLoginStart>
  waitForCopilotDeviceLogin: (accountId: string) => Promise<CopilotLoginStatus>
  cancelCopilotDeviceLogin: (accountId: string) => Promise<void>
  openCodexDir: () => Promise<void>
  openAntigravityDir: () => Promise<void>
  openCopilotDir: () => Promise<void>
  openDocs: (provider: ProviderId) => Promise<void>
}

declare global {
  interface Window {
    api: Api
  }
}
