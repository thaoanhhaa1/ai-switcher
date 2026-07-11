import type { AccountQuota, FreeModelLoginStatus, QuotaWindow } from '../types'

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function formatValue(value: number, displayMode: 'cents' | 'percent'): string {
  if (displayMode === 'percent') {
    return `${value}%`
  }
  return formatUsd(value)
}

function formatTokenCount(value?: number): string {
  if (value === undefined || value === null) return ''
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M tokens`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K tokens`
  return `${value.toLocaleString('vi-VN')} tokens`
}

function getBarClass(percent: number): string {
  if (percent >= 100) return 'danger'
  if (percent >= 90) return 'danger'
  if (percent >= 70) return 'warn'
  return ''
}

function getWindowTitle(window: QuotaWindow, fallback: string): string {
  if (window.windowLabel) {
    return `Quota ${window.windowLabel}`
  }
  return fallback
}

interface QuotaWindowCardProps {
  title: string
  window: QuotaWindow
  compact?: boolean
  displayMode?: 'cents' | 'percent'
}

function QuotaWindowCard({ title, window, compact = false, displayMode = 'cents' }: QuotaWindowCardProps) {
  if (window.limitCents <= 0 && displayMode === 'cents') {
    return (
      <div className={`quota-card ${compact ? 'compact' : ''}`}>
        <div className="quota-card-head">
          <span>{title}</span>
          <span className="quota-muted">Chưa active</span>
        </div>
      </div>
    )
  }

  const hasUnits =
    window.usedUnits !== undefined &&
    window.limitUnits !== undefined &&
    window.limitUnits > 0

  return (
    <div className={`quota-card ${compact ? 'compact' : ''}`}>
      <div className="quota-card-head">
        <span>{title}</span>
        <span className={`quota-muted ${window.usedPercent >= 100 ? 'quota-danger-text' : ''}`}>
          {window.usedPercent}% đã dùng
        </span>
      </div>

      {window.windowSeconds ? (
        <div className="quota-window-desc">
          Cửa sổ rolling {window.windowLabel ?? `${Math.round(window.windowSeconds / 3600)} giờ`}
        </div>
      ) : null}

      <div className="quota-bar">
        <div
          className={`quota-bar-fill ${getBarClass(window.usedPercent)}`}
          style={{ width: `${Math.min(100, window.usedPercent)}%` }}
        />
      </div>

      <div className="quota-stats">
        <span>Đã dùng: {formatValue(window.usedCents, displayMode)}</span>
        <span>Còn lại: {formatValue(window.remainingCents, displayMode)}</span>
      </div>

      {hasUnits && (
        <div className="quota-meta">
          <span>
            Đơn vị: {window.usedUnits?.toLocaleString('vi-VN')} / {window.limitUnits?.toLocaleString('vi-VN')}
          </span>
        </div>
      )}

      <div className="quota-meta">
        <span>
          Hạn mức: {displayMode === 'percent' ? '100%' : formatUsd(window.limitCents)}
        </span>
        {window.resetsInLabel && <span>{window.resetsInLabel}</span>}
      </div>

      {window.resetAtLabel && (
        <div className="quota-reset-at">Reset lúc: {window.resetAtLabel}</div>
      )}
    </div>
  )
}

interface QuotaPanelProps {
  quota: AccountQuota | null
  loading?: boolean
  compact?: boolean
  loginStatus?: FreeModelLoginStatus | { loggedIn: boolean; email?: string } | null
  loginPrompt?: string
  hourlyTitle?: string
  weeklyTitle?: string
  onLogin?: () => void
}

export function QuotaPanel({
  quota,
  loading = false,
  compact = false,
  loginStatus,
  loginPrompt = 'Đăng nhập để xem quota',
  hourlyTitle = 'Quota 5 giờ',
  weeklyTitle = 'Quota 7 ngày',
  onLogin
}: QuotaPanelProps) {
  if (loading) {
    return <div className="quota-panel loading">Đang tải quota...</div>
  }

  if (!quota) {
    return null
  }

  const displayMode = quota.displayMode ?? 'cents'

  if (!quota.available) {
    return (
      <div className="quota-panel unavailable">
        <div>{quota.message ?? 'Không thể tải quota'}</div>
        {!loginStatus?.loggedIn && onLogin && (
          <button type="button" className="btn btn-ghost quota-login-btn" onClick={onLogin}>
            {loginPrompt}
          </button>
        )}
      </div>
    )
  }

  const updatedLabel = new Date(quota.updatedAt).toLocaleString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit'
  })

  return (
    <div className={`quota-panel ${compact ? 'compact' : ''}`}>
      <div className="quota-summary">
        {loginStatus?.loggedIn && loginStatus.email && (
          <span className="quota-login-badge">Đã login: {loginStatus.email}</span>
        )}
        {!loginStatus?.loggedIn && quota.email && (
          <span className="quota-login-badge">Tài khoản: {quota.email}</span>
        )}
        {quota.limitReached && <span className="quota-status-badge danger">Đã chạm giới hạn</span>}
        {!quota.limitReached && quota.allowed === false && (
          <span className="quota-status-badge warn">Tạm khóa</span>
        )}
        {!compact && <span className="quota-updated-at">Cập nhật: {updatedLabel}</span>}
      </div>

      {quota.message && <div className="quota-note">{quota.message}</div>}

      {quota.stats && (quota.stats.totalRequests !== undefined || quota.stats.totalTokens !== undefined) && (
        <div className="quota-stats-row">
          {quota.stats.totalRequests !== undefined && (
            <span>Tổng requests: {quota.stats.totalRequests.toLocaleString('vi-VN')}</span>
          )}
          {quota.stats.totalTokens !== undefined && (
            <span>Tổng tokens: {formatTokenCount(quota.stats.totalTokens)}</span>
          )}
        </div>
      )}

      {quota.credits?.hasCredits && (
        <div className="quota-credits-row">
          <span>Credits</span>
          <span>
            {quota.credits.unlimited
              ? 'Không giới hạn'
              : quota.credits.balance
                ? `Còn $${quota.credits.balance}`
                : 'Có credits'}
          </span>
        </div>
      )}

      <div className="quota-grid">
        <QuotaWindowCard
          title={getWindowTitle(quota.hourly, hourlyTitle)}
          window={quota.hourly}
          compact={compact}
          displayMode={displayMode}
        />
        <QuotaWindowCard
          title={getWindowTitle(quota.weekly, weeklyTitle)}
          window={quota.weekly}
          compact={compact}
          displayMode={displayMode}
        />
      </div>

      {quota.codeReview && quota.codeReview.limitCents > 0 && (
        <div className="quota-extra">
          <QuotaWindowCard
            title={getWindowTitle(quota.codeReview, 'Code review')}
            window={quota.codeReview}
            compact={compact}
            displayMode={displayMode}
          />
        </div>
      )}
    </div>
  )
}
