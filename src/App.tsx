import { useEffect, useMemo, useState } from 'react'
import type {
  Account,
  AccountQuota,
  ActiveConfigStatus,
  AntigravityLoginStatus,
  AppData,
  ChatGptLoginStatus,
  FreeModelLoginStatus,
  ProviderId,
  ProviderInfo
} from './types'
import { AccountDialog } from './components/AccountDialog'
import { AntigravityAccountDialog } from './components/AntigravityAccountDialog'
import { AntigravityLoginDialog } from './components/AntigravityLoginDialog'
import { ChatGptAccountDialog } from './components/ChatGptAccountDialog'
import { ChatGptLoginDialog } from './components/ChatGptLoginDialog'
import { FreeModelLoginDialog } from './components/FreeModelLoginDialog'
import { QuotaPanel } from './components/QuotaPanel'
import './App.css'

function formatDate(value: string | null): string {
  if (!value) return 'Chưa dùng'
  return new Date(value).toLocaleString('vi-VN')
}

function maskKey(key: string): string {
  if (!key) return 'OAuth'
  if (key.length <= 8) return '••••••••'
  return `${key.slice(0, 4)}••••${key.slice(-4)}`
}

function providerLabel(provider: ProviderId): string {
  if (provider === 'codex-chatgpt') return 'ChatGPT'
  if (provider === 'antigravity') return 'Antigravity'
  return 'FreeModel'
}

function providerShortLabel(provider: ProviderId): string {
  if (provider === 'codex-freemodel') return 'Codex + FreeModel'
  if (provider === 'codex-chatgpt') return 'Codex + ChatGPT'
  return 'Antigravity'
}

function providerDescription(provider: ProviderId): string {
  if (provider === 'codex-freemodel') {
    return 'Quản lý API key FreeModel cho Codex CLI. Ghi config vào ~/.codex.'
  }
  if (provider === 'codex-chatgpt') {
    return 'Quản lý tài khoản ChatGPT OAuth cho Codex CLI. Ghi config vào ~/.codex.'
  }
  return 'Quản lý Google OAuth cho Antigravity (Claude/Gemini). Ghi vào ~/.config/opencode.'
}

function authModeLabel(mode?: ActiveConfigStatus['authMode']): string {
  if (mode === 'chatgpt' || mode === 'google-oauth') return 'OAuth'
  if (mode === 'apikey') return 'API key'
  return '—'
}

