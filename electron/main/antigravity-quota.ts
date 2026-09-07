import type { ModelQuota, ModelQuotaWindow } from '../../src/types'
import { formatResetAt, formatResetLabelFromTimestamp } from './quota-utils'

export interface ModelQuotaInfo {
  remainingFraction?: number
  resetTime?: string
}

export interface AvailableModelEntry {
  quotaInfo?: ModelQuotaInfo
  displayName?: string
  modelName?: string
}

export interface AvailableModelsResponse {
  models?: Record<string, AvailableModelEntry>
  agentModelSorts?: Array<{
    displayName?: string
    groups?: Array<{ modelIds?: string[] }>
  }>
  commandModelIds?: string[]
  imageGenerationModelIds?: string[]
  /**
   * Model "tiered" (slider thinking-level của IDE), map family → modelIds,
   * ví dụ { flash: ["gemini-3.8-flash-tiered"] }. Thường KHÔNG có displayName.
   */
  tieredModelIds?: Record<string, string[]>
}

/**
 * retrieveUserQuotaSummary — endpoint mà Antigravity IDE dùng để hiển thị quota THẬT.
 * Quota được cấp theo NHÓM (ví dụ "Gemini Models", "Claude and GPT models"),
 * mỗi nhóm có bucket theo cửa sổ thời gian (weekly / 5h).
 * Lưu ý: quotaInfo trong fetchAvailableModels chỉ là placeholder (luôn = 1)
 * với các model còn hạn mức nhóm — phải lấy summary này mới ra số thật.
 */
export interface QuotaBucket {
  bucketId?: string
  displayName?: string
  window?: string
  resetTime?: string
  remainingFraction?: number
  disabled?: boolean
  description?: string
}

export interface QuotaSummaryGroup {
  displayName?: string
  description?: string
  buckets?: QuotaBucket[]
}

export interface QuotaSummaryResponse {
  groups?: QuotaSummaryGroup[]
  description?: string
}

interface WindowCandidate {
  remaining: number
  resetAt: number | null
  windowLabel?: string
  windowSeconds?: number
}

/**
 * remainingFraction thiếu/không hợp lệ = đã cạn (0), theo đúng semantics của
 * Antigravity API: model hết quota chỉ còn resetTime, không có remainingFraction.
 */
