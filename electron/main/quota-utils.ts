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

export function formatResetAt(timestampSeconds?: number | null): string {
  if (!timestampSeconds || timestampSeconds <= 0) return ''

  return new Date(timestampSeconds * 1000).toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function formatResetLabelFromSeconds(seconds?: number): string {
  if (!seconds || seconds <= 0) return ''
  if (seconds < 60) return `Reset sau ${seconds}s`
  if (seconds < 3600) return `Reset sau ${Math.ceil(seconds / 60)} phút`

  const hours = Math.floor(seconds / 3600)
  const minutes = Math.ceil((seconds % 3600) / 60)
  if (seconds < 86400) return `Reset sau ${hours}h ${minutes}p`

  return `Reset sau ${Math.floor(seconds / 86400)} ngày`
}

export function formatResetLabelFromTimestamp(resetsAt?: number): string {
  if (!resetsAt) return ''
  const seconds = resetsAt - Math.floor(Date.now() / 1000)
  if (seconds <= 0) return 'Đang reset...'
  return formatResetLabelFromSeconds(seconds)
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
