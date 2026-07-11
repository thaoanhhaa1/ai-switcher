import { FormEvent, useEffect, useState } from 'react'
import type { Account, AccountQuota, AntigravityLoginStatus } from '../types'
import { AntigravityLoginDialog } from './AntigravityLoginDialog'
import { QuotaPanel } from './QuotaPanel'

interface AntigravityAccountDialogProps {
  account: Account | null
  onClose: () => void
  onSubmit: (input: { name: string; note?: string }) => Promise<void>
}

export function AntigravityAccountDialog({ account, onClose, onSubmit }: AntigravityAccountDialogProps) {
  const [name, setName] = useState(account?.name ?? '')
  const [note, setNote] = useState(account?.note ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [quota, setQuota] = useState<AccountQuota | null>(null)
  const [quotaLoading, setQuotaLoading] = useState(false)
  const [loginStatus, setLoginStatus] = useState<AntigravityLoginStatus | null>(null)
  const [loginOpen, setLoginOpen] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    let cancelled = false

    async function loadQuota(): Promise<void> {
      if (!account?.id) {
        setQuota(null)
        setLoginStatus(null)
        return
      }

      setQuotaLoading(true)
      try {
        const [nextQuota, nextLogin] = await Promise.all([
          window.api.getAccountQuota('antigravity', account.id),
          window.api.getAntigravityLoginStatus(account.id)
        ])
        if (!cancelled) {
          setQuota(nextQuota)
          setLoginStatus(nextLogin)
        }
      } catch {
        if (!cancelled) {
          setQuota(null)
        }
      } finally {
        if (!cancelled) {
          setQuotaLoading(false)
        }
      }
    }

    void loadQuota()

    return () => {
      cancelled = true
    }
  }, [account?.id])

  async function reloadQuota(): Promise<void> {
    if (!account?.id) return
    const [nextQuota, nextLogin] = await Promise.all([
      window.api.getAccountQuota('antigravity', account.id),
      window.api.getAntigravityLoginStatus(account.id)
    ])
    setQuota(nextQuota)
    setLoginStatus(nextLogin)
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setSubmitting(true)
    setMessage(null)

    try {
      await onSubmit({
        name: name.trim(),
        note: note.trim() || undefined
      })
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Không thể lưu tài khoản'
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <h3>{account ? 'Sửa tài khoản' : 'Thêm tài khoản Antigravity'}</h3>

        <form className="form-grid" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="ag-name">Tên tài khoản</label>
            <input
              id="ag-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Ví dụ: Google cá nhân"
              required
            />
          </div>

          <div className="field">
            <label htmlFor="ag-note">Ghi chú</label>
            <textarea
              id="ag-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Ví dụ: tài khoản chính, dùng Claude/Gemini qua Antigravity"
            />
          </div>

          <QuotaPanel
            quota={quota}
            loading={quotaLoading}
            loginStatus={loginStatus?.loggedIn ? { loggedIn: true, email: loginStatus.email } : loginStatus}
            loginPrompt="Đăng nhập Antigravity để xem quota"
            onLogin={account ? () => setLoginOpen(true) : undefined}
            compact
          />
          {!account && (
            <div className="quota-note">Lưu tài khoản trước, sau đó đăng nhập Google OAuth để xem quota.</div>
          )}

          <div className="dialog-actions">
            {account && (
              <button type="button" className="btn btn-ghost" onClick={() => setLoginOpen(true)}>
                {loginStatus?.loggedIn ? 'Quản lý login' : 'Đăng nhập Antigravity'}
              </button>
            )}
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Hủy
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? 'Đang lưu...' : account ? 'Cập nhật' : 'Thêm tài khoản'}
            </button>
          </div>

          {message && <div className={`inline-message ${message.type}`}>{message.text}</div>}
        </form>

        {account && loginOpen && (
          <AntigravityLoginDialog
            account={account}
            onClose={() => setLoginOpen(false)}
            onSuccess={async () => {
              await reloadQuota()
            }}
          />
        )}
      </div>
    </div>
  )
}
