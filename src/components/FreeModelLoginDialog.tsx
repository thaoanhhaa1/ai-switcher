import { FormEvent, useEffect, useState } from 'react'
import type { Account, FreeModelLoginStatus } from '../types'

interface FreeModelLoginDialogProps {
  account: Account
  onClose: () => void
  onSuccess: () => void
}

export function FreeModelLoginDialog({ account, onClose, onSuccess }: FreeModelLoginDialogProps) {
  const [email, setEmail] = useState(account.freemodelEmail ?? '')
  const [code, setCode] = useState('')
  const [step, setStep] = useState<'email' | 'otp'>('email')
  const [sending, setSending] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [loginStatus, setLoginStatus] = useState<FreeModelLoginStatus | null>(null)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    window.api
      .getFreeModelLoginStatus(account.id)
      .then(setLoginStatus)
      .catch(() => setLoginStatus({ loggedIn: false }))
  }, [account.id])

  async function handleSendOtp(event: FormEvent): Promise<void> {
    event.preventDefault()
    setSending(true)
    setMessage(null)

    try {
      const result = await window.api.sendFreeModelOtp(email.trim())
      setMessage({ type: result.success ? 'success' : 'error', text: result.message })
      if (result.success) {
        setStep('otp')
        setCode('')
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Không thể gửi OTP'
      })
    } finally {
      setSending(false)
    }
  }

  async function handleVerifyOtp(event: FormEvent): Promise<void> {
    event.preventDefault()
    setVerifying(true)
    setMessage(null)

    try {
      const result = await window.api.verifyFreeModelOtp(account.id, email.trim(), code.trim())
      setMessage({ type: result.success ? 'success' : 'error', text: result.message })
      if (result.success) {
        setLoginStatus(result.loginStatus ?? { loggedIn: true, email: email.trim() })
        onSuccess()
        setTimeout(onClose, 800)
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Không thể xác thực OTP'
      })
    } finally {
      setVerifying(false)
    }
  }

  async function handleLogout(): Promise<void> {
    await window.api.logoutFreeModel(account.id)
    setLoginStatus({ loggedIn: false })
    setStep('email')
    setCode('')
    setMessage({ type: 'success', text: 'Đã đăng xuất FreeModel' })
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <h3>Đăng nhập FreeModel</h3>
        <p className="dialog-desc">
          Quota usage chỉ đọc được qua phiên đăng nhập dashboard, không qua API key.
        </p>

        {loginStatus?.loggedIn ? (
          <div className="login-status-box">
            <div className="login-status-title">Đã đăng nhập</div>
            <div className="login-status-email">{loginStatus.email}</div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                Đóng
              </button>
              <button type="button" className="btn btn-danger" onClick={handleLogout}>
                Đăng xuất
              </button>
            </div>
          </div>
        ) : step === 'email' ? (
          <form className="form-grid" onSubmit={handleSendOtp}>
            <div className="field">
              <label htmlFor="fm-email">Email FreeModel</label>
              <input
                id="fm-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                required
              />
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                Hủy
              </button>
              <button type="submit" className="btn btn-primary" disabled={sending}>
                {sending ? 'Đang gửi...' : 'Gửi mã OTP'}
              </button>
            </div>
          </form>
        ) : (
          <form className="form-grid" onSubmit={handleVerifyOtp}>
            <div className="field">
              <label htmlFor="fm-otp">Mã OTP (6 số)</label>
              <input
                id="fm-otp"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                required
              />
            </div>
            <div className="otp-hint">Mã đã gửi tới {email}</div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setStep('email')}>
                Đổi email
              </button>
              <button type="submit" className="btn btn-primary" disabled={verifying || code.length < 6}>
                {verifying ? 'Đang xác thực...' : 'Xác nhận đăng nhập'}
              </button>
            </div>
          </form>
        )}

        {message && <div className={`inline-message ${message.type}`}>{message.text}</div>}
      </div>
    </div>
  )
}
