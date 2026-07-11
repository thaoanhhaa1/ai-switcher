import { useEffect, useState } from 'react'
import type { Account, AntigravityLoginStatus } from '../types'

interface AntigravityLoginDialogProps {
  account: Account
  onClose: () => void
  onSuccess: () => void
}

export function AntigravityLoginDialog({ account, onClose, onSuccess }: AntigravityLoginDialogProps) {
  const [loginStatus, setLoginStatus] = useState<AntigravityLoginStatus | null>(null)
  const [loggingIn, setLoggingIn] = useState(false)
  const [importing, setImporting] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    window.api
      .getAntigravityLoginStatus(account.id)
      .then(setLoginStatus)
      .catch(() => setLoginStatus({ loggedIn: false }))
  }, [account.id])

  async function handleLogin(): Promise<void> {
    setLoggingIn(true)
    setMessage(null)
    try {
      const status = await window.api.loginAntigravity(account.id)
      setLoginStatus(status)
      setMessage({
        type: status.loggedIn ? 'success' : 'error',
        text: status.loggedIn
          ? `Đăng nhập thành công: ${status.email ?? status.projectId}`
          : (status.message ?? 'Đăng nhập thất bại')
      })
      if (status.loggedIn) {
        onSuccess()
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Không thể đăng nhập Antigravity'
      })
    } finally {
      setLoggingIn(false)
    }
  }

  async function handleImportLive(): Promise<void> {
    setImporting(true)
    setMessage(null)
    try {
      const status = await window.api.importAntigravityFromLive(account.id)
      setLoginStatus(status)
      setMessage({
        type: status.loggedIn ? 'success' : 'error',
        text: status.loggedIn
          ? `Đã import từ opencode config: ${status.email ?? status.projectId}`
          : (status.message ?? 'Import thất bại')
      })
      if (status.loggedIn) {
        onSuccess()
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Không thể import từ opencode config'
      })
    } finally {
      setImporting(false)
    }
  }

  async function handleImportFile(): Promise<void> {
    setImporting(true)
    setMessage(null)
    try {
      const filePath = await window.api.pickAntigravityAccountsFile()
      if (!filePath) {
        setImporting(false)
        return
      }

      const status = await window.api.importAntigravityFromFile(account.id, filePath)
      setLoginStatus(status)
      setMessage({
        type: status.loggedIn ? 'success' : 'error',
        text: status.loggedIn
          ? `Đã import: ${status.email ?? status.projectId}`
          : (status.message ?? 'Import thất bại')
      })
      if (status.loggedIn) {
        onSuccess()
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Không thể import file'
      })
    } finally {
      setImporting(false)
    }
  }

  async function handleLogout(): Promise<void> {
    await window.api.logoutAntigravity(account.id)
    setLoginStatus({ loggedIn: false })
    setMessage({ type: 'success', text: 'Đã xóa auth Antigravity khỏi AI Switcher' })
    onSuccess()
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <h3>Đăng nhập Antigravity (Google OAuth)</h3>
        <p className="dialog-desc">
          Đăng nhập Google qua OAuth PKCE (tương thích opencode-antigravity-auth). Auth được lưu tại{' '}
          <code>~/.config/opencode/antigravity-accounts.json</code> khi bạn chuyển tài khoản.
        </p>

        {loginStatus?.loggedIn ? (
          <div className="login-status-box">
            <div className="login-status-title">Đã đăng nhập</div>
            <div className="login-status-email">{loginStatus.email ?? loginStatus.projectId}</div>
            {loginStatus.projectId && <div className="login-status-plan">Project: {loginStatus.projectId}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                Đóng
              </button>
              <button type="button" className="btn btn-danger" onClick={handleLogout}>
                Xóa auth
              </button>
            </div>
          </div>
        ) : (
          <div className="form-grid">
            <p className="dialog-desc">
              Liên kết Google account với slot &quot;{account.name}&quot;. Trình duyệt sẽ mở để đăng nhập.
            </p>
            <div className="dialog-actions stacked">
              <button
                type="button"
                className="btn btn-primary"
                disabled={loggingIn || importing}
                onClick={handleLogin}
              >
                {loggingIn ? 'Đang mở Google OAuth...' : 'Đăng nhập Google OAuth'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={loggingIn || importing}
                onClick={handleImportLive}
              >
                {importing ? 'Đang import...' : 'Import từ antigravity-accounts.json hiện tại'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={loggingIn || importing}
                onClick={handleImportFile}
              >
                {importing ? 'Đang import...' : 'Chọn file antigravity-accounts.json...'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Hủy
              </button>
            </div>
          </div>
        )}

        {message && <div className={`inline-message ${message.type}`}>{message.text}</div>}
      </div>
    </div>
  )
}
