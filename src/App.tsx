import { useEffect, useMemo, useState } from 'react'
import type {
  Account,
  AccountQuota,
  ActiveConfigStatus,
  AppData,
  ChatGptLoginStatus,
  FreeModelLoginStatus,
  ProviderId,
  ProviderInfo
} from './types'
import { AccountDialog } from './components/AccountDialog'
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
  return provider === 'codex-chatgpt' ? 'ChatGPT' : 'FreeModel'
}

export default function App() {
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [data, setData] = useState<AppData | null>(null)
  const [status, setStatus] = useState<ActiveConfigStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogProvider, setDialogProvider] = useState<ProviderId>('codex-freemodel')
  const [providerPickerOpen, setProviderPickerOpen] = useState(false)
  const [editingAccount, setEditingAccount] = useState<Account | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [quotas, setQuotas] = useState<Record<string, AccountQuota>>({})
  const [quotaLoading, setQuotaLoading] = useState(false)
  const [freeModelLogins, setFreeModelLogins] = useState<Record<string, FreeModelLoginStatus>>({})
  const [chatGptLogins, setChatGptLogins] = useState<Record<string, ChatGptLoginStatus>>({})
  const [loginAccount, setLoginAccount] = useState<Account | null>(null)

  const providerMap = useMemo(
    () => Object.fromEntries(providers.map((provider) => [provider.id, provider])),
    [providers]
  )

  async function refreshLoginStatuses(accounts: Account[]): Promise<void> {
    if (!accounts.length) {
      setFreeModelLogins({})
      setChatGptLogins({})
      return
    }

    const entries = await Promise.all(
      accounts.map(async (account) => {
        if (account.provider === 'codex-chatgpt') {
          const loginStatus = await window.api.getChatGptLoginStatus(account.id)
          return { id: account.id, freeModel: null, chatGpt: loginStatus }
        }

        const loginStatus = await window.api.getFreeModelLoginStatus(account.id)
        return { id: account.id, freeModel: loginStatus, chatGpt: null }
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
    await Promise.all([refreshQuotas(appData.accounts), refreshLoginStatuses(appData.accounts)])
  }

  useEffect(() => {
    refresh()
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

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

  function openCreateDialog(provider: ProviderId): void {
    setEditingAccount(null)
    setDialogProvider(provider)
    setProviderPickerOpen(false)
    setDialogOpen(true)
  }

  function openEditDialog(account: Account): void {
    setEditingAccount(account)
    setDialogProvider(account.provider)
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

    const login = freeModelLogins[account.id]
    return {
      loggedIn: Boolean(login?.loggedIn),
      email: login?.email ?? account.freemodelEmail,
      label: login?.loggedIn ? 'Quản lý FreeModel' : 'Đăng nhập FreeModel'
    }
  }

  function renderQuotaPanel(account: Account, compact = false): JSX.Element {
    const loginInfo = getLoginInfo(account)
    const isChatGpt = account.provider === 'codex-chatgpt'

    return (
      <QuotaPanel
        quota={quotas[account.id] ?? null}
        loading={quotaLoading && !quotas[account.id]}
        loginStatus={loginInfo.loggedIn ? { loggedIn: true, email: loginInfo.email } : null}
        loginPrompt={isChatGpt ? 'Đăng nhập ChatGPT để xem quota' : 'Đăng nhập FreeModel để xem quota'}
        hourlyTitle={isChatGpt ? 'Quota cửa sổ chính' : 'Quota 5 giờ'}
        weeklyTitle={isChatGpt ? 'Quota cửa sổ phụ' : 'Quota 7 ngày'}
        onLogin={() => setLoginAccount(account)}
        compact={compact}
      />
    )
  }

  const activeAccount = data?.accounts.find((account) => account.id === status?.accountId)
  const activeQuota = activeAccount ? quotas[activeAccount.id] : null
  const activeLoginInfo = activeAccount ? getLoginInfo(activeAccount) : null

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

        <div className="provider-list">
          {providers.map((provider) => (
            <div key={provider.id} className="provider-card">
              <h2>{provider.name}</h2>
              <p>{provider.toolName}</p>
              <button className="btn btn-ghost" onClick={() => window.api.openDocs(provider.id)}>
                Tài liệu
              </button>
            </div>
          ))}
        </div>

        <div className="sidebar-actions">
          <button className="btn btn-primary" onClick={() => setProviderPickerOpen(true)}>
            + Thêm tài khoản Codex
          </button>
          <button className="btn btn-secondary" onClick={() => window.api.openCodexDir()}>
            Mở thư mục ~/.codex
          </button>
        </div>
      </aside>

      <main className="main">
        <div className="header">
          <div>
            <h2>Codex CLI</h2>
            <p>Chuyển nhanh giữa tài khoản FreeModel (API key) và ChatGPT (OAuth subscription).</p>
          </div>

          <div className={`status-card ${status?.accountId ? '' : 'inactive'}`}>
            <div className="status-label">Đang active</div>
            <div className="status-value">{status?.accountName ?? 'Chưa chọn tài khoản'}</div>
            <div className="status-meta">
              {status?.provider ? providerLabel(status.provider) : '—'} ·{' '}
              {status?.authMode === 'chatgpt'
                ? 'OAuth'
                : status?.authMode === 'apikey'
                  ? 'API key'
                  : '—'}{' '}
              · {status?.configExists ? 'config.toml ✓' : 'config.toml ✗'} ·{' '}
              {status?.authExists ? 'auth.json ✓' : 'auth.json ✗'}
            </div>
          </div>
        </div>

        {error && <div className="inline-message error">{error}</div>}

        {activeAccount && (
          <section className="header-quota">
            <div className="panel">
              <div className="panel-header">
                <h3>
                  Quota tài khoản active — {activeAccount.name}{' '}
                  <span className="badge subtle">{providerLabel(activeAccount.provider)}</span>
                </h3>
                <div className="panel-header-actions">
                  <button className="btn btn-ghost" onClick={() => setLoginAccount(activeAccount)}>
                    {activeLoginInfo?.label}
                  </button>
                  <button
                    className="btn btn-secondary"
                    disabled={quotaLoading}
                    onClick={() => refreshQuotas(data?.accounts ?? [])}
                  >
                    {quotaLoading ? 'Đang tải...' : 'Làm mới quota'}
                  </button>
                </div>
              </div>
              <div className="panel-body">
                <QuotaPanel
                  quota={activeQuota ?? null}
                  loading={quotaLoading && !activeQuota}
                  loginStatus={
                    activeLoginInfo?.loggedIn
                      ? { loggedIn: true, email: activeLoginInfo.email }
                      : null
                  }
                  loginPrompt={
                    activeAccount.provider === 'codex-chatgpt'
                      ? 'Đăng nhập ChatGPT để xem quota'
                      : 'Đăng nhập FreeModel để xem quota'
                  }
                  hourlyTitle={
                    activeAccount.provider === 'codex-chatgpt' ? 'Quota cửa sổ chính' : 'Quota 5 giờ'
                  }
                  weeklyTitle={
                    activeAccount.provider === 'codex-chatgpt' ? 'Quota cửa sổ phụ' : 'Quota 7 ngày'
                  }
                  onLogin={() => setLoginAccount(activeAccount)}
                />
              </div>
            </div>
          </section>
        )}

        <div className="grid">
          <section className="panel">
            <div className="panel-header">
              <h3>Tài khoản ({data?.accounts.length ?? 0})</h3>
            </div>
            <div className="panel-body">
              {!data?.accounts.length ? (
                <div className="empty-state">
                  Chưa có tài khoản nào. Thêm tài khoản FreeModel hoặc ChatGPT để bắt đầu.
                </div>
              ) : (
                <div className="account-list">
                  {data.accounts.map((account) => {
                    const isActive = status?.accountId === account.id
                    const loginInfo = getLoginInfo(account)
                    const providerInfo = providerMap[account.provider]

                    return (
                      <article key={account.id} className={`account-card ${isActive ? 'active' : ''}`}>
                        <div>
                          <div className="account-title">
                            <strong>{account.name}</strong>
                            <span className="badge subtle">{providerLabel(account.provider)}</span>
                            {isActive && <span className="badge">Active</span>}
                          </div>
                          <div className="account-meta">
                            {account.provider === 'codex-freemodel'
                              ? `Key: ${maskKey(account.apiKey)}`
                              : `Auth: ${loginInfo.loggedIn ? (loginInfo.email ?? 'OAuth') : 'Chưa login'}`}{' '}
                            · Model: {account.settings.model} · Chuyển: {account.switchCount} lần
                          </div>
                          <div className="account-meta">Lần cuối: {formatDate(account.lastUsedAt)}</div>
                          {account.note && <div className="account-note">{account.note}</div>}
                          {providerInfo && (
                            <div className="account-meta muted">{providerInfo.name}</div>
                          )}
                          {renderQuotaPanel(account, true)}
                        </div>
                        <div className="account-actions">
                          <button className="btn btn-ghost" onClick={() => setLoginAccount(account)}>
                            Login
                          </button>
                          <button
                            className="btn btn-primary"
                            disabled={busyId === account.id || isActive}
                            onClick={() => handleSwitch(account)}
                          >
                            {isActive ? 'Đang dùng' : 'Chuyển sang'}
                          </button>
                          <button className="btn btn-secondary" onClick={() => openEditDialog(account)}>
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

          <section className="panel">
            <div className="panel-header">
              <h3>Nhật ký sử dụng</h3>
            </div>
            <div className="panel-body">
              {!data?.usageLog.length ? (
                <div className="empty-state">Chưa có hoạt động nào.</div>
              ) : (
                <div className="usage-list">
                  {data.usageLog.map((event) => (
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
        </div>
      </main>

      {providerPickerOpen && (
        <div className="dialog-backdrop" onClick={() => setProviderPickerOpen(false)}>
          <div className="dialog dialog-sm" onClick={(event) => event.stopPropagation()}>
            <h3>Chọn loại tài khoản Codex</h3>
            <p className="dialog-desc">Cả hai đều ghi vào ~/.codex — chỉ một tài khoản active tại một thời điểm.</p>
            <div className="provider-picker">
              <button className="provider-picker-card" onClick={() => openCreateDialog('codex-freemodel')}>
                <strong>FreeModel</strong>
                <span>API key từ freemodel.dev</span>
              </button>
              <button className="provider-picker-card" onClick={() => openCreateDialog('codex-chatgpt')}>
                <strong>ChatGPT</strong>
                <span>OAuth subscription (Plus/Pro)</span>
              </button>
            </div>
            <div className="dialog-actions">
              <button className="btn btn-secondary" onClick={() => setProviderPickerOpen(false)}>
                Hủy
              </button>
            </div>
          </div>
        </div>
      )}

      {dialogOpen && dialogProvider === 'codex-freemodel' && (
        <AccountDialog
          account={editingAccount?.provider === 'codex-freemodel' ? editingAccount : null}
          onClose={() => {
            setDialogOpen(false)
            setEditingAccount(null)
          }}
          onSubmit={handleFreeModelSubmit}
        />
      )}

      {dialogOpen && dialogProvider === 'codex-chatgpt' && (
        <ChatGptAccountDialog
          account={editingAccount?.provider === 'codex-chatgpt' ? editingAccount : null}
          onClose={() => {
            setDialogOpen(false)
            setEditingAccount(null)
          }}
          onSubmit={handleChatGptSubmit}
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
    </div>
  )
}
