import { useEffect, useMemo, useState } from 'react'
import type { Account, AccountQuota, ActiveConfigStatus, AppData, FreeModelLoginStatus, ProviderInfo } from './types'
import { AccountDialog } from './components/AccountDialog'
import { FreeModelLoginDialog } from './components/FreeModelLoginDialog'
import { QuotaPanel } from './components/QuotaPanel'
import './App.css'

function formatDate(value: string | null): string {
  if (!value) return 'Chưa dùng'
  return new Date(value).toLocaleString('vi-VN')
}

function maskKey(key: string): string {
  if (key.length <= 8) return '••••••••'
  return `${key.slice(0, 4)}••••${key.slice(-4)}`
}

export default function App() {
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [data, setData] = useState<AppData | null>(null)
  const [status, setStatus] = useState<ActiveConfigStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingAccount, setEditingAccount] = useState<Account | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [quotas, setQuotas] = useState<Record<string, AccountQuota>>({})
  const [quotaLoading, setQuotaLoading] = useState(false)
  const [loginStatuses, setLoginStatuses] = useState<Record<string, FreeModelLoginStatus>>({})
  const [loginAccount, setLoginAccount] = useState<Account | null>(null)

  const codexProvider = useMemo(
    () => providers.find((provider) => provider.id === 'codex-freemodel'),
    [providers]
  )

  async function refreshLoginStatuses(accounts: Account[]): Promise<void> {
    if (!accounts.length) {
      setLoginStatuses({})
      return
    }

    const entries = await Promise.all(
      accounts.map(async (account) => {
        const status = await window.api.getFreeModelLoginStatus(account.id)
        return [account.id, status] as const
      })
    )
    setLoginStatuses(Object.fromEntries(entries))
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

  function openCreateDialog(): void {
    setEditingAccount(null)
    setDialogOpen(true)
  }

  function openEditDialog(account: Account): void {
    setEditingAccount(account)
    setDialogOpen(true)
  }

  async function handleDialogSubmit(input: {
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

  const activeAccount = data?.accounts.find((account) => account.id === status?.accountId)
  const activeQuota = activeAccount ? quotas[activeAccount.id] : null

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

        {codexProvider && (
          <div className="provider-card">
            <h2>{codexProvider.name}</h2>
            <p>{codexProvider.toolName}</p>
            <p>Config: {codexProvider.configDir}</p>
          </div>
        )}

        <div className="sidebar-actions">
          <button className="btn btn-primary" onClick={openCreateDialog}>
            + Thêm tài khoản Codex
          </button>
          <button className="btn btn-secondary" onClick={() => window.api.openCodexDir()}>
            Mở thư mục ~/.codex
          </button>
          <button className="btn btn-ghost" onClick={() => window.api.openDocs('codex-freemodel')}>
            Tài liệu FreeModel Codex
          </button>
        </div>
      </aside>

      <main className="main">
        <div className="header">
          <div>
            <h2>Codex + FreeModel</h2>
            <p>Thêm nhiều API key FreeModel và chuyển nhanh giữa các tài khoản cho Codex CLI.</p>
          </div>

          <div className={`status-card ${status?.accountId ? '' : 'inactive'}`}>
            <div className="status-label">Đang active</div>
            <div className="status-value">{status?.accountName ?? 'Chưa chọn tài khoản'}</div>
            <div className="status-meta">
              {status?.configExists ? 'config.toml ✓' : 'config.toml ✗'} ·{' '}
              {status?.authExists ? 'auth.json ✓' : 'auth.json ✗'}
            </div>
          </div>
        </div>

        {error && <div className="inline-message error">{error}</div>}

        {activeAccount && (
          <section className="header-quota">
            <div className="panel">
              <div className="panel-header">
                <h3>Quota tài khoản active — {activeAccount.name}</h3>
                <div className="panel-header-actions">
                  <button className="btn btn-ghost" onClick={() => setLoginAccount(activeAccount)}>
                    {loginStatuses[activeAccount.id]?.loggedIn ? 'Quản lý login' : 'Đăng nhập FreeModel'}
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
                  loginStatus={loginStatuses[activeAccount.id] ?? null}
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
                  Chưa có tài khoản nào. Thêm API key FreeModel để bắt đầu.
                </div>
              ) : (
                <div className="account-list">
                  {data.accounts.map((account) => {
                    const isActive = status?.accountId === account.id
                    return (
                      <article key={account.id} className={`account-card ${isActive ? 'active' : ''}`}>
                        <div>
                          <div className="account-title">
                            <strong>{account.name}</strong>
                            {isActive && <span className="badge">Active</span>}
                          </div>
                          <div className="account-meta">
                            Key: {maskKey(account.apiKey)} · Model: {account.settings.model} · Chuyển:{' '}
                            {account.switchCount} lần
                          </div>
                          <div className="account-meta">Lần cuối: {formatDate(account.lastUsedAt)}</div>
                          {account.note && <div className="account-note">{account.note}</div>}
                          <QuotaPanel
                            quota={quotas[account.id] ?? null}
                            loading={quotaLoading && !quotas[account.id]}
                            loginStatus={loginStatuses[account.id] ?? null}
                            onLogin={() => setLoginAccount(account)}
                            compact
                          />
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

      {dialogOpen && (
        <AccountDialog
          account={editingAccount}
          onClose={() => {
            setDialogOpen(false)
            setEditingAccount(null)
          }}
          onSubmit={handleDialogSubmit}
        />
      )}

      {loginAccount && (
        <FreeModelLoginDialog
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
