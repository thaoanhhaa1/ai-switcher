import { useMemo, useState } from 'react'
import type {
  AccountQuota,
  FreeModelLoginStatus,
  ModelQuota,
  ModelQuotaWindow,
  QuotaWindow
} from '../types'

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

function windowToQuotaWindow(w: ModelQuotaWindow): QuotaWindow {
  return {
    usedCents: w.usedPercent,
    limitCents: 100,
    remainingCents: w.remainingPercent,
    usedPercent: w.usedPercent,
    remainingPercent: w.remainingPercent,
    resetsAt: w.resetsAt,
    resetsInLabel: w.resetsInLabel,
    windowLabel: w.windowLabel,
    windowSeconds: w.windowSeconds,
    resetAtLabel: w.resetAtLabel
  }
}

interface ModelQuotaGridProps {
  models: ModelQuota[]
  compact?: boolean
  displayMode: 'cents' | 'percent'
}

/**
 * Lưới quota theo model. Khi có nhiều loại quota (5h / weekly / ...)
 * hiển thị thêm tab để chuyển giữa từng loại; tab derive động từ dữ liệu.
 */
function ModelQuotaGrid({ models, compact = false, displayMode }: ModelQuotaGridProps) {
  const [activeTab, setActiveTab] = useState('overview')

  const windowTabs = useMemo(() => {
    const map = new Map<string, { id: string; label: string; order: number }>()
    for (const model of models) {
      for (const w of model.windows ?? []) {
        if (!map.has(w.windowId)) {
          map.set(w.windowId, {
            id: w.windowId,
            label: w.windowLabel,
            order: w.windowSeconds ?? Number.MAX_SAFE_INTEGER
          })
        }
      }
    }
    const tabs: Array<{ id: string; label: string; order: number }> = []
    map.forEach((tab) => tabs.push(tab))
    return tabs.sort((a, b) => a.order - b.order)
  }, [models])

  if (compact) {
    return (
      <>
        <div className="quota-grid">
          {models.slice(0, 3).map((model) => (
            <QuotaWindowCard
              key={model.modelId}
              title={`Quota ${model.label}`}
              window={model}
              compact
              displayMode={displayMode}
            />
          ))}
        </div>
        {models.length > 3 && (
          <div className="quota-note">
            +{models.length - 3} model khác (mở chi tiết để xem quota)
          </div>
        )}
      </>
    )
  }

  const hasTabs = windowTabs.length > 0
  const currentTab = hasTabs && windowTabs.some((tab) => tab.id === activeTab) ? activeTab : 'overview'

  const tabBar = hasTabs ? (
    <div className="quota-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={currentTab === 'overview'}
        className={`quota-tab ${currentTab === 'overview' ? 'active' : ''}`}
        onClick={() => setActiveTab('overview')}
      >
        Tổng quan
      </button>
      {windowTabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={currentTab === tab.id}
          className={`quota-tab ${currentTab === tab.id ? 'active' : ''}`}
          onClick={() => setActiveTab(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  ) : null

  if (currentTab === 'overview') {
    return (
      <>
        {tabBar}
        <div className="quota-grid">
          {models.map((model) => (
            <QuotaWindowCard
              key={model.modelId}
              title={`Quota ${model.label}`}
              window={model}
              displayMode={displayMode}
            />
          ))}
        </div>
      </>
    )
  }

  const windowModels = models
    .map((model) => ({ model, quotaWindow: model.windows?.find((w) => w.windowId === currentTab) }))
    .filter((item): item is { model: ModelQuota; quotaWindow: ModelQuotaWindow } => !!item.quotaWindow)

  return (
    <>
      {tabBar}
      <div className="quota-grid">
        {windowModels.map(({ model, quotaWindow }) =>
          quotaWindow.disabled ? (
            <div className="quota-card" key={model.modelId}>
              <div className="quota-card-head">
                <span>Quota {model.label}</span>
                <span className="quota-muted">Không áp dụng</span>
              </div>
              {quotaWindow.resetAtLabel && (
                <div className="quota-reset-at">Reset lúc: {quotaWindow.resetAtLabel}</div>
              )}
            </div>
          ) : (
            <QuotaWindowCard
              key={model.modelId}
              title={`Quota ${model.label}`}
              window={windowToQuotaWindow(quotaWindow)}
              displayMode={displayMode}
            />
          )
        )}
      </div>
    </>
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
  hourlyTitle: hourlyTitleProp = 'Quota 5 giờ',
  weeklyTitle: weeklyTitleProp = 'Quota 7 ngày',
  onLogin
}: QuotaPanelProps) {
  if (loading) {
    return <div className="quota-panel loading">Đang tải quota...</div>
  }

  if (!quota) {
    return null
  }

  const displayMode = quota.displayMode ?? 'cents'
  const hourlyTitle = quota.windowLabels?.hourly ?? hourlyTitleProp
  const weeklyTitle = quota.windowLabels?.weekly ?? weeklyTitleProp
  const codeReviewTitle = quota.windowLabels?.codeReview ?? 'Code review'

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

      {quota.models && quota.models.length > 0 ? (
        <ModelQuotaGrid models={quota.models} compact={compact} displayMode={displayMode} />
      ) : (
        <>
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
                title={getWindowTitle(quota.codeReview, codeReviewTitle)}
                window={quota.codeReview}
                compact={compact}
                displayMode={displayMode}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}
