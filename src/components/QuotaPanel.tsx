import type { AccountQuota, FreeModelLoginStatus, QuotaWindow } from '../types'

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function getBarClass(percent: number): string {
  if (percent >= 90) return 'danger'
  if (percent >= 70) return 'warn'
  return ''
}

interface QuotaWindowCardProps {
  title: string
  window: QuotaWindow
  compact?: boolean
}

function QuotaWindowCard({ title, window, compact = false }: QuotaWindowCardProps) {
  if (window.limitCents <= 0) {
    return (
      <div className={`quota-card ${compact ? 'compact' : ''}`}>
        <div className="quota-card-head">
          <span>{title}</span>
          <span className="quota-muted">Chưa active</span>
        </div>
      </div>
    )
  }

  return (
    <div className={`quota-card ${compact ? 'compact' : ''}`}>
      <div className="quota-card-head">
        <span>{title}</span>
        <span className="quota-muted">{window.usedPercent}% đã dùng</span>
      </div>
      <div className="quota-bar">
        <div
          className={`quota-bar-fill ${getBarClass(window.usedPercent)}`}
          style={{ width: `${window.usedPercent}%` }}
        />
      </div>
      <div className="quota-stats">
        <span>Đã dùng: {formatUsd(window.usedCents)}</span>
        <span>Còn lại: {formatUsd(window.remainingCents)}</span>
      </div>
      <div className="quota-meta">
        <span>Hạn mức: {formatUsd(window.limitCents)}</span>
        {window.resetsInLabel && <span>{window.resetsInLabel}</span>}
      </div>
    </div>
  )
}

interface QuotaPanelProps {
  quota: AccountQuota | null
  loading?: boolean
  compact?: boolean
  loginStatus?: FreeModelLoginStatus | null
  onLogin?: () => void
}

export function QuotaPanel({
  quota,
  loading = false,
  compact = false,
  loginStatus,
  onLogin
}: QuotaPanelProps) {
  if (loading) {
    return <div className="quota-panel loading">Đang tải quota...</div>
  }

  if (!quota) {
    return null
  }

  if (!quota.available) {
    return (
      <div className="quota-panel unavailable">
        <div>{quota.message ?? 'Không thể tải quota'}</div>
        {!loginStatus?.loggedIn && onLogin && (
          <button type="button" className="btn btn-ghost quota-login-btn" onClick={onLogin}>
            Đăng nhập FreeModel để xem quota
          </button>
        )}
      </div>
    )
  }

  return (
    <div className={`quota-panel ${compact ? 'compact' : ''}`}>
      {loginStatus?.loggedIn && (
        <div className="quota-login-badge">Đã login: {loginStatus.email}</div>
      )}
      {quota.message && <div className="quota-note">{quota.message}</div>}
      <div className="quota-grid">
        <QuotaWindowCard title="Quota 5 giờ" window={quota.hourly} compact={compact} />
        <QuotaWindowCard title="Quota 7 ngày" window={quota.weekly} compact={compact} />
      </div>
    </div>
  )
}