export function normalizeRemainingFraction(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function parseResetTimestamp(resetTime?: string): number | null {
  if (!resetTime) return null
  const timestamp = Date.parse(resetTime)
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null
}

const WINDOW_SECONDS: Record<string, number> = {
  '5h': 18000,
  weekly: 604800
}

const WINDOW_LABELS: Record<string, string> = {
  '5h': '5 giờ',
  weekly: '7 ngày'
}

function toWindowCandidate(
  remainingFraction: number | undefined,
  resetTime: string | undefined,
  window?: string,
  skipDisabled = false,
  disabled?: boolean
): WindowCandidate | null {
  if (skipDisabled && disabled) return null
  if (typeof remainingFraction !== 'number' || !Number.isFinite(remainingFraction)) return null
  const seconds = window ? WINDOW_SECONDS[window] : undefined
  return {
    remaining: normalizeRemainingFraction(remainingFraction),
    resetAt: parseResetTimestamp(resetTime),
    windowLabel: window ? WINDOW_LABELS[window] : undefined,
    windowSeconds: seconds
  }
}

/**
 * Model thuộc nhóm nào của summary?
 * API không map trực tiếp nên suy luận theo từ khóa:
 * claude/gpt → nhóm có nhắc "Claude"/"GPT"/"3p", ngược lại → nhóm "Gemini".
 * Không khớp gì thì trả về undefined (chỉ dùng quota của chính model).
 */
function findGroupForModel(
  groups: QuotaSummaryGroup[],
  modelHaystack: string
): QuotaSummaryGroup | undefined {
  if (!groups.length) return undefined
  const isThirdParty = /claude|gpt/i.test(modelHaystack)
  const matches = (group: QuotaSummaryGroup, pattern: RegExp) =>
    pattern.test(`${group.displayName ?? ''} ${group.description ?? ''} ${(group.buckets ?? []).map((b) => b.bucketId ?? '').join(' ')}`)
  const wanted = isThirdParty ? /claude|gpt|3p/i : /gemini/i
  const avoided = isThirdParty ? /gemini/i : /claude|gpt|3p/i
  return (
    groups.find((group) => matches(group, wanted) && !matches(group, avoided)) ??
    (groups.length === 1 && !matches(groups[0], avoided) ? groups[0] : undefined)
  )
}

function pickBindingCandidate(candidates: WindowCandidate[]): WindowCandidate | null {
  let best: WindowCandidate | null = null
  for (const candidate of candidates) {
    if (!best) {
      best = candidate
      continue
    }
    if (candidate.remaining < best.remaining) {
      best = candidate
      continue
    }
    if (candidate.remaining === best.remaining) {
      // Cùng mức remaining: ưu tiên cửa sổ có nhãn rõ ràng (weekly/5h), rồi đến reset sớm hơn
      const candidatePreferred =
        (candidate.windowLabel && !best.windowLabel) ||
        (!candidate.windowLabel &&
          !best.windowLabel &&
          candidate.resetAt !== null &&
          (best.resetAt === null || candidate.resetAt < best.resetAt))
      if (candidatePreferred) {
        best = candidate
      }
    }
  }
  return best
}

/**
 * Mỗi bucket của nhóm = một cửa sổ quota riêng (5h / weekly / ...)
 * cho mọi model trong nhóm. Giữ cả bucket disabled để UI hiện "Không áp dụng".
 */
function buildGroupWindows(group?: QuotaSummaryGroup): ModelQuotaWindow[] {
  const windows: ModelQuotaWindow[] = []
  for (const bucket of group?.buckets ?? []) {
    const windowId = (bucket.window ?? '').trim() || (bucket.bucketId ?? '').trim()
    if (!windowId) continue
    const hasFraction =
      typeof bucket.remainingFraction === 'number' && Number.isFinite(bucket.remainingFraction)
    if (!hasFraction && !bucket.disabled) continue

    const remaining = hasFraction ? normalizeRemainingFraction(bucket.remainingFraction) : 0
    const usedPercent = Math.min(100, Math.max(0, Math.round((1 - remaining) * 100)))
    const resetsAt = parseResetTimestamp(bucket.resetTime)
    windows.push({
      windowId,
      windowLabel: WINDOW_LABELS[windowId] ?? bucket.displayName ?? windowId,
      windowSeconds: WINDOW_SECONDS[windowId],
      usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
      resetsAt,
      resetsInLabel: resetsAt ? formatResetLabelFromTimestamp(resetsAt) : '',
      resetAtLabel: resetsAt ? formatResetAt(resetsAt) : '',
      disabled: bucket.disabled === true
    })
  }
  return windows
}

export function buildModelQuota(
  modelId: string,
  label: string,
  info: ModelQuotaInfo,
  group?: QuotaSummaryGroup
): ModelQuota {
  const candidates: WindowCandidate[] = []

  // 1. Cửa sổ của riêng model (fetchAvailableModels) — thiếu remainingFraction = cạn
  const ownRemaining = normalizeRemainingFraction(info.remainingFraction)
  candidates.push({
    remaining: ownRemaining,
    resetAt: parseResetTimestamp(info.resetTime)
  })

  // 2. Các cửa sổ của nhóm (retrieveUserQuotaSummary) — bỏ bucket disabled
  for (const bucket of group?.buckets ?? []) {
    const candidate = toWindowCandidate(
      bucket.remainingFraction,
      bucket.resetTime,
      bucket.window,
      true,
      bucket.disabled
    )
    if (candidate) candidates.push(candidate)
  }

  const binding = pickBindingCandidate(candidates) ?? {
    remaining: 0,
    resetAt: null,
    windowLabel: undefined,
    windowSeconds: undefined
  }

  const usedPercent = Math.min(100, Math.max(0, Math.round((1 - binding.remaining) * 100)))
  const remainingPercent = Math.max(0, 100 - usedPercent)
  const resetsAt = binding.resetAt
  const windows = buildGroupWindows(group)

  return {
    modelId,
    label,
    usedCents: usedPercent,
    limitCents: 100,
    remainingCents: remainingPercent,
    usedPercent,
    remainingPercent,
    resetsAt,
    resetsInLabel: resetsAt ? formatResetLabelFromTimestamp(resetsAt) : '',
    windowLabel: binding.windowLabel,
    windowSeconds: binding.windowSeconds,
    resetAtLabel: resetsAt ? formatResetAt(resetsAt) : '',
    windows: windows.length ? windows : undefined
  }
}

/**
 * Danh sách model user-facing, lấy ĐỘNG từ chính response của
 * fetchAvailableModels (agentModelSorts + command + image), không hardcode.
 * Google thêm model mới → tự xuất hiện, không cần sửa code.
 */
export function collectDisplayModelIds(data: AvailableModelsResponse): string[] {
  const ids: string[] = []
  const seen = new Set<string>()

  const push = (id?: string) => {
    if (!id || seen.has(id)) return
    seen.add(id)
    ids.push(id)
  }

  for (const section of data.agentModelSorts ?? []) {
    for (const group of section.groups ?? []) {
      for (const id of group.modelIds ?? []) push(id)
    }
  }
  for (const id of data.commandModelIds ?? []) push(id)
  for (const id of data.imageGenerationModelIds ?? []) push(id)
  // Model tiered (thinking-level slider của IDE) — ví dụ gemini-3.8-flash-tiered
  for (const ids of Object.values(data.tieredModelIds ?? {})) {
    for (const id of ids ?? []) push(id)
  }

  const withQuota = ids.filter((id) => data.models?.[id]?.quotaInfo)
  if (withQuota.length) {
    return withQuota
  }

  // Fallback: mọi model có displayName + quotaInfo (dedupe theo label, giữ model cạn nhất)
  const byLabel = new Map<string, string>()
  for (const [id, info] of Object.entries(data.models ?? {})) {
    if (!info?.quotaInfo) continue
    const label = (info.displayName ?? info.modelName ?? '').trim()
    if (!label) continue
    const existingId = byLabel.get(label)
    if (!existingId) {
      byLabel.set(label, id)
      continue
    }
    const existing = data.models?.[existingId]?.quotaInfo
    const existingRemaining = normalizeRemainingFraction(existing?.remainingFraction)
    const candidateRemaining = normalizeRemainingFraction(info.quotaInfo.remainingFraction)
    if (candidateRemaining < existingRemaining) {
      byLabel.set(label, id)
    }
  }
  return [...byLabel.values()]
}

/**
 * Trích version number từ modelId/label: "claude-opus-4-6-thinking" → [4,6],
 * "gemini-3.6-flash-high" → [3,6], "gemini-3-flash" → [3].
 */
function extractVersion(text: string): number[] {
  const match = text.match(/(\d+)(?:[.-](\d+))?(?:[.-](\d+))?/)
  if (!match) return []
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)]
}

