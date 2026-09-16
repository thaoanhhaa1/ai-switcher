/**
 * Nhãn reset (countdown + trạng thái "đang reset") — đặt trong `src/` để CẢ
 * main (electron/main/quota-utils re-export) lẫn renderer (QuotaPanel) cùng
 * import MỘT nguồn duy nhất (L2 CODE_REVIEW_QUOTA_GROUPS — chống string-coupling;
 * R3 M2: renderer giờ TỰ DERIVE countdown từ numeric resetsAt nên cần chung cả
 * logic format, không chỉ tiền tố).
 */

/** Tiền tố countdown của nhãn do `formatResetLabelFromSeconds` sinh ra. */
export const RESET_COUNTDOWN_PREFIX = 'Reset sau '

/** resetsAt đã qua (L1 R3: dùng chung thay vì mỗi nơi hardcode 1 bản literal). */
export const RESET_IN_PROGRESS_LABEL = 'Đang reset...'

/**
 * Phần THỜI LƯỢNG của countdown (không tiền tố): "45s", "10 phút", "5h 30p",
 * "3 ngày 2h 30p". Quy tắc làm tròn NHẤT QUÁN (fix review N3): quy đổi lên phút
 * bằng CEIL rồi mới tách ngày/giờ/phút bằng FLOOR. Nhờ vậy:
 * - đơn vị nhỏ nhất hiển thị luôn được ceil (không bao giờ "6 ngày 5h" khi
 *   thực tế còn 5h59p);
 * - không còn artefact "60 phút" / "5h 60p" / "6 ngày 24h" (đã tự quy đổi).
 */
export function formatCountdownDuration(seconds?: number): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return ''
  if (seconds < 60) return `${Math.floor(seconds)}s`

  const totalMinutes = Math.ceil(seconds / 60)
  const days = Math.floor(totalMinutes / 1440)
  const restMinutes = totalMinutes % 1440
  const hours = Math.floor(restMinutes / 60)
  const minutes = restMinutes % 60

  if (days > 0) {
    if (hours > 0 && minutes > 0) return `${days} ngày ${hours}h ${minutes}p`
    if (hours > 0) return `${days} ngày ${hours}h`
    if (minutes > 0) return `${days} ngày ${minutes}p`
    return `${days} ngày`
  }
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}p` : `${hours}h`
  return `${minutes} phút`
}

/** Nhãn countdown đầy đủ: "Reset sau 5h 30p" (tiền tố + thời lượng). */
export function formatResetLabelFromSeconds(seconds?: number): string {
  const duration = formatCountdownDuration(seconds)
  return duration ? `${RESET_COUNTDOWN_PREFIX}${duration}` : ''
}

/**
 * Nhãn countdown từ mốc resetsAt (giây epoch): tương lai → "Reset sau X";
 * đã qua → RESET_IN_PROGRESS_LABEL. Dùng Date.now() TẠI THỜI ĐIỂM GỌI —
 * renderer gọi lại mỗi render (tick 60s của QuotaPanel) để countdown "sống"
 * theo thời gian thực thay vì đóng băng số fetch lúc trước (R3 M2).
 */
export function formatResetLabelFromTimestamp(resetsAt?: number): string {
  if (!resetsAt) return ''
  const seconds = resetsAt - Math.floor(Date.now() / 1000)
  if (seconds <= 0) return RESET_IN_PROGRESS_LABEL
  return formatResetLabelFromSeconds(seconds)
}
