import type { Account, AccountQuota, AntigravitySortOption } from './types'

/**
 * Lấy mốc thời gian reset (Unix timestamp tính bằng giây) của Quota TUẦN (weekly / 7 ngày)
 * của nhóm Gemini hoặc Claude & GPT cho một tài khoản.
 * Trả về null nếu tài khoản chưa có quota hoặc nhóm không có mốc reset hợp lệ.
 */
export function getAccountResetTimestamp(
  quota: AccountQuota | undefined | null,
  family: 'gemini' | 'claude'
): number | null {
  if (!quota?.models?.length) {
    return null
  }

  const isGemini = family === 'gemini'
  const matcher = isGemini ? /gemini/i : /(claude|gpt|3p)/i

  const matchingModels = quota.models.filter(
    (m) => matcher.test(m.label) || matcher.test(m.modelId)
  )

  if (!matchingModels.length) {
    return null
  }

  const candidates: number[] = []

  for (const model of matchingModels) {
    const validWindows = (model.windows ?? []).filter(
      (w) => !w.disabled && typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) && w.resetsAt > 0
    )

    if (validWindows.length > 0) {
      // Ưu tiên cửa sổ tuần (weekly / 7 ngày) thay vì cửa sổ 5h theo yêu cầu người dùng
      const weeklyWindows = validWindows.filter(
        (w) =>
          w.windowId === 'weekly' ||
          /week|tuần|7\s*ngày/i.test(w.windowId) ||
          /week|tuần|7\s*ngày/i.test(w.windowLabel ?? '') ||
          (typeof w.windowSeconds === 'number' && w.windowSeconds >= 604800)
      )
      const targetWindows = weeklyWindows.length > 0 ? weeklyWindows : validWindows

      // Nếu có cửa sổ đã cạn (100% đã dùng), thời điểm tài khoản mở lại là max của các cửa sổ cạn
      const exhausted = targetWindows.filter((w) => w.usedPercent >= 100)
      if (exhausted.length > 0) {
        candidates.push(Math.max(...exhausted.map((w) => w.resetsAt!)))
      } else {
        // Ưu tiên các cửa sổ thực sự đã tiêu hao quota (> 0% đã dùng)
        const consumed = targetWindows.filter((w) => w.usedPercent > 0)
        const activeWindows = consumed.length > 0 ? consumed : targetWindows
        candidates.push(Math.min(...activeWindows.map((w) => w.resetsAt!)))
      }
    } else if (typeof model.resetsAt === 'number' && Number.isFinite(model.resetsAt) && model.resetsAt > 0) {
      candidates.push(model.resetsAt)
    }
  }

  if (!candidates.length) {
    return null
  }

  return Math.min(...candidates)
}

/**
 * Sắp xếp danh sách tài khoản Antigravity theo tiêu chí được chọn:
 * - default: giữ nguyên thứ tự hiện tại
 * - gemini-desc / gemini-asc: thời gian reset Quota của Gemini giảm / tăng dần
 * - claude-desc / claude-asc: thời gian reset Quota của Claude and GPT giảm / tăng dần
 *
 * Các tài khoản không có quota hoặc không có mốc reset hợp lệ luôn được đẩy về cuối danh sách.
 */
export function sortAntigravityAccounts(
  accounts: Account[],
  quotas: Record<string, AccountQuota>,
  sortOption: AntigravitySortOption
): Account[] {
  if (sortOption === 'default') {
    return accounts
  }

  const family: 'gemini' | 'claude' = sortOption.startsWith('gemini') ? 'gemini' : 'claude'
  const isAscending = sortOption.endsWith('-asc')

  return [...accounts].sort((a, b) => {
    const resetA = getAccountResetTimestamp(quotas[a.id], family)
    const resetB = getAccountResetTimestamp(quotas[b.id], family)

    if (resetA === null && resetB === null) return 0
    if (resetA === null) return 1
    if (resetB === null) return -1

    if (resetA === resetB) return 0

    return isAscending ? resetA - resetB : resetB - resetA
  })
}
