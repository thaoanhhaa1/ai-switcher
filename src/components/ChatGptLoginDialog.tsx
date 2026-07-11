import { useEffect, useState } from 'react'
import type { Account, ChatGptLoginStatus } from '../types'

interface ChatGptLoginDialogProps {
  account: Account
  onClose: () => void
  onSuccess: () => void
}

export function ChatGptLoginDialog({ account, onClose, onSuccess }: ChatGptLoginDialogProps) {
  const [loginStatus, setLoginStatus] = useState<ChatGptLoginStatus | null>(null)
  const [loggingIn, setLoggingIn] = useState(false)
  const [importing, setImporting] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    window.api
      .getChatGptLoginStatus(account.id)
      .then(setLoginStatus)
      .catch(() => setLoginStatus({ loggedIn: false }))
  }, [account.id])

  async function handleLogin(): Promise<void> {
    setLoggingIn(true)
    setMessage(null)
    try {
      const status = await window.api.loginChatGpt(account.id)
      setLoginStatus(status)
      setMessage({
        type: status.loggedIn ? 'success' : 'error',
        text: status.loggedIn
          ? `Đăng nhập thành công: ${status.email ?? status.accountId}`
          : (status.message ?? 'Đăng nhập thất bại')
      })
      if (status.loggedIn) {
        onSuccess()
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Không thể đăng nhập ChatGPT'
      })
    } finally {
      setLoggingIn(false)
    }
  }

  async function handleImportLive(): Promise<void> {
    setImporting(true)
    setMessage(null)
    try {
      const status = await window.api.importChatGptFromLive(account.id)
      setLoginStatus(status)
      setMessage({
        type: status.loggedIn ? 'success' : 'error',
        text: status.loggedIn
          ? `Đã import từ ~/.codex: ${status.email ?? status.accountId}`
          : (status.message ?? 'Import thất bại')
      })
      if (status.loggedIn) {
        onSuccess()
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Không thể import auth từ ~/.codex'
      })
    } finally {
      setImporting(false)
    }
  }

  async function handleImportFile(): Promise<void> {
    setImporting(true)
    setMessage(null)
    try {
      const filePath = await window.api.pickAuthJsonFile()
      if (!filePath) {
        setImporting(false)
        return
      }

      const status = await window.api.importChatGptFromFile(account.id, filePath)
      setLoginStatus(status)
      setMessage({
        type: status.loggedIn ? 'success' : 'error',
        text: status.loggedIn
          ? `Đã import auth.json: ${status.email ?? status.accountId}`
          : (status.message ?? 'Import thất bại')
      })
      if (status.loggedIn) {
        onSuccess()
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Không thể import file auth.json'
      })
    } finally {
      setImporting(false)
    }
  }

  async function handleLogout(): Promise<void> {
    await window.api.logoutChatGpt(account.id)
    setLoginStatus({ loggedIn: false })
    setMessage({ type: 'success', text: 'Đã xóa auth ChatGPT khỏi AI Switcher' })
    onSuccess()
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <h3>Đăng nhập ChatGPT (Codex OAuth)</h3>
        <p className="dialog-desc">
          Tài khoản ChatGPT Plus/Pro dùng OAuth qua Codex CLI. Auth được lưu riêng cho từng tài khoản trong
          AI Switcher.
        </p>

        {loginStatus?.loggedIn ? (
          <div className="login-status-box">
            <div className="login-status-title">Đã đăng nhập</div>
            <div className="login-status-email">{loginStatus.email ?? loginStatus.accountId}</div>
            {loginStatus.planType && <div className="login-status-plan">Gói: {loginStatus.planType}</div>}
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
              Chọn một trong các cách sau để liên kết tài khoản ChatGPT với slot &quot;{account.name}&quot;.
            </p>
            <div className="dialog-actions stacked">
              <button
                type="button"
                className="btn btn-primary"
                disabled={loggingIn || importing}
                onClick={handleLogin}
              >
                {loggingIn ? 'Đang mở codex login...' : 'Đăng nhập qua codex login'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={loggingIn || importing}
                onClick={handleImportLive}
              >
                {importing ? 'Đang import...' : 'Import từ ~/.codex/auth.json hiện tại'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={loggingIn || importing}
                onClick={handleImportFile}
              >
                {importing ? 'Đang import...' : 'Chọn file auth.json...'}
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