function compareVersion(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Index của model mới nhất (version cao nhất) khớp pattern; đồng version → theo thứ tự API. */
function pickLatestModelIndex(models: ModelQuota[], pattern: RegExp): number {
  let best = -1
  let bestVersion: number[] = []
  for (let i = 0; i < models.length; i += 1) {
    const { modelId, label } = models[i]
    if (!pattern.test(`${modelId} ${label}`)) continue
    // Ưu tiên version trong label (modelId có thể là tên legacy của Google)
    const version = extractVersion(`${label} ${modelId}`)
    if (best === -1 || compareVersion(version, bestVersion) > 0) {
      best = i
      bestVersion = version
    }
  }
  return best
}

/**
 * Thứ tự hiển thị:
 * 1. Model Claude Opus MỚI NHẤT (pin đầu tiên)
 * 2. Model Gemini MỚI NHẤT (pin thứ hai)
 * 3. Các model còn lại giữ nguyên sort theo % đã dùng (cạn trước)
 */
function sortModelsForDisplay(models: ModelQuota[]): ModelQuota[] {
  const rest = [...models]
  const pinned: ModelQuota[] = []

  const opusIndex = pickLatestModelIndex(rest, /opus/i)
  if (opusIndex >= 0) {
    pinned.push(rest.splice(opusIndex, 1)[0])
  }

  const geminiIndex = pickLatestModelIndex(rest, /gemini/i)
  if (geminiIndex >= 0) {
    pinned.push(rest.splice(geminiIndex, 1)[0])
  }

  return [...pinned, ...rest]
}

/**
 * Label cho model không có displayName (vd model tiered của IDE):
 * "gemini-3.8-flash-tiered" → "Gemini 3.8 Flash"
 * "claude-opus-4-6-thinking" → "Claude Opus 4.6 Thinking" (number liền kề gộp thành version)
 */
export function humanizeModelId(modelId: string): string {
  const cleaned = modelId
    .replace(/-tiered$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim()
  if (!cleaned) return modelId

  const tokens: string[] = []
  for (const word of cleaned.split(' ')) {
    const previous = tokens[tokens.length - 1]
    if (/^\d+$/.test(word) && previous && /^\d+(\.\d+)*$/.test(previous)) {
      tokens[tokens.length - 1] = `${previous}.${word}`
    } else {
      tokens.push(word)
    }
  }

  return tokens
    .map((word) => (/^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ')
}

/**
 * Parse quota ĐỘNG theo model, kết hợp 2 nguồn:
 * - fetchAvailableModels: danh sách model + cửa sổ riêng của model
 * - retrieveUserQuotaSummary: quota THẬT theo nhóm (weekly/5h) — IDE dùng cái này
 * Model bị ràng buộc bởi cửa sổ cạn nhất → hiển thị % đã dùng + nhãn cửa sổ đó.
 */
export function parseAntigravityModelQuotas(
  data: AvailableModelsResponse,
  summary?: QuotaSummaryResponse | null
): ModelQuota[] {
  const groups = summary?.groups ?? []
  const models: ModelQuota[] = collectDisplayModelIds(data).map((modelId) => {
    const info = data.models?.[modelId]
    const rawLabel = info?.displayName?.trim() || info?.modelName?.trim() || humanizeModelId(modelId)
    const label = rawLabel || modelId
    const group = findGroupForModel(groups, `${modelId} ${label}`)
    return buildModelQuota(modelId, label, info?.quotaInfo ?? {}, group)
  })

  models.sort((a, b) => b.usedPercent - a.usedPercent)
  return sortModelsForDisplay(models)
}
