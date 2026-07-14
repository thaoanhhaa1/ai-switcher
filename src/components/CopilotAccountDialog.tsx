import { FormEvent, useEffect, useState } from 'react'
import type { Account, AccountQuota, CopilotLoginStatus } from '../types'
import { CopilotLoginDialog } from './CopilotLoginDialog'
import { QuotaPanel } from './QuotaPanel'

interface CopilotAccountDialogProps {
  account: Account | null
  onClose: () => void
  onSubmit: (input: { name: string; note?: string }) => Promise<void>
}

export function CopilotAccountDialog({ account, onClose, onSubmit }: CopilotAccountDialogProps) {
  const [name, setName] = useState(account?.name ?? '')
  const [note, setNote] = useState(account?.note ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [quota, setQuota] = useState<AccountQuota | null>(null)
  const [quotaLoading, setQuotaLoading] = useState(false)
  const [loginStatus, setLoginStatus] = useState<CopilotLoginStatus | null>(null)
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
          window.api.getAccountQuota('github-copilot', account.id),
          window.api.getCopilotLoginStatus(account.id)
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
      window.api.getAccountQuota('github-copilot', account.id),
      window.api.getCopilotLoginStatus(account.id)
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
        <h3>{account ? 'Sửa tài khoản' : 'Thêm tài khoản GitHub Copilot'}</h3>

        <form className="form-grid" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="copilot-name">Tên tài khoản</label>
            <input
              id="copilot-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Ví dụ: GitHub cá nhân"
              required
            />
          </div>

          <div className="field">
            <label htmlFor="copilot-note">Ghi chú</label>
            <textarea
              id="copilot-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Ví dụ: tài khoản Pro, dùng VS Code"
            />
          </div>

          <QuotaPanel
            quota={quota}
            loading={quotaLoading}
            loginStatus={
              loginStatus?.loggedIn
                ? { loggedIn: true, email: loginStatus.username ? `@${loginStatus.username}` : undefined }
                : loginStatus
            }
            loginPrompt="Import auth Copilot để xem quota"
            onLogin={account ? () => setLoginOpen(true) : undefined}
            compact
          />
          {!account && (
            <div className="quota-note">
              Lưu tài khoản trước, sau đó import từ VS Code đang đăng nhập Copilot.
            </div>
          )}

          <div className="dialog-actions">
            {account && (
              <button type="button" className="btn btn-ghost" onClick={() => setLoginOpen(true)}>
                {loginStatus?.loggedIn ? 'Quản lý auth' : 'Import auth Copilot'}
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
          <CopilotLoginDialog
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