export default function App() {
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [selectedProviderId, setSelectedProviderId] = useState<ProviderId | null>(null)
  const [data, setData] = useState<AppData | null>(null)
  const [status, setStatus] = useState<ActiveConfigStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingAccount, setEditingAccount] = useState<Account | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [quotas, setQuotas] = useState<Record<string, AccountQuota>>({})
  const [quotaLoading, setQuotaLoading] = useState(false)
  const [freeModelLogins, setFreeModelLogins] = useState<Record<string, FreeModelLoginStatus>>({})
  const [chatGptLogins, setChatGptLogins] = useState<Record<string, ChatGptLoginStatus>>({})
  const [antigravityLogins, setAntigravityLogins] = useState<Record<string, AntigravityLoginStatus>>({})
  const [loginAccount, setLoginAccount] = useState<Account | null>(null)
  const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(new Set())
  const [usageLogVisible, setUsageLogVisible] = useState(true)

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === selectedProviderId) ?? null,
    [providers, selectedProviderId]
  )

  const providerAccounts = useMemo(
    () => data?.accounts.filter((account) => account.provider === selectedProviderId) ?? [],
    [data?.accounts, selectedProviderId]
  )

  const providerUsageLog = useMemo(
    () => data?.usageLog.filter((event) => event.provider === selectedProviderId) ?? [],
    [data?.usageLog, selectedProviderId]
  )

  async function refreshLoginStatuses(accounts: Account[]): Promise<void> {
    if (!accounts.length) {
      setFreeModelLogins({})
      setChatGptLogins({})
      setAntigravityLogins({})
      return
    }

    const entries = await Promise.all(
      accounts.map(async (account) => {
        if (account.provider === 'codex-chatgpt') {
          const loginStatus = await window.api.getChatGptLoginStatus(account.id)
          return { id: account.id, freeModel: null, chatGpt: loginStatus, antigravity: null }
        }

        if (account.provider === 'antigravity') {
          const loginStatus = await window.api.getAntigravityLoginStatus(account.id)
          return { id: account.id, freeModel: null, chatGpt: null, antigravity: loginStatus }
        }

        const loginStatus = await window.api.getFreeModelLoginStatus(account.id)
        return { id: account.id, freeModel: loginStatus, chatGpt: null, antigravity: null }
      })
    )

    setFreeModelLogins(
      Object.fromEntries(
        entries.filter((item) => item.freeModel).map((item) => [item.id, item.freeModel!])
      )
    )
    setChatGptLogins(
      Object.fromEntries(
        entries.filter((item) => item.chatGpt).map((item) => [item.id, item.chatGpt!])
      )
    )
    setAntigravityLogins(
      Object.fromEntries(
        entries.filter((item) => item.antigravity).map((item) => [item.id, item.antigravity!])
      )
    )
  }

  async function refreshQuotas(accounts: Account[]): Promise<void> {
    if (!accounts.length) {
      setQuotas({})
      return
    }

    setQuotaLoading(true)
    try {
      const next = await window.api.getAccountsQuota(accounts.map((account) => account.id))
      setQuotas(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không thể tải quota')
    } finally {
      setQuotaLoading(false)
    }
  }

  async function refresh(): Promise<void> {
    const [providerList, appData, activeStatus] = await Promise.all([
      window.api.getProviders(),
      window.api.getAppData(),
      window.api.getActiveStatus()
    ])
    setProviders(providerList)
    setData(appData)
    setStatus(activeStatus)
    setSelectedProviderId((current) => current ?? providerList[0]?.id ?? null)
    await Promise.all([refreshQuotas(appData.accounts), refreshLoginStatuses(appData.accounts)])
  }

  useEffect(() => {
    refresh()
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!status?.accountId) return
    setExpandedAccounts((current) => {
      if (current.has(status.accountId!)) return current
      const next = new Set(current)
      next.add(status.accountId!)
      return next
    })
  }, [status?.accountId])

  function toggleAccountExpanded(accountId: string): void {
    setExpandedAccounts((current) => {
      const next = new Set(current)
      if (next.has(accountId)) {
        next.delete(accountId)
      } else {
        next.add(accountId)
      }
      return next
    })
  }

  async function handleSwitch(account: Account): Promise<void> {
    setBusyId(account.id)
    setError(null)
    try {
      const nextStatus = await window.api.switchAccount(account.id)
      setStatus(nextStatus)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không thể chuyển tài khoản')
    } finally {
      setBusyId(null)
    }
  }

  async function handleDelete(account: Account): Promise<void> {
    const confirmed = window.confirm(`Xóa tài khoản "${account.name}"?`)
    if (!confirmed) return

    setBusyId(account.id)
    setError(null)
    try {
      await window.api.deleteAccount(account.id)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không thể xóa tài khoản')
    } finally {
      setBusyId(null)
    }
  }

  function openCreateDialog(): void {
    if (!selectedProviderId) return
    setEditingAccount(null)
    setDialogOpen(true)
  }

  function openEditDialog(account: Account): void {
    setEditingAccount(account)
    setSelectedProviderId(account.provider)
    setDialogOpen(true)
  }

  async function handleFreeModelSubmit(input: {
    name: string
    apiKey: string
    model: string
    modelReasoningEffort: Account['settings']['modelReasoningEffort']
    note?: string
  }): Promise<void> {
    if (editingAccount) {
      await window.api.updateAccount(editingAccount.id, {
        name: input.name,
        apiKey: input.apiKey || undefined,
        settings: {
          model: input.model,
          modelReasoningEffort: input.modelReasoningEffort
        },
        note: input.note
      })
    } else {
      await window.api.addAccount({
        name: input.name,
        provider: 'codex-freemodel',
        apiKey: input.apiKey,
        settings: {
          model: input.model,
          modelReasoningEffort: input.modelReasoningEffort
        },
        note: input.note
      })
    }

    setDialogOpen(false)
    setEditingAccount(null)
    await refresh()
  }

  async function handleChatGptSubmit(input: {
    name: string
    model: string
    modelReasoningEffort: Account['settings']['modelReasoningEffort']
    note?: string
  }): Promise<void> {
    if (editingAccount) {
      await window.api.updateAccount(editingAccount.id, {
        name: input.name,
        settings: {
          model: input.model,
          modelReasoningEffort: input.modelReasoningEffort
        },
        note: input.note
      })
    } else {
      await window.api.addAccount({
        name: input.name,
        provider: 'codex-chatgpt',
        settings: {
          model: input.model,
          modelReasoningEffort: input.modelReasoningEffort
        },
        note: input.note
      })
    }

    setDialogOpen(false)
    setEditingAccount(null)
    await refresh()
  }

  async function handleAntigravitySubmit(input: { name: string; note?: string }): Promise<void> {
    if (editingAccount) {
      await window.api.updateAccount(editingAccount.id, {
        name: input.name,
        note: input.note
      })
    } else {
      await window.api.addAccount({
        name: input.name,
        provider: 'antigravity',
        note: input.note
      })
    }

    setDialogOpen(false)
    setEditingAccount(null)
    await refresh()
  }

  function getLoginInfo(account: Account): {
    loggedIn: boolean
    email?: string
    label: string
  } {
    if (account.provider === 'codex-chatgpt') {
      const login = chatGptLogins[account.id]
      return {
        loggedIn: Boolean(login?.loggedIn),
        email: login?.email ?? account.chatgptEmail,
        label: login?.loggedIn ? 'Quản lý ChatGPT' : 'Đăng nhập ChatGPT'
      }
    }

    if (account.provider === 'antigravity') {
      const login = antigravityLogins[account.id]
      return {
        loggedIn: Boolean(login?.loggedIn),
        email: login?.email ?? account.antigravityEmail,
        label: login?.loggedIn ? 'Quản lý Antigravity' : 'Đăng nhập Antigravity'
      }
    }

    const login = freeModelLogins[account.id]
    return {
      loggedIn: Boolean(login?.loggedIn),
      email: login?.email ?? account.freemodelEmail,
      label: login?.loggedIn ? 'Quản lý FreeModel' : 'Đăng nhập FreeModel'
    }
  }

  function renderQuotaPanel(account: Account, compact = false): JSX.Element {
    const loginInfo = getLoginInfo(account)

    return (
      <QuotaPanel
        quota={quotas[account.id] ?? null}
        loading={quotaLoading && !quotas[account.id]}
        loginStatus={loginInfo.loggedIn ? { loggedIn: true, email: loginInfo.email } : null}
        loginPrompt={
          account.provider === 'antigravity'
            ? 'Đăng nhập Antigravity để xem quota'
            : account.provider === 'codex-chatgpt'
              ? 'Đăng nhập ChatGPT để xem quota'
              : 'Đăng nhập FreeModel để xem quota'
        }
        onLogin={() => setLoginAccount(account)}
        compact={compact}
      />
    )
  }

  function countAccountsForProvider(providerId: ProviderId): number {
    return data?.accounts.filter((account) => account.provider === providerId).length ?? 0
  }

  function isProviderActive(providerId: ProviderId): boolean {
    return status?.provider === providerId && Boolean(status.accountId)
  }

  const activeAccount = data?.accounts.find((account) => account.id === status?.accountId)
  const providerActiveAccount =
    activeAccount?.provider === selectedProviderId ? activeAccount : null
  const providerActiveQuota = providerActiveAccount ? quotas[providerActiveAccount.id] : null
  const providerActiveLoginInfo = providerActiveAccount ? getLoginInfo(providerActiveAccount) : null

  if (loading) {
    return <div className="main">Đang tải...</div>
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">AI</div>
          <div>
            <h1>AI Switcher</h1>
            <p>Quản lý & chuyển tài khoản AI</p>
          </div>
        </div>

        <nav className="sidebar-nav">
          <div className="sidebar-nav-label">Providers</div>
          {providers.map((provider) => {
            const isSelected = selectedProviderId === provider.id
            const accountCount = countAccountsForProvider(provider.id)
            const isActive = isProviderActive(provider.id)

            return (
              <button
                key={provider.id}
                type="button"
                className={`sidebar-nav-item ${isSelected ? 'active' : ''}`}
                onClick={() => {
                  setSelectedProviderId(provider.id)
                  setError(null)
                }}
              >
                <div className="sidebar-nav-item-head">
                  <span className="sidebar-nav-title">{providerShortLabel(provider.id)}</span>
                  {isActive && <span className="sidebar-nav-dot" title="Đang active" />}
                </div>
                <span className="sidebar-nav-sub">
                  {accountCount} tài khoản · {provider.toolName}
                </span>
              </button>
            )
          })}
        </nav>
      </aside>

      <main className="main">
        {!selectedProvider || !selectedProviderId ? (
          <div className="empty-state">Chọn provider từ sidebar.</div>
        ) : (
          <>
            <div className="header">
              <div>
                <h2>{selectedProvider.name}</h2>
                <p>{providerDescription(selectedProviderId)}</p>
                <div className="header-meta">Config: {selectedProvider.configDir}</div>
              </div>

              <div
                className={`status-card ${
                  providerActiveAccount || isProviderActive(selectedProviderId) ? '' : 'inactive'
                }`}
              >
                <div className="status-label">Active trong provider này</div>
                <div className="status-value">
                  {providerActiveAccount?.name ??
                    (isProviderActive(selectedProviderId) ? status?.accountName : 'Chưa chọn')}
                </div>
                {providerActiveAccount || isProviderActive(selectedProviderId) ? (
                  <div className="status-meta">
                    {authModeLabel(status?.authMode)} ·{' '}
                    {selectedProviderId === 'antigravity'
                      ? status?.authExists
                        ? 'accounts.json ✓'
                        : 'accounts.json ✗'
                      : `${status?.configExists ? 'config.toml ✓' : 'config.toml ✗'} · ${status?.authExists ? 'auth.json ✓' : 'auth.json ✗'}`}
                  </div>
                ) : (
                  <div className="status-meta">Chuyển sang một tài khoản bên dưới</div>
                )}
              </div>
            </div>

            <div className="provider-toolbar">
              <div className="provider-toolbar-start">
                <button className="btn btn-primary" onClick={openCreateDialog}>
                  + Thêm tài khoản
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => window.api.openDocs(selectedProviderId)}
                >
                  Tài liệu
                </button>
                {selectedProviderId === 'antigravity' ? (
                  <button className="btn btn-secondary" onClick={() => window.api.openAntigravityDir()}>
                    Mở config opencode
                  </button>
                ) : (
                  <button className="btn btn-secondary" onClick={() => window.api.openCodexDir()}>
                    Mở ~/.codex
                  </button>
                )}
                <button
                  className="btn btn-ghost"
                  disabled={quotaLoading || !providerAccounts.length}
                  onClick={() => refreshQuotas(providerAccounts)}
                >
                  {quotaLoading ? 'Đang tải quota...' : 'Làm mới quota'}
                </button>
              </div>
              <button
                type="button"
                className={`btn btn-icon usage-log-toggle ${usageLogVisible ? 'active' : ''}`}
                onClick={() => setUsageLogVisible((visible) => !visible)}
                aria-pressed={usageLogVisible}
                aria-label={usageLogVisible ? 'Ẩn nhật ký' : 'Hiện nhật ký'}
                title={usageLogVisible ? 'Ẩn nhật ký' : 'Hiện nhật ký'}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path
                    d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>

            {error && <div className="inline-message error">{error}</div>}

            {providerActiveAccount && (
              <section className="header-quota">
                <div className="panel">
                  <div className="panel-header">
                    <h3>Quota active — {providerActiveAccount.name}</h3>
                    <div className="panel-header-actions">
                      <button
                        className="btn btn-ghost"
                        onClick={() => setLoginAccount(providerActiveAccount)}
                      >
                        {providerActiveLoginInfo?.label}
                      </button>
                    </div>
                  </div>
                  <div className="panel-body">
                    <QuotaPanel
                      quota={providerActiveQuota ?? null}
                      loading={quotaLoading && !providerActiveQuota}
                      loginStatus={
                        providerActiveLoginInfo?.loggedIn
                          ? { loggedIn: true, email: providerActiveLoginInfo.email }
                          : null
                      }
                      loginPrompt={
                        selectedProviderId === 'antigravity'
                          ? 'Đăng nhập Antigravity để xem quota'
                          : selectedProviderId === 'codex-chatgpt'
                            ? 'Đăng nhập ChatGPT để xem quota'
                            : 'Đăng nhập FreeModel để xem quota'
                      }
                      onLogin={() => setLoginAccount(providerActiveAccount)}
                    />
                  </div>
                </div>
              </section>
            )}

            <div className={`grid${usageLogVisible ? '' : ' grid-single'}`}>
              <section className="panel">
                <div className="panel-header">
                  <h3>
                    Tài khoản {providerLabel(selectedProviderId)} ({providerAccounts.length})
                  </h3>
                </div>
                <div className="panel-body">
                  {!providerAccounts.length ? (
                    <div className="empty-state">
                      Chưa có tài khoản {providerLabel(selectedProviderId)}. Bấm &quot;Thêm tài
                      khoản&quot; để bắt đầu.
                    </div>
                  ) : (
                    <div className="account-list">
                      {providerAccounts.map((account) => {
                        const isActive = status?.accountId === account.id
                        const loginInfo = getLoginInfo(account)
                        const isExpanded = expandedAccounts.has(account.id)

                        return (
                          <article
                            key={account.id}
                            className={`account-card ${isActive ? 'active' : ''} ${isExpanded ? 'expanded' : 'collapsed'}`}
                          >
                            <button
                              type="button"
                              className="account-card-header"
                              onClick={() => toggleAccountExpanded(account.id)}
                              aria-expanded={isExpanded}
                            >
                              <div className="account-card-header-main">
                                <div className="account-title">
                                  <strong>{account.name}</strong>
                                  {isActive && <span className="badge">Active</span>}
                                </div>
                                <div className="account-meta account-summary">
                                  {account.provider === 'codex-freemodel'
                                    ? `Key: ${maskKey(account.apiKey)}`
                                    : `Auth: ${loginInfo.loggedIn ? (loginInfo.email ?? 'OAuth') : 'Chưa login'}`}
                                  {account.provider !== 'antigravity' && (
                                    <> · {account.settings.model}</>
                                  )}
                                  {!isExpanded && <> · Chuyển: {account.switchCount} lần</>}
                                </div>
                              </div>
                              <span
                                className={`collapse-toggle ${isExpanded ? 'expanded' : ''}`}
                                aria-hidden="true"
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                  <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              </span>
                            </button>

                            {isExpanded && (
                              <div className="account-card-body">
                                <div className="account-meta">
                                  {account.provider === 'codex-freemodel'
                                    ? `Key: ${maskKey(account.apiKey)}`
                                    : `Auth: ${loginInfo.loggedIn ? (loginInfo.email ?? 'OAuth') : 'Chưa login'}`}
                                  {account.provider !== 'antigravity' && (
                                    <> · Model: {account.settings.model}</>
                                  )}{' '}
                                  · Chuyển: {account.switchCount} lần
                                </div>
                                <div className="account-meta">
                                  Lần cuối: {formatDate(account.lastUsedAt)}
                                </div>
                                {account.note && <div className="account-note">{account.note}</div>}
                                {renderQuotaPanel(account, true)}
                              </div>
                            )}

                            <div className="account-actions">
                              <button
                                className="btn btn-ghost"
                                onClick={() => setLoginAccount(account)}
                              >
                                Login
                              </button>
                              <button
                                className="btn btn-primary"
                                disabled={busyId === account.id || isActive}
                                onClick={() => handleSwitch(account)}
                              >
                                {isActive ? 'Đang dùng' : 'Chuyển sang'}
                              </button>
                              <button
                                className="btn btn-secondary"
                                onClick={() => openEditDialog(account)}
                              >
                                Sửa
                              </button>
                              <button
                                className="btn btn-danger"
                                disabled={busyId === account.id}
                                onClick={() => handleDelete(account)}
                              >
                                Xóa
                              </button>
                            </div>
                          </article>
                        )
                      })}
                    </div>
                  )}
                </div>
              </section>

              {usageLogVisible && (
                <section className="panel">
                  <div className="panel-header">
                    <h3>Nhật ký — {providerLabel(selectedProviderId)}</h3>
                  </div>
                  <div className="panel-body">
                    {!providerUsageLog.length ? (
                      <div className="empty-state">Chưa có hoạt động cho provider này.</div>
                    ) : (
                      <div className="usage-list">
                        {providerUsageLog.map((event) => (
                          <div key={event.id} className="usage-item">
                            <strong>
                              {event.accountName} · {event.action}
                            </strong>
                            <span>
                              {formatDate(event.timestamp)} · {event.success ? 'OK' : 'Lỗi'}
                              {event.message ? ` · ${event.message}` : ''}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </section>
              )}
            </div>
          </>
        )}
      </main>

      {dialogOpen && selectedProviderId === 'codex-freemodel' && (
        <AccountDialog
          account={editingAccount?.provider === 'codex-freemodel' ? editingAccount : null}
          onClose={() => {
            setDialogOpen(false)
            setEditingAccount(null)
          }}
          onSubmit={handleFreeModelSubmit}
        />
      )}

      {dialogOpen && selectedProviderId === 'codex-chatgpt' && (
        <ChatGptAccountDialog
          account={editingAccount?.provider === 'codex-chatgpt' ? editingAccount : null}
          onClose={() => {
            setDialogOpen(false)
            setEditingAccount(null)
          }}
          onSubmit={handleChatGptSubmit}
        />
      )}

      {dialogOpen && selectedProviderId === 'antigravity' && (
        <AntigravityAccountDialog
          account={editingAccount?.provider === 'antigravity' ? editingAccount : null}
          onClose={() => {
            setDialogOpen(false)
            setEditingAccount(null)
          }}
          onSubmit={handleAntigravitySubmit}
        />
      )}

      {loginAccount?.provider === 'codex-freemodel' && (
        <FreeModelLoginDialog
          account={loginAccount}
          onClose={() => setLoginAccount(null)}
          onSuccess={async () => {
            await refresh()
          }}
        />
      )}

      {loginAccount?.provider === 'codex-chatgpt' && (
        <ChatGptLoginDialog
          account={loginAccount}
          onClose={() => setLoginAccount(null)}
          onSuccess={async () => {
            await refresh()
          }}
        />
      )}

      {loginAccount?.provider === 'antigravity' && (
        <AntigravityLoginDialog
          account={loginAccount}
          onClose={() => setLoginAccount(null)}
          onSuccess={async () => {
            await refresh()
          }}
        />
      )}
    </div>
  )
}
