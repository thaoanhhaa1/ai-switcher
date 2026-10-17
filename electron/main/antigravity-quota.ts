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
 * remainingFraction thiếu/không hợp lệ = 0, clamp [0,1].
 * Semantics của Antigravity API: bucket/model hết quota thường chỉ còn
 * resetTime, không có remainingFraction. Với BUCKET nhóm, dùng
 * `resolveBucketRemaining` (thận trọng hơn khi thiếu cả resetTime).
 */
export function normalizeRemainingFraction(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * Ngưỡng coi resetTime QUÁ KHỨ là stale (fix review L2). Bucket vừa reset nhưng
 * fraction chưa kịp quay lại (race giữa lúc reset) có resetTime chỉ vừa quá vài
 * giây → vẫn tính là cạn. Quá ngưỡng này = lẽ ra đã reset xong từ lâu → stale.
 */
const STALE_RESET_GRACE_SECONDS = 120

/**
 * remainingFraction của một BUCKET nhóm, quy tắc thận trọng (fix review M1):
 * - có số hợp lệ (kể cả 0 tường minh = cạn thật) → chỉ clamp [0,1].
 * - thiếu/không hợp lệ + CÓ resetTime đang hiệu lực (tương lai hoặc vừa quá
 *   trong grace 2 phút) = ĐÃ CẠN (0) — đúng semantics Antigravity
 *   "bucket hết quota chỉ còn resetTime" (protobuf-JSON omit field = default 0.0).
 * - thiếu/không hợp lệ + KHÔNG resetTime = bucket chưa dùng/chưa khởi tạo (tài
 *   khoản mới) → coi là CHƯA DÙNG (1), không báo sai "100% đã dùng".
 * - thiếu/không hợp lệ + resetTime đã QUA SÂU (> grace 2 phút) = reset lẽ ra đã
 *   xong, fraction thiếu chỉ là race nhất thời → coi là stale, trả 1 (fix L2:
 *   tránh trạng thái "100% đã dùng" kèm "Đang reset..." tự mâu thuẫn).
 */
export function resolveBucketRemaining(
  remainingFraction: unknown,
  resetTime?: string,
  nowSeconds?: number,
): number {
  // Có số (kể cả 0 tường minh = cạn thật) → tin giá trị, chỉ clamp.
  if (
    typeof remainingFraction === 'number' &&
    Number.isFinite(remainingFraction)
  ) {
    return normalizeRemainingFraction(remainingFraction)
  }
  const resetAt = parseResetTimestamp(resetTime)
  // Thiếu cả resetTime = chưa dùng.
  if (resetAt === null) return 1
  // L2: resetTime quá khứ sâu → stale (lẽ ra đã refill) → 1 thay vì 0.
  // M1 (review): `nowSeconds` snapshot 1 lần ở parse entry point để cả parse
  // dùng cùng 1 mốc thời gian (không gọi Date.now() mỗi bucket → deterministic).
  const now = nowSeconds ?? Math.floor(Date.now() / 1000)
  if (resetAt < now - STALE_RESET_GRACE_SECONDS) return 1
  // Còn lại (tương lai hoặc vừa quá trong ngưỡng grace) = đã cạn.
  return 0
}

/**
 * windowId derive của một bucket — dùng chung cho buildGroupWindows (lọc window)
 * và binding % tổng (parseAntigravityGroupQuotas) để 2 chỗ không lệch nhau
 * (QUOTA_REVIEW L1).
 */
function getBucketWindowId(
  bucket: Pick<QuotaBucket, 'window' | 'bucketId'>,
): string {
  return (bucket.window ?? '').trim() || (bucket.bucketId ?? '').trim()
}

/**
 * usedPercent = (1 - remaining) * 100, clamp [0,100] (QUOTA_REVIEW L2).
 * - remaining >= 1: 0% đã dùng (100% còn lại, tài khoản mới / chưa dùng).
 * - remaining <= 0: 100% đã dùng (0% còn lại, cạn hoàn toàn).
 * - 0 < remaining < 1: clamp [1, 99], tránh làm tròn về 0% khi người dùng vừa gửi chat
 *   (tiêu thụ một lượng nhỏ token) khiến quota hiển thị sai 100% và ẩn nhãn thời gian reset.
 */
function remainingToUsedPercent(remaining: number): number {
  if (remaining >= 1) return 0
  if (remaining <= 0) return 100
  return Math.min(99, Math.max(1, Math.round((1 - remaining) * 100)))
}

/**
 * modelId ổn định cho thẻ nhóm, derive từ label (QUOTA_REVIEW L3).
 * Dùng hash của label thay vì `group-${index}` để key React không đổi dù thứ tự
 * groups của API đổi giữa 2 lần fetch (tránh remount/mất animation).
 */
function stableGroupId(label: string): string {
  let hash = 0
  for (let i = 0; i < label.length; i += 1) {
    // N1 (CODE_REVIEW_QUOTA_GROUPS): `%` trong JS GIỮ DẤU của dividend nên bản
    // cũ (`% 2**31` + `Math.abs` cuối) chỉ dương giả — abs-collision x vs −x vẫn
    // tồn tại. Chuẩn modulo `((x % n) + n) % n` đưa hash về [0, 2**31) một cách
    // thật sự → không cần Math.abs, không collision đối xứng, vẫn deterministic
    // trên mọi engine ECMAScript.
    hash = (((hash << 5) - hash + label.charCodeAt(i)) % 2 ** 31 + 2 ** 31) % 2 ** 31
  }
  return `group-${hash}`
}

function parseResetTimestamp(resetTime?: string): number | null {
  if (!resetTime) return null
  const timestamp = Date.parse(resetTime)
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null
}

const WINDOW_SECONDS: Record<string, number> = Object.freeze({
  '5h': 18000,
  weekly: 604800,
})

const WINDOW_LABELS: Record<string, string> = Object.freeze({
  '5h': '5 giờ',
  weekly: '7 ngày',
})

// R2 L-NEW-1: đọc qua Object.hasOwn để windowId là prototype key
// ('toString', 'constructor', ...) từ API không trả function từ Object.prototype.
function windowSecondsFor(windowId: string): number | undefined {
  return Object.hasOwn(WINDOW_SECONDS, windowId)
    ? WINDOW_SECONDS[windowId]
    : undefined
}

function windowLabelFor(windowId: string): string | undefined {
  return Object.hasOwn(WINDOW_LABELS, windowId)
    ? WINDOW_LABELS[windowId]
    : undefined
}

function toWindowCandidate(
  remainingFraction: number | undefined,
  resetTime: string | undefined,
  window?: string,
  skipDisabled = false,
  disabled?: boolean,
  nowSeconds?: number,
): WindowCandidate | null {
  if (skipDisabled && disabled) return null
  // QUOTA_REVIEW N3 + fix M1: thiếu fraction + có resetTime = CẠN (0), đồng bộ
  // semantics với buildGroupWindows — thẻ model % tổng phải khớp window row,
  // không được skip bucket cạn (skip sẽ khiến thẻ < 100% dù row hiển thị 100%).
  // Thiếu cả resetTime (bucket chưa dùng) → 1 (fix M1), không báo sai 100%.
  const seconds = window ? windowSecondsFor(window) : undefined
  return {
    remaining: resolveBucketRemaining(
      remainingFraction,
      resetTime,
      nowSeconds,
    ),
    resetAt: parseResetTimestamp(resetTime),
    windowLabel: window ? windowLabelFor(window) : undefined,
    windowSeconds: seconds,
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
  modelHaystack: string,
): QuotaSummaryGroup | undefined {
  if (!groups.length) return undefined
  const isThirdParty = /claude|gpt/i.test(modelHaystack)
  const matches = (group: QuotaSummaryGroup, pattern: RegExp) => {
    const haystack = [
      group.displayName ?? '',
      group.description ?? '',
      ...(group.buckets ?? []).map((b) => b.bucketId ?? ''),
    ].join(' ')
    return pattern.test(haystack)
  }
  const wanted = isThirdParty ? /claude|gpt|3p/i : /gemini/i
  const avoided = isThirdParty ? /gemini/i : /claude|gpt|3p/i
  return (
    groups.find(
      (group) => matches(group, wanted) && !matches(group, avoided),
    ) ??
    (groups.length === 1 && !matches(groups[0], avoided)
      ? groups[0]
      : undefined)
  )
}

function pickBindingCandidate(
  candidates: WindowCandidate[],
): WindowCandidate | null {
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
          (best.resetAt === null ||
            candidate.resetAt < best.resetAt))
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
function buildGroupWindows(
  group?: QuotaSummaryGroup,
  nowSeconds?: number,
): ModelQuotaWindow[] {
  const windows: ModelQuotaWindow[] = []
  for (const bucket of group?.buckets ?? []) {
    const windowId = getBucketWindowId(bucket)
    if (!windowId) continue
    // Bucket non-disabled thiếu remainingFraction + CÓ resetTime = ĐÃ CẠN (0) —
    // đúng semantics "hết quota thì chỉ còn resetTime, không có remainingFraction"
    // (protobuf-JSON omit field = default 0.0, QUOTA_REVIEW H1). Thiếu cả resetTime
    // = bucket chưa dùng → 1 (fix M1, không báo sai 100% cho tài khoản mới).
    // nowSeconds (fix review M1): snapshot 1 lần ở parse entry point — cả parse
    // dùng cùng 1 mốc thời gian, deterministic trong test.
    const remaining = resolveBucketRemaining(
      bucket.remainingFraction,
      bucket.resetTime,
      nowSeconds,
    )
    const usedPercent = remainingToUsedPercent(remaining)
    const resetsAt = parseResetTimestamp(bucket.resetTime)
    windows.push({
      windowId,
      // N2 (CODE_REVIEW_QUOTA_GROUPS): giữ bucketId gốc — 2 bucket trùng
      // windowId + windowSeconds (sort trả 0, giữ thứ tự API) vẫn có định danh
      // riêng để React key ổn định qua các lần fetch.
      bucketId: bucket.bucketId?.trim() || undefined,
      windowLabel:
        // L2 (CODE_REVIEW_QUOTA_GROUPS_R2): `??` không chặn chuỗi rỗng — dùng
        // trim + `||` để displayName '' / toàn whitespace rơi về windowId,
        // tránh row render label trống.
        windowLabelFor(windowId) ?? (bucket.displayName?.trim() || windowId),
      windowSeconds: windowSecondsFor(windowId),
      usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
      resetsAt,
      resetsInLabel: resetsAt
        ? formatResetLabelFromTimestamp(resetsAt)
        : '',
      resetAtLabel: resetsAt ? formatResetAt(resetsAt) : '',
      disabled: bucket.disabled === true,
    })
  }
  // M3: sort chung 1 chỗ cho cả 2 layout (models + groups) — thứ tự window
  // giống nhau, không phụ thuộc thứ tự bucket API. M2: tie-breaker windowId khi 2
  // bucket cùng window (sort không stable trên V8 cũ → tránh UI flash).
  return windows.sort(
    (a, b) =>
      (a.windowSeconds ?? Number.MAX_SAFE_INTEGER) -
        (b.windowSeconds ?? Number.MAX_SAFE_INTEGER) ||
      a.windowId.localeCompare(b.windowId),
  )
}

export function buildModelQuota(
  modelId: string,
  label: string,
  info: ModelQuotaInfo,
  group?: QuotaSummaryGroup,
  nowSeconds?: number,
): ModelQuota {
  const candidates: WindowCandidate[] = []

  // 1. Cửa sổ của riêng model (fetchAvailableModels) — thiếu remainingFraction = cạn
  const ownRemaining = normalizeRemainingFraction(info.remainingFraction)
  candidates.push({
    remaining: ownRemaining,
    resetAt: parseResetTimestamp(info.resetTime),
  })

  // 2. Các cửa sổ của nhóm (retrieveUserQuotaSummary) — bỏ bucket disabled;
  //    thiếu remainingFraction = cạn (QUOTA_REVIEW N3, khớp window row)
  for (const bucket of group?.buckets ?? []) {
    const candidate = toWindowCandidate(
      bucket.remainingFraction,
      bucket.resetTime,
      bucket.window,
      true,
      bucket.disabled,
      nowSeconds,
    )
    if (candidate) candidates.push(candidate)
  }

  const binding = pickBindingCandidate(candidates) ?? {
    remaining: 0,
    resetAt: null,
    windowLabel: undefined,
    windowSeconds: undefined,
  }

  const usedPercent = remainingToUsedPercent(binding.remaining)
  const remainingPercent = Math.max(0, 100 - usedPercent)
  const resetsAt = binding.resetAt
  // M1 (review 2): truyền nowSeconds snapshot — windows phải dùng cùng mốc
  // thời gian với binding % tổng (toWindowCandidate ở trên), không gọi Date.now() riêng.
  const windows = buildGroupWindows(group, nowSeconds)

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
    windows: windows.length ? windows : undefined,
  }
}

/**
 * Danh sách model user-facing, lấy ĐỘNG từ chính response của
 * fetchAvailableModels (agentModelSorts + command + image), không hardcode.
 * Google thêm model mới → tự xuất hiện, không cần sửa code.
 */
export function collectDisplayModelIds(
  data: AvailableModelsResponse,
): string[] {
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
    const existingRemaining = normalizeRemainingFraction(
      existing?.remainingFraction,
    )
    const candidateRemaining = normalizeRemainingFraction(
      info.quotaInfo.remainingFraction,
    )
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
    .map((word) =>
      /^\d/.test(word)
        ? word
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
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
  summary?: QuotaSummaryResponse | null,
): ModelQuota[] {
  // Review M1: snapshot `now` 1 lần cho cả parse (mọi bucket cùng mốc thời gian).
  const now = Math.floor(Date.now() / 1000)
  const groups = summary?.groups ?? []
  const models: ModelQuota[] = collectDisplayModelIds(data).map((modelId) => {
    const info = data.models?.[modelId]
    const rawLabel =
      info?.displayName?.trim() ||
      info?.modelName?.trim() ||
      humanizeModelId(modelId)
    const label = rawLabel || modelId
    const group = findGroupForModel(groups, `${modelId} ${label}`)
    return buildModelQuota(
      modelId,
      label,
      info?.quotaInfo ?? {},
      group,
      now,
    )
  })

  models.sort((a, b) => b.usedPercent - a.usedPercent)
  return sortModelsForDisplay(models)
}

/**
 * Parse quota theo NHÓM model (retrieveUserQuotaSummary) — mỗi group = 1 ModelQuota.
 * - windows = buildGroupWindows(group): cửa sổ 5h/weekly (kể cả disabled → "Không áp dụng").
 * - % tổng của thẻ nhóm = bucket CẠN NHẤT (min remaining) qua resolveBucketRemaining:
 *   thiếu fraction + resetTime còn hiệu lực = cạn (0); thiếu cả hai hoặc resetTime
 *   đã qua sâu (stale — fix L2) = chưa dùng (1). Giữ semantics "nhóm hết hạn mức →
 *   chỉ còn resetTime" và nhất quán 100% với window row.
 * - Nhóm không có bucket hợp lệ → bỏ qua (không render thẻ rỗng).
 * - Không group nào hợp lệ → trả [] (caller fallback về parse theo model).
 */
export function parseAntigravityGroupQuotas(
  summary?: QuotaSummaryResponse | null,
): ModelQuota[] {
  // Review M1: snapshot `now` 1 lần cho cả parse (mọi bucket cùng mốc thời gian).
  const now = Math.floor(Date.now() / 1000)
  // 2-pass (fix CODE_REVIEW M1): pass 1 tính (label, fingerprint) của mọi nhóm
  // hợp lệ; pass 2 mới gán id. Suffix theo NỘI DUNG bucket (fingerprint) và chỉ
  // gắn vào nhóm TRÙNG label/hash với nhóm khác — KHÔNG phụ thuộc thứ tự gặp
  // (phương pháp cũ "nhóm đầu không suffix, nhóm sau suffix" khiến đảo thứ tự
  // API → 2 nhóm hoán đổi id cho nhau → React remount cả 2).
  const prepared = (summary?.groups ?? []).flatMap((group) => {
    // R3 M1: phần tử null/undefined trong mảng groups (protobuf-JSON có thể emit
    // nulls) phải bị bỏ qua ở ĐÂY — buildGroupWindows phòng thủ bằng `group?.` nhưng
    // các dòng dưới deref thẳng `group.buckets`/`group.displayName`. Nếu để
    // TypeError thoát ra ngoài, try/catch của fetchAntigravityQuota nuốt luôn cả
    // nhánh fallback parse theo model → user mất toàn bộ quota vì 1 phần tử null.
    if (!group) return []
    const windows = buildGroupWindows(group, now)
    const bindingBuckets = (group.buckets ?? []).filter(
      (b) => b.disabled !== true && getBucketWindowId(b) !== '',
    )
    if (!windows.length || !bindingBuckets.length) return []
    // L1: nhóm thiếu displayName → label fallback theo NỘI DUNG bucket (nối
    // bucketId, thiếu thì windowId) thay vì `index + 1`. Nội dung bucket ổn định
    // qua các lần fetch nên modelId (derive từ label) không đổi khi API đổi thứ
    // tự groups/buckets — giữ đúng mục tiêu L3 (không remount).
    // Guard bindingBuckets ở trên đảm bảo fingerprint luôn khác rỗng.
    const fallbackFingerprint = bindingBuckets
      .map((b) => (b.bucketId ?? '').trim() || getBucketWindowId(b))
      .filter(Boolean)
      .sort()
      .join('+')
    const label =
      group.displayName?.trim() || `Nhóm model ${fallbackFingerprint}`
    return [
      {
        label,
        fingerprint: fallbackFingerprint,
        windows,
        bindingBuckets,
        baseId: stableGroupId(label),
      },
    ]
  })
  const labelCounts = new Map<string, number>()
  for (const item of prepared) {
    labelCounts.set(item.baseId, (labelCounts.get(item.baseId) ?? 0) + 1)
  }
  const usedIds = new Set<string>()
  // L3 (CODE_REVIEW_QUOTA_GROUPS): sort theo usedPercent GIẢM DẦN (nhóm cạn nhất
  // trước) — khớp semantics layout 'models' và đảm bảo compact slice(0,2) không
  // ẩn nhóm cạn nhất. Tie-breaker label + modelId (nội dung, không thứ tự API)
  // → deterministic giữa các lần fetch; React key là modelId ổn định nên thẻ
  // chỉ di chuyển vị trí DOM, không remount.
  const cards = prepared.flatMap(({ label, fingerprint, windows, bindingBuckets, baseId }) => {
    // % tổng = bucket CẠN NHẤT — tính thẳng từ remainingFraction gốc của chính
    // các window render (không vòng qua usedPercent đã round — QUOTA_REVIEW L8;
    // resolveBucketRemaining đồng bộ với buildGroupWindows — fix M1).
    const bindingRemaining = Math.min(
      ...bindingBuckets.map((b) =>
        resolveBucketRemaining(b.remainingFraction, b.resetTime, now),
      ),
    )
    const usedPercent = remainingToUsedPercent(bindingRemaining)
    const remainingPercent = Math.max(0, 100 - usedPercent)

    // modelId (fix CODE_REVIEW M1): nhóm TRÙNG baseId (duplicate displayName hoặc
    // abs-hash collide) → suffix theo fingerprint NỘI DUNG bucket, gắn NHẤT QUÁN
    // cho mọi thành viên của nhóm trùng → đảo thứ tự API không làm hoán đổi id.
    // Vòng lặp counter chỉ còn cho edge cả baseId lẫn fingerprint đều trùng (dữ
    // liệu hoàn toàn trùng — remount khi đó chấp nhận được).
    let modelId =
      (labelCounts.get(baseId) ?? 0) > 1
        ? `${baseId}-${stableGroupId(fingerprint)}`
        : baseId
    let collision = 2
    while (usedIds.has(modelId)) {
      modelId = `${baseId}-${stableGroupId(fingerprint)}-${collision}`
      collision += 1
    }
    usedIds.add(modelId)

    return {
      modelId,
      label,
      usedCents: usedPercent,
      limitCents: 100,
      remainingCents: remainingPercent,
      usedPercent,
      remainingPercent,
      // QUOTA_REVIEW N4: thẻ nhóm cố ý không bind reset chung — mỗi window row
      // tự hiển thị reset của bucket mình (để rỗng có chủ ý, không phải bug).
      resetsAt: null,
      resetsInLabel: '',
      windowLabel: undefined,
      windowSeconds: undefined,
      resetAtLabel: '',
      windows,
    }
  })
  return cards.sort((a, b) => {
    // Ưu tiên hiển thị: Gemini Models luôn lên trên Claude and GPT models (đồng bộ giao diện Antigravity IDE)
    const isGeminiA = /gemini/i.test(a.label)
    const isGeminiB = /gemini/i.test(b.label)
    if (isGeminiA && !isGeminiB) return -1
    if (!isGeminiA && isGeminiB) return 1

    const isClaudeA = /claude|gpt|3p/i.test(a.label)
    const isClaudeB = /claude|gpt|3p/i.test(b.label)
    if (isClaudeA && !isClaudeB) return -1
    if (!isClaudeA && isClaudeB) return 1

    return (
      b.usedPercent - a.usedPercent ||
      a.label.localeCompare(b.label) ||
      a.modelId.localeCompare(b.modelId)
    )
  })
}
