import { useEffect, useState } from 'react'
import type { Account, CopilotDeviceLoginStart, CopilotLoginStatus } from '../types'

interface CopilotLoginDialogProps {
  account: Account
  onClose: () => void
  onSuccess: () => void
}

export function CopilotLoginDialog({ account, onClose, onSuccess }: CopilotLoginDialogProps) {
  const [loginStatus, setLoginStatus] = useState<CopilotLoginStatus | null>(null)
  const [importing, setImporting] = useState(false)
  const [deviceLogin, setDeviceLogin] = useState<CopilotDeviceLoginStart | null>(null)
  const [deviceWaiting, setDeviceWaiting] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    window.api
      .getCopilotLoginStatus(account.id)
      .then(setLoginStatus)
      .catch(() => setLoginStatus({ loggedIn: false }))
    return () => {
      // unmount giữa chừng flow → hủy phiên pending
      void window.api.cancelCopilotDeviceLogin(account.id)
    }
  }, [account.id])

  async function handleDeviceLogin(): Promise<void> {
    setMessage(null)
    try {
      const start = await window.api.startCopilotDeviceLogin(account.id)
      setDeviceLogin(start)
      setDeviceWaiting(true)
      window.open(start.verificationUri, '_blank')

      const status = await window.api.waitForCopilotDeviceLogin(account.id)
      setLoginStatus(status)
      setDeviceLogin(null)
      setDeviceWaiting(false)
      setMessage({
        type: 'success',
        text: `Đã đăng nhập GitHub${status.username ? `: @${status.username}` : ''} — quota của slot sẽ dùng token riêng này`
      })
      onSuccess()
    } catch (error) {
      setDeviceLogin(null)
      setDeviceWaiting(false)
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Không thể đăng nhập GitHub'
      })
    }
  }

  function handleCancelDeviceLogin(): void {
    void window.api.cancelCopilotDeviceLogin(account.id)
    setDeviceLogin(null)
    setDeviceWaiting(false)
  }

  async function handleImportLive(): Promise<void> {
    setImporting(true)
    setMessage(null)
    try {
      const status = await window.api.importCopilotFromLive(account.id)
      setLoginStatus(status)
      setMessage({
        type: status.loggedIn ? 'success' : 'error',
        text: status.loggedIn
          ? `Đã import từ VS Code: @${status.username ?? 'unknown'}`
          : (status.message ?? 'Import thất bại')
      })
      if (status.loggedIn) {
        onSuccess()
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Không thể import từ VS Code'
      })
    } finally {
      setImporting(false)
    }
  }

  async function handleImportFile(): Promise<void> {
    setImporting(true)
    setMessage(null)
    try {
      const filePath = await window.api.pickCopilotSnapshotFile()
      if (!filePath) {
        setImporting(false)
        return
      }

      const status = await window.api.importCopilotFromFile(account.id, filePath)
      setLoginStatus(status)
      setMessage({
        type: status.loggedIn ? 'success' : 'error',
        text: status.loggedIn
          ? `Đã import: @${status.username ?? 'unknown'}`
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
    await window.api.logoutCopilot(account.id)
    setLoginStatus({ loggedIn: false })
    setMessage({ type: 'success', text: 'Đã xóa auth Copilot khỏi AI Switcher' })
    onSuccess()
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <h3>Import GitHub Copilot</h3>
        <p className="dialog-desc">
          Đăng nhập GitHub Copilot trong VS Code với đúng tài khoản của slot này, sau đó import.
          Mỗi tài khoản cần import riêng khi VS Code đang dùng đúng user đó.
        </p>

        {loginStatus?.loggedIn ? (
          <div className="login-status-box">
            <div className="login-status-title">Đã import auth</div>
            <div className="login-status-email">@{loginStatus.username}</div>
            {loginStatus.targets?.length ? (
              <div className="login-status-plan">IDE: {loginStatus.targets.join(', ')}</div>
            ) : null}
            {loginStatus.hasOwnToken ? (
              <div className="login-status-plan">Quota theo token riêng của slot ✓</div>
            ) : (
              <>
                <div className="login-status-plan">
                  Quota đang dùng token máy (gh CLI) — có thể lệch account
                </div>
                <div className="dialog-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={deviceWaiting}
                    onClick={handleDeviceLogin}
                  >
                    Đăng nhập GitHub cho slot này
                  </button>
                </div>
              </>
            )}
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
              Liên kết GitHub Copilot với slot &quot;{account.name}&quot;.
            </p>
            <p className="dialog-desc">
              Trước khi import: đăng nhập đúng GitHub account của slot này trong VS Code (Accounts
              menu). Username VS Code phải khớp với slot.
            </p>
            <p className="dialog-desc">
              Sau khi switch: mở VS Code → chạy &quot;Developer: Reload Window&quot;. Nếu vẫn lỗi
              token, sign out GitHub trong VS Code rồi switch lại.
            </p>
            <div className="dialog-actions stacked">
              <button
                type="button"
                className="btn btn-primary"
                disabled={importing}
                onClick={handleImportLive}
              >
                {importing ? 'Đang import...' : 'Import từ VS Code hiện tại'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={importing}
                onClick={handleImportFile}
              >
                {importing ? 'Đang import...' : 'Chọn file snapshot JSON...'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={deviceWaiting || importing}
                onClick={handleDeviceLogin}
              >
                Đăng nhập GitHub (lấy token riêng cho quota)
              </button>
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Hủy
              </button>
            </div>
          </div>
        )}

        {deviceLogin && (
          <div className="login-status-box">
            <div className="login-status-title">Đăng nhập GitHub</div>
            <p className="dialog-desc">
              Mở{' '}
              <a href="#" onClick={(e) => { e.preventDefault(); window.open(deviceLogin.verificationUri, '_blank') }}>
                {deviceLogin.verificationUri}
              </a>{' '}
              và nhập mã:
            </p>
            <div className="login-status-email" style={{ fontSize: 20, letterSpacing: 4 }}>
              {deviceLogin.userCode}
            </div>
            {deviceWaiting ? (
              <div className="dialog-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleCancelDeviceLogin}
                >
                  Hủy chờ (đang đợi xác nhận trên github.com...)
                </button>
              </div>
            ) : null}
          </div>
        )}

        {message && <div className={`inline-message ${message.type}`}>{message.text}</div>}
      </div>
    </div>
  )
}
