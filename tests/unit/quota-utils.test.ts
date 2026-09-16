import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// L4 (CODE_REVIEW_QUOTA_GROUPS): bản cũ set `process.env.TZ = 'UTC'` — Node trên
// Windows KHÔNG tôn trọng đổi TZ runtime một cách tin cậy (IANA cần registry
// mapping) → assert format tuyệt đối fail trên máy dev Windows. Thay bằng cách
// proxy các local getter của Date.prototype sang bản *UTC — hoạt động mọi nền
// tảng, không đụng environment.
type LocalGetter =
  | 'getDate'
  | 'getMonth'
  | 'getFullYear'
  | 'getHours'
  | 'getMinutes'
  | 'getSeconds'
type UtcGetter =
  | 'getUTCDate'
  | 'getUTCMonth'
  | 'getUTCFullYear'
  | 'getUTCHours'
  | 'getUTCMinutes'
  | 'getUTCSeconds'

const getterOverrides: Array<[LocalGetter, UtcGetter]> = [
  ['getDate', 'getUTCDate'],
  ['getMonth', 'getUTCMonth'],
  ['getFullYear', 'getUTCFullYear'],
  ['getHours', 'getUTCHours'],
  ['getMinutes', 'getUTCMinutes'],
  ['getSeconds', 'getUTCSeconds']
]

beforeAll(() => {
  for (const [localName, utcName] of getterOverrides) {
    // Giữ nguyên `this` (Date instance) khi delegate sang getter UTC tương ứng.
    vi.spyOn(Date.prototype, localName).mockImplementation(function (this: Date) {
      return Date.prototype[utcName].call(this)
    })
  }
})

afterAll(() => {
  vi.restoreAllMocks()
})

const { formatResetAt, formatResetLabelFromSeconds, formatResetLabelFromTimestamp } =
  await import('../../electron/main/quota-utils')

describe('formatResetAt', () => {
  it('rỗng/null/<=0 → chuỗi trống', () => {
    expect(formatResetAt(null)).toBe('')
    expect(formatResetAt(undefined)).toBe('')
    expect(formatResetAt(0)).toBe('')
    expect(formatResetAt(-5)).toBe('')
  })

  it('hiển thị đủ ngày + giờ + phút + GIÂY theo dạng dd/MM/yyyy HH:mm:ss', () => {
    // 2026-09-15T03:04:05Z — TZ=UTC → "15/09/2026 03:04:05"
    expect(formatResetAt(Math.floor(Date.parse('2026-09-15T03:04:05Z') / 1000))).toBe(
      '15/09/2026 03:04:05'
    )
  })

  it('pad số 0 cho ngày/giờ/phút/giây đơn vị', () => {
    expect(formatResetAt(Math.floor(Date.parse('2026-01-02T03:04:05Z') / 1000))).toBe(
      '02/01/2026 03:04:05'
    )
  })

  it('timestamp không hợp lệ → chuỗi trống', () => {
    expect(formatResetAt(NaN)).toBe('')
    expect(formatResetAt(Infinity)).toBe('')
  })

  it('N2: số hữu hạn nhưng vượt range Date (Invalid Date) → chuỗi trống (guard không dead code)', () => {
    // 1e18s * 1000ms > range Date (±8.64e15 ms) → Invalid Date → ''
    expect(formatResetAt(1e18)).toBe('')
  })
})

describe('formatResetLabelFromSeconds', () => {
  it('< 1 phút → giây', () => {
    expect(formatResetLabelFromSeconds(45)).toBe('Reset sau 45s')
  })

  it('< 1 giờ → phút', () => {
    expect(formatResetLabelFromSeconds(600)).toBe('Reset sau 10 phút')
  })

  it('< 1 ngày → giờ + phút', () => {
    expect(formatResetLabelFromSeconds(5 * 3600 + 30 * 60)).toBe('Reset sau 5h 30p')
  })

  it('>= 1 ngày → ngày + giờ (không còn mất giờ như "Reset sau 6 ngày")', () => {
    expect(formatResetLabelFromSeconds(6 * 86400 + 5 * 3600)).toBe('Reset sau 6 ngày 5h')
  })

  it('nguyên ngày → chỉ ngày', () => {
    expect(formatResetLabelFromSeconds(7 * 86400)).toBe('Reset sau 7 ngày')
  })

  it('N3: >= 1 ngày còn lẽ phút → hiển thị cả phút (không làm floor mất 59 phút)', () => {
    // Trước: floor giờ → "6 ngày 5h" khi thực tế còn 5h59m. Sau: "6 ngày 5h 59p".
    expect(formatResetLabelFromSeconds(6 * 86400 + 5 * 3600 + 59 * 60)).toBe('Reset sau 6 ngày 5h 59p')
    // Giờ lẻ = 0 → chỉ ngày + giờ; phút lẽ không có giờ → ngày + phút.
    expect(formatResetLabelFromSeconds(6 * 86400 + 59 * 60)).toBe('Reset sau 6 ngày 59p')
  })

  it('N3: không còn artefact "60 phút" / "5h 60p" / "24h" (ceil đổi đơn vị tự nhiên)', () => {
    expect(formatResetLabelFromSeconds(3599)).toBe('Reset sau 1h') // từng là "60 phút"
    expect(formatResetLabelFromSeconds(5 * 3600 + 59 * 60 + 30)).toBe('Reset sau 6h') // từng là "5h 60p"
    expect(formatResetLabelFromSeconds(86400 - 1)).toBe('Reset sau 1 ngày') // từng là "23h 60p"
    expect(
      formatResetLabelFromSeconds(6 * 86400 + 23 * 3600 + 59 * 60 + 30)
    ).toBe('Reset sau 7 ngày') // từng là "6 ngày 23h 60p"
  })

  it('N3: giây lẻ < 1 phút → floor, không in số thập phân', () => {
    expect(formatResetLabelFromSeconds(45.7)).toBe('Reset sau 45s')
  })

  it('0/âm/undefined → chuỗi trống', () => {
    expect(formatResetLabelFromSeconds(0)).toBe('')
    expect(formatResetLabelFromSeconds(-10)).toBe('')
    expect(formatResetLabelFromSeconds(undefined)).toBe('')
  })
})

describe('formatResetLabelFromTimestamp', () => {
  beforeAll(() => {
    // Mock Date.now() → nhãn countdown deterministic, không phụ thuộc thời điểm chạy test.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-09T00:00:00Z'))
  })
  afterAll(() => {
    vi.useRealTimers()
  })

  it('quá khứ → "Đang reset..."', () => {
    expect(formatResetLabelFromTimestamp(Math.floor(Date.now() / 1000) - 60)).toBe('Đang reset...')
  })

  it('tương lai > 1 ngày → nhãn ngày + giờ + phút', () => {
    // Margin 30 phút để đồng hồ trôi vài giây khi chạy test không làm đổi nhãn
    // (nhãn hiện tới phút — không còn "cận biên giấy phép" như bản chỉ hiện giờ).
    const resetsAt = Math.floor(Date.now() / 1000) + 3 * 86400 + 2 * 3600 + 30 * 60
    expect(formatResetLabelFromTimestamp(resetsAt)).toBe('Reset sau 3 ngày 2h 30p')
  })

  it('null/undefined → chuỗi trống', () => {
    expect(formatResetLabelFromTimestamp(undefined)).toBe('')
  })
})
