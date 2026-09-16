export { formatResetLabelFromSeconds, formatResetLabelFromTimestamp } from '../../src/reset-label'
export { RESET_COUNTDOWN_PREFIX, RESET_IN_PROGRESS_LABEL } from '../../src/reset-label'

export function inferWindowLabel(seconds?: number): string {
  if (!seconds || seconds <= 0) return ''

  if (seconds === 18000) return '5 giờ'
  if (seconds === 604800) return '7 ngày'

  if (seconds < 3600) {
    const minutes = Math.round(seconds / 60)
    return `${minutes} phút`
  }

  if (seconds < 86400) {
    const hours = Math.round(seconds / 3600)
    return `${hours} giờ`
  }

  const days = Math.round(seconds / 86400)
  return `${days} ngày`
}

/**
 * Định dạng tuyệt đối "dd/MM/yyyy HH:mm:ss" (giờ máy local), luôn đủ
 * ngày + giờ + phút + GIÂY. Format tay để không phụ thuộc thứ tự field của
 * toLocaleString('vi-VN') trên từng ICU/Node.
 */
export function formatResetAt(timestampSeconds?: number | null): string {
  // NaN/Infinity/0/âm → chuỗi rỗng (isFinite bắt luôn NaN — N2).
  if (typeof timestampSeconds !== 'number' || !Number.isFinite(timestampSeconds) || timestampSeconds <= 0) {
    return ''
  }

  // Số hữu hạn nhưng vượt range của Date (±8.64e15 ms) → Invalid Date — check
  // này KHÔNG dead code nhờ guard isFinite phía trên (QUOTA_REVIEW N2).
  const date = new Date(timestampSeconds * 1000)
  if (Number.isNaN(date.getTime())) return ''

  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

export function formatPlanType(planType?: string): string {
  if (!planType) return ''
  const normalized = planType.toLowerCase()
  if (normalized === 'plus') return 'ChatGPT Plus'
  if (normalized === 'pro') return 'ChatGPT Pro'
  if (normalized === 'team') return 'ChatGPT Team'
  if (normalized === 'free') return 'ChatGPT Free'
  return planType
}

export function formatTokenCount(value?: number): string {
  if (value === undefined || value === null) return ''
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toLocaleString('vi-VN')
}
