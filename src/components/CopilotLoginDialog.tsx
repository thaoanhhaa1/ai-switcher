import { useEffect, useRef, useState } from 'react'
import type { Account, CopilotDeviceLoginStart, CopilotLoginStatus } from '../types'

interface CopilotLoginDialogProps {
  account: Account
  onClose: () => void
  onSuccess: () => void
}

// R5 INFO 3: device flow bị abort ném 'Đã hủy đăng nhập GitHub' — user chủ
// động hủy thì đây KHÔNG phải lỗi, dialog phải im lặng reset thay vì hiển
// thị message đỏ. So khớp đúng message do main process quy ước
// (copilot-device-flow.ts — throw new Error('Đã hủy đăng nhập GitHub')).
const DEVICE_LOGIN_CANCELLED = 'Đã hủy đăng nhập GitHub'

export function CopilotLoginDialog({ account, onClose, onSuccess }: CopilotLoginDialogProps) {
  const [loginStatus, setLoginStatus] = useState<CopilotLoginStatus | null>(null)
  const [importing, setImporting] = useState(false)
  const [deviceLogin, setDeviceLogin] = useState<CopilotDeviceLoginStart | null>(null)
  const [deviceWaiting, setDeviceWaiting] = useState(false)
  // R6 L6: nút start disable NGAY khi bấm (qua deviceStarting) — trước đây
  // deviceWaiting chỉ set sau khi start resolve, để hở cửa sổ network RTT
  // khiến double-click tạo 2 phiên song song ở main.
  const [deviceStarting, setDeviceStarting] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'warning' | 'error'; text: string } | null>(null)
  // R5 INFO 3: nhận diện "user chủ động hủy" một cách đáng tin hơn so khớp
  // chuỗi: mỗi lượt chạy device flow có 1 số thứ tự; bấm Hủy (hoặc unmount
  // cleanup — cũng là dạng hủy chủ động) đánh dấu seq hiện tại là đã hủy.
  // waitFor reject với seq đã đánh dấu → im lặng, không hiển thị lỗi, và
  // KHÔNG ghi đè state của lượt chạy mới hơn (chống race attempt cũ/trễ).
  const deviceLoginSeqRef = useRef(0)
  const cancelledSeqRef = useRef(0)

  useEffect(() => {
    window.api
      .getCopilotLoginStatus(account.id)
      .then(setLoginStatus)
      .catch(() => setLoginStatus({ loggedIn: false }))
    return () => {
      // unmount giữa chừng flow → hủy phiên pending (tính là user chủ động hủy)
      cancelledSeqRef.current = deviceLoginSeqRef.current
      void window.api.cancelCopilotDeviceLogin(account.id)
    }
  }, [account.id])

  async function handleDeviceLogin(): Promise<void> {
    setMessage(null)
    const seq = ++deviceLoginSeqRef.current
    setDeviceStarting(true)
    try {
      const start = await window.api.startCopilotDeviceLogin(account.id)
      if (seq !== deviceLoginSeqRef.current) return // attempt đã bị thay thế
      setDeviceLogin(start)
      setDeviceWaiting(true)
      window.open(start.verificationUri, '_blank')

      const status = await window.api.waitForCopilotDeviceLogin(account.id)
      if (seq !== deviceLoginSeqRef.current) return // attempt đã bị thay thế
      setLoginStatus(status)
      setDeviceLogin(null)
      setDeviceWaiting(false)
      // N2: status.message chứa cảnh báo nếu KHÔNG xác minh được chủ token
      // qua /user — hiển thị kèm để user không tưởng token đã được xác nhận.
      setMessage({
        // CODE_REVIEW_QUOTA_GROUPS_R3 LOW 5: 'warning' thay vì 'error' — token
        // đã lưu thành công, chỉ không xác minh được chủ; 'error' gây hiểu lầm
        // login thất bại.
        type: status.message ? 'warning' : 'success',
        text: status.message
          ? `Đã lưu token GitHub cho slot, nhưng: ${status.message}`
          : `Đã đăng nhập GitHub${status.username ? `: @${status.username}` : ''} — quota của slot sẽ dùng token riêng này`
      })
      onSuccess()
    } catch (error) {
      // R5 INFO 3: hủy do người dùng bấm nút (hoặc dialog bị đóng/unmount) →
      // state đã được reset sẵn ở handleCancelDeviceLogin/cleanup; im lặng ở
      // đây để không hiện "lỗi" cho hành động hợp lệ. Attempt cũ finalize
      // muộn (seq bị thay thế) cũng phải im lặng để không ghi đè UI attempt mới.
      const cancelledByUser =
        cancelledSeqRef.current === seq ||
        seq !== deviceLoginSeqRef.current ||
        (error instanceof Error && error.message === DEVICE_LOGIN_CANCELLED)
      if (cancelledByUser) {
        return
      }
      setDeviceLogin(null)
      setDeviceWaiting(false)
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Không thể đăng nhập GitHub'
      })
    } finally {
      // attempt đã bị thay thế → attempt mới tự reset khi start xong; attempt
      // hiện hành → start đã xong (thành công lẫn lỗi) thì nút mở lại.
      if (seq === deviceLoginSeqRef.current) setDeviceStarting(false)
    }
  }

  function handleCancelDeviceLogin(): void {
    cancelledSeqRef.current = deviceLoginSeqRef.current
    setDeviceLogin(null)
    setDeviceWaiting(false)
    // R6 L6: mở lại nút start — nếu đang ở cửa sổ requestCode, attempt hiện hành
    // sẽ kết thúc theo abort; nếu đã qua start thì nút vốn đã mở lại từ finally.
    setDeviceStarting(false)
    void window.api.cancelCopilotDeviceLogin(account.id)
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
                    disabled={deviceStarting || deviceWaiting}
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
                disabled={deviceStarting || deviceWaiting || importing}
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
