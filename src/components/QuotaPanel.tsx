import { useEffect, useMemo, useState } from 'react'
import {
  formatCountdownDuration,
  formatResetLabelFromTimestamp,
  RESET_COUNTDOWN_PREFIX,
  RESET_IN_PROGRESS_LABEL
} from '../reset-label'
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
  // R3 M2: re-derive countdown từ numeric resetsAt mỗi render (QuotaPanel tick
  // 60s) — chuỗi resetsInLabel của main chỉ là backup khi thiếu resetsAt.
  const liveResetLabel =
    typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt) && window.resetsAt > 0
      ? formatResetLabelFromTimestamp(window.resetsAt)
      : window.resetsInLabel

  if (window.limitCents <= 0 && displayMode === 'cents') {
    return (
      <div className={`quota-card ${compact ? 'compact' : ''}`}>
        <div className="quota-card-head">
          <span className="quota-card-title" title={title}>
            {title}
          </span>
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
        <span className="quota-card-title" title={title}>
          {title}
        </span>
        <span className={`quota-muted ${window.usedPercent >= 100 ? 'quota-danger-text' : ''}`}>
          {window.usedPercent}% đã dùng
        </span>
      </div>

      {window.windowSeconds ? (
        <div className="quota-window-desc">
          Cửa sổ rolling {window.windowLabel ?? `${Math.round(window.windowSeconds / 3600)} giờ`}
        </div>
      ) : null}

      <div
        className="quota-bar"
        role="progressbar"
        aria-label={`${title} — mức đã dùng`}
        aria-valuenow={window.usedPercent}
        aria-valuetext={`${window.usedPercent}% đã dùng`}
        aria-valuemin={0}
        aria-valuemax={100}
      >
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
        {liveResetLabel && <span>{liveResetLabel}</span>}
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

/**
 * N4: nhãn reset hợp nhất cho window row của nhóm.
 * L2 (CODE_REVIEW_QUOTA_GROUPS): trạng thái countdown vs "Đang reset..." derive
 * từ numeric `resetsAt` (so với `Date.now()` ở renderer) — KHÔNG parse tiền tố
 * chuỗi 'Reset sau ...' nữa (chống string-coupling khi format đổi).
 * R3 M2: countdown được TÍNH LẠI từ `resetsAt` mỗi render (qua `nowSeconds` do
 * tick 60s của QuotaPanel đẩy xuống) — không còn "đóng băng" số countdown sinh
 * lúc fetch; chuỗi `resetsInLabel` của main chỉ còn là BACKUP khi thiếu resetsAt.
 */
function groupWindowResetText(window: ModelQuotaWindow, nowSeconds: number): string {
  if (!window.resetAtLabel) return window.resetsInLabel
  const liveRemaining = liveRemainingSeconds(window, nowSeconds)
  // resetsAt tương lai → countdown re-derive (chuỗi fetch cũ chỉ là backup khi
  // thiếu resetsAt numeric). resetsAt đã qua → "Đang reset..." (chuỗi cũ có thể
  // vẫn là countdown từ lúc fetch).
  if (liveRemaining !== null) {
    return `Reset lúc: ${window.resetAtLabel} (còn ${formatCountdownDuration(liveRemaining)})`
  }
  if (window.resetsInLabel && !window.resetsInLabel.startsWith(RESET_COUNTDOWN_PREFIX)) {
    return `${window.resetsInLabel} (từ lúc ${window.resetAtLabel})`
  }
  if (window.resetsInLabel?.startsWith(RESET_COUNTDOWN_PREFIX)) {
    // R4 LOW1: `?.` — type là string bắt buộc nhưng IPC payload có thể lệch nếu
    // main đổi sang omit field; thiếu guard sẽ crash cả panel.
    // resetsAt không có/không hợp lệ nhưng nhãn là countdown cũ — dữ liệu fetch
    // lệch, chuẩn hóa về trạng thái thật thay vì ghép số cũ.
    return `${RESET_IN_PROGRESS_LABEL} (từ lúc ${window.resetAtLabel})`
  }
  return `Reset lúc: ${window.resetAtLabel}`
}

/** Số giây còn lại tới reset tính tại `nowSeconds`; null = resetsAt thiếu/đã qua. */
function liveRemainingSeconds(window: ModelQuotaWindow, nowSeconds: number): number | null {
  if (typeof window.resetsAt !== 'number' || !Number.isFinite(window.resetsAt)) return null
  const remaining = window.resetsAt - nowSeconds
  return remaining > 0 ? remaining : null
}

// L2 (CODE_REVIEW_QUOTA_GROUPS): `#N` chỉ hiện khi nhóm có >=2 row cùng
// windowLabel (2 bucket trùng windowId — QUOTA_REVIEW L1) để screen reader phân
// biệt được; nhóm 1 window duy nhất không bị đọc "số 1" vô nghĩa.
// `sequence` = số thứ tự 1-based TRONG NHÓM CÙNG windowLabel (L1 fix) — không
// phải index của cả mảng windows (2 row trùng label không liền kề vẫn "#1, #2").
function GroupQuotaWindowRow({
  window,
  sequence,
  showIndex,
  nowSeconds
}: {
  window: ModelQuotaWindow
  sequence: number
  showIndex: boolean
  nowSeconds: number
}) {
  const barLabel = showIndex
    ? `Quota ${window.windowLabel} #${sequence} — mức đã dùng`
    : `Quota ${window.windowLabel} — mức đã dùng`
  return (
    <div className={`quota-group-window ${window.disabled ? 'disabled' : ''}`}>
      <span className="quota-group-window-label" title={window.windowLabel}>
        {window.windowLabel}
      </span>
      {window.disabled ? (
        <span className="quota-muted">Không áp dụng</span>
      ) : (
        <>
          <div
            className="quota-bar quota-group-bar"
            role="progressbar"
            aria-label={barLabel}
            aria-valuenow={window.usedPercent}
            aria-valuetext={`${window.usedPercent}% đã dùng`}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={`quota-bar-fill ${getBarClass(window.usedPercent)}`}
              style={{ width: `${Math.min(100, window.usedPercent)}%` }}
            />
          </div>
          <span
            className={`quota-muted ${window.usedPercent >= 100 ? 'quota-danger-text' : ''}`}
          >
            {window.usedPercent}% đã dùng
          </span>
        </>
      )}
      {/* Bucket disabled không có reset nghĩa — ẩn reset (QUOTA_REVIEW L5) */}
      {!window.disabled && (window.resetAtLabel || window.resetsInLabel) && (
        <span className="quota-muted quota-group-reset">{groupWindowResetText(window, nowSeconds)}</span>
      )}
    </div>
  )
}

// LƯU Ý (QUOTA_REVIEW L6 + L-2): layout 'groups' hiện CHỈ đến từ antigravity với
// displayMode 'percent' — thẻ nhóm hardcode "% đã dùng". Provider khác gán
// quotaLayout 'groups' với displayMode khác 'percent' sẽ render model-card cũ.
function GroupQuotaCard({
  model,
  compact = false,
  nowSeconds
}: { model: ModelQuota; compact?: boolean; nowSeconds: number }) {
  const windows = model.windows ?? []
  // R4 LOW2 (carried from R3 LOW4): toàn bộ derive `#N` gom vào useMemo —
  // không còn mutate Map ngay trong JSX `.map` (render-phase side effect).
  // Kết quả giống hệt logic cũ: duyệt đúng thứ tự mảng windows, mỗi label
  // đếm 1-based riêng.
  const { labelCounts, sequences } = useMemo(() => {
    const counts = new Map<string, number>()
    for (const w of windows) {
      // R3 M3: bucket disabled KHÔNG có progressbar (render "Không áp dụng") →
      // không tính vào bộ đếm `#N`. Nếu tính, row enabled duy nhất có thể bị đọc
      // "#2" mà không có "#1" nào trên màn hình.
      if (w.disabled) continue
      counts.set(w.windowLabel, (counts.get(w.windowLabel) ?? 0) + 1)
    }
    // L1 (CODE_REVIEW_QUOTA_GROUPS): bộ đếm `#N` theo TỪNG windowLabel (không phải
    // index mảng) — 2 row trùng label nhưng sort key khác nên KHÔNG liền kề vẫn
    // được đọc tuần tự "#1, #2" thay vì nhảy "1, 3".
    const running = new Map<string, number>()
    const seq: number[] = []
    for (const w of windows) {
      // R3 M3: sequence chỉ gán cho row KHÔNG disabled (row disabled không
      // có bar → không tiêu thụ số thứ tự của label đó).
      if (w.disabled) {
        seq.push(0)
        continue
      }
      const next = (running.get(w.windowLabel) ?? 0) + 1
      running.set(w.windowLabel, next)
      seq.push(next)
    }
    return { labelCounts: counts, sequences: seq }
  }, [windows])
  return (
    <div className={`quota-card ${compact ? 'compact' : ''}`}>
      <div className="quota-card-head">
        {/* N4 (CODE_REVIEW_QUOTA_GROUPS): label dài (fallback 'Nhóm model <fingerprint>'
            nối bucketId) phải ellipsis trong header, tooltip giữ nội dung đầy đủ. */}
        <span className="quota-card-title" title={`Quota ${model.label}`}>
          Quota {model.label}
        </span>
        <span className={`quota-muted ${model.usedPercent >= 100 ? 'quota-danger-text' : ''}`}>
          {model.usedPercent}% đã dùng
        </span>
      </div>
      <div className="quota-group-windows">
        {windows.map((window, i) => {
          const showIndex = !window.disabled && (labelCounts.get(window.windowLabel) ?? 0) > 1
          return (
            <GroupQuotaWindowRow
              // N2 (CODE_REVIEW_QUOTA_GROUPS): key ưu tiên bucketId gốc — 2 bucket
              // trùng windowId + windowSeconds không còn bị index quyết định danh
              // tính (API đảo thứ tự → row giữ đúng identity, không "hoán đổi #1/#2").
              // L1 (CODE_REVIEW_QUOTA_GROUPS_R2): fallback dùng prefix `idx-` để
              // không gian index không chồng lấn với bucketId thô (nếu dùng `i`
              // thuần thì bucketId '1' ở window 5h và bucket-thiếu-id index 1
              // cùng sinh key '5h-1' → React duplicate key warning).
              key={`${window.windowId}-${window.bucketId ?? `idx-${i}`}`}
              window={window}
              sequence={sequences[i] ?? 0}
              showIndex={showIndex}
              nowSeconds={nowSeconds}
            />
          )
        })}
      </div>
    </div>
  )
}

interface ModelQuotaGridProps {
  models: ModelQuota[]
  compact?: boolean
  displayMode: 'cents' | 'percent'
  /** 'groups' = mỗi item là 1 NHÓM model — render cả windows inline, không tab */
  layout?: 'models' | 'groups'
  /** Mốc thời gian (giây) của render hiện tại — do tick 60s của QuotaPanel đẩy xuống (R3 M2) */
  nowSeconds?: number
}

/**
 * Lưới quota theo model. Khi có nhiều loại quota (5h / weekly / ...)
 * hiển thị thêm tab để chuyển giữa từng loại; tab derive động từ dữ liệu.
 */
function ModelQuotaGrid({
  models,
  compact = false,
  displayMode,
  layout = 'models',
  nowSeconds = Math.floor(Date.now() / 1000)
}: ModelQuotaGridProps) {
  const [activeTab, setActiveTab] = useState('overview')

  // isGroupLayout: gating giữ nguyên — thẻ nhóm chỉ render khi layout 'groups'
  // VÀ displayMode 'percent' (xem ghi chú tại GroupQuotaCard).
  const isGroupLayout = layout === 'groups' && displayMode === 'percent'

  const windowTabs = useMemo(() => {
    // N3 (CODE_REVIEW_QUOTA_GROUPS): layout 'groups' early-return bên dưới và
    // không render tab nào — skip hẳn việc derive (hooks không được đặt SAU
    // nhánh return vì Rules of Hooks, nên guard nằm NGUYÊN trong memo).
    if (isGroupLayout) return []
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
  }, [models, isGroupLayout])

  if (isGroupLayout) {
    // L4: compact groups slice(0, 2) — chủ ý KHÁC với models slice(0, 3) bên dưới:
    // thẻ nhóm cao hơn (inline nhiều window row) nên chỉ vừa 2 thẻ ở chế độ compact.
    const visible = compact ? models.slice(0, 2) : models
    return (
      <>
        <div className="quota-grid">
          {visible.map((model) => (
            <GroupQuotaCard key={model.modelId} model={model} compact={compact} nowSeconds={nowSeconds} />
          ))}
        </div>
        {compact && models.length > 2 && (
          <div className="quota-note">
            +{models.length - 2} nhóm khác (mở chi tiết để xem quota)
          </div>
        )}
      </>
    )
  }

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
                <span className="quota-card-title" title={`Quota ${model.label}`}>
                  Quota {model.label}
                </span>
                <span className="quota-muted">Không áp dụng</span>
              </div>
              {/* L2 (R3): bất đối xứng CÓ CHỦ Ý với layout 'groups' (row disabled
                  ẩn sạch reset — L5): bucket disabled hiếm khi có resetTime, nhưng
                  nếu API trả về thì tab view vẫn hiện vì resetsInLabel/resetAtLabel
                  đã có sẵn trên card — giữ 2 semantics này nguyên vẹn. */}
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
  // R3 M2: tick 60s để countdown "Reset sau X (còn Y)" tự chạy theo thời gian
  // thực. Nhãn sinh ở main lúc fetch là snapshot — không tick thì mở panel 40
  // phút vẫn thấy số cũ, và khi resetsAt đi qua không tự lật "Đang reset...".
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), 60_000)
    return () => clearInterval(id)
  }, [])

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
        <ModelQuotaGrid
          models={quota.models}
          compact={compact}
          displayMode={displayMode}
          layout={quota.quotaLayout ?? 'models'}
          nowSeconds={nowSeconds}
        />
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
