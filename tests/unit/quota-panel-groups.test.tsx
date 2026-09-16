// @vitest-environment jsdom
// L3 (CODE_REVIEW_QUOTA_GROUPS): render test cho UI logic của layout 'groups' —
// gating displayMode, compact slice riêng, row disabled, nhãn reset (N4), a11y bar.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { QuotaPanel } from '../../src/components/QuotaPanel'
import type {
  AccountQuota,
  ModelQuota,
  ModelQuotaWindow,
  QuotaWindow
} from '../../src/types'

afterEach(() => {
  cleanup()
})

const emptyWindow: QuotaWindow = {
  usedCents: 0,
  limitCents: 0,
  remainingCents: 0,
  usedPercent: 0,
  remainingPercent: 0,
  resetsAt: null,
  resetsInLabel: ''
}

type WinSeed = Partial<ModelQuotaWindow> & Pick<ModelQuotaWindow, 'windowId' | 'windowLabel'>

function win(overrides: WinSeed): ModelQuotaWindow {
  return {
    windowSeconds: undefined,
    usedPercent: 0,
    remainingPercent: 100,
    resetsAt: null,
    resetsInLabel: '',
    resetAtLabel: '',
    ...overrides
  }
}

function group(
  modelId: string,
  label: string,
  usedPercent: number,
  windows: ModelQuotaWindow[]
): ModelQuota {
  return {
    modelId,
    label,
    usedCents: usedPercent,
    limitCents: 100,
    remainingCents: 100 - usedPercent,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt: null,
    resetsInLabel: '',
    resetAtLabel: '',
    windows
  }
}

function model(modelId: string, label: string, usedPercent: number, windows?: ModelQuotaWindow[]): ModelQuota {
  return {
    ...group(modelId, label, usedPercent, windows ?? []),
    windows: windows?.length ? windows : undefined
  }
}

function makeQuota(
  models: ModelQuota[],
  layout: 'models' | 'groups',
  displayMode: 'cents' | 'percent'
): AccountQuota {
  return {
    available: true,
    hasActiveLimits: true,
    displayMode,
    quotaLayout: layout,
    models,
    hourly: { ...emptyWindow },
    weekly: { ...emptyWindow },
    updatedAt: '2026-09-09T00:00:00.000Z'
  }
}

/**
 * Mốc 5h30p trong tương lai (tính lúc gọi, không lúc module load — fix
 * CODE_REVIEW_QUOTA_GROUPS_R3 LOW 8: tránh flake nếu CI stall > 30s giữa
 * load module và chạy test).
 * - 5h30p có margin > 60s nên ceil(minutes) ổn định trong ~60s.
 * - weekly window +2 ngày 4h so với mốc này.
 */
function future5h30(): number {
  return Math.floor(Date.now() / 1000) + 5 * 3600 + 30 * 60
}

/**
 * Nhóm Claude được tạo LƯỜI (lazy) — resetsAt tính theo thời điểm gọi, không
 * còn phụ thuộc thời gian load module. Gọi makeClaudeGroup() mỗi test cần.
 */
function makeClaudeGroup() {
  const base = future5h30()
  return group('group-100', 'Claude and GPT models', 70, [
    win({
      windowId: '5h',
      windowLabel: '5 giờ',
      windowSeconds: 18000,
      usedPercent: 20,
      remainingPercent: 80,
      resetsAt: base,
      // Chuỗi countdown SAI có chủ ý — proof R3 M2: renderer phải derive "(còn 5h 30p)"
      // từ resetsAt, KHÔNG tin chuỗi fetch cũ (trước fix số cũ in nguyên từ lúc fetch).
      resetsInLabel: 'Reset sau 99 ngày',
      resetAtLabel: '15/09/2026 03:04:05'
    }),
    win({
      windowId: 'weekly',
      windowLabel: '7 ngày',
      windowSeconds: 604800,
      usedPercent: 70,
      remainingPercent: 30,
      resetsAt: base + 2 * 86400 + 4 * 3600,
      resetsInLabel: 'Reset sau 2 ngày 4h',
      resetAtLabel: '16/09/2026 03:04:05'
    })
  ])
}

/**
 * Nhóm Gemini với window 5h disabled — resetsAt dùng giá trị quá khứ cố
 * định (không phụ thuộc Date.now()) vì không assert vào số cụ thể.
 */
const geminiGroup = group('group-200', 'Gemini Models', 10, [
  win({ windowId: 'weekly', windowLabel: '7 ngày', windowSeconds: 604800, usedPercent: 10, remainingPercent: 90 }),
  win({
    windowId: '5h',
    windowLabel: '5 giờ',
    windowSeconds: 18000,
    usedPercent: 0,
    remainingPercent: 100,
    disabled: true,
    // Dù có label reset cũng phải bị ẩn (L5) — row disabled.
    resetsInLabel: 'Đang reset...',
    resetAtLabel: '09/09/2026 10:00:00'
  })
])

describe('QuotaPanel — layout groups (L3)', () => {
  it("layout 'groups' + displayMode 'percent' → thẻ nhóm với window row inline, không có tab", () => {
    const { container } = render(<QuotaPanel quota={makeQuota([makeClaudeGroup(), geminiGroup], 'groups', 'percent')} />)

    // Card head: tên nhóm + % tổng.
    const heads = [...container.querySelectorAll('.quota-card-head')].map((el) => el.textContent)
    expect(heads).toContain('Quota Claude and GPT models70% đã dùng')
    expect(heads).toContain('Quota Gemini Models10% đã dùng')

    // Window row hiển thị label + % từng cửa sổ.
    const rowLabels = [...container.querySelectorAll('.quota-group-window-label')].map((el) => el.textContent)
    expect(rowLabels).toEqual(['5 giờ', '7 ngày', '7 ngày', '5 giờ'])
    expect(container.textContent).toContain('20% đã dùng')
    expect(container.textContent).toContain('10% đã dùng')

    // Không render tab switching trên đường groups.
    expect(container.querySelector('[role="tablist"]')).toBeNull()
  })

  it("gating: layout 'groups' + displayMode 'cents' → KHÔNG render thẻ nhóm", () => {
    const { container } = render(<QuotaPanel quota={makeQuota([makeClaudeGroup(), geminiGroup], 'groups', 'cents')} />)
    expect(container.querySelectorAll('.quota-group-window-label')).toHaveLength(0)
    expect(container.querySelector('.quota-group-windows')).toBeNull()
    // Đường model có tab derive từ windows.
    expect(container.querySelector('[role="tablist"]')).not.toBeNull()
  })

  it('row disabled → "Không áp dụng", ẩn cả bar lẫn reset của bucket đó (L5)', () => {
    const { container } = render(<QuotaPanel quota={makeQuota([geminiGroup], 'groups', 'percent')} />)
    const disabledRow = container.querySelector('.quota-group-window.disabled')
    expect(disabledRow).not.toBeNull()
    expect(disabledRow?.textContent).toContain('Không áp dụng')
    expect(disabledRow?.querySelector('.quota-bar')).toBeNull()
    expect(disabledRow?.querySelector('.quota-group-reset')).toBeNull()
  })

  it('N4: reset tương lai → "Reset lúc: X (còn Y)"; reset đã qua → "Đang reset... (từ lúc X)"', () => {
    const pastReset = win({
      windowId: '5h',
      windowLabel: '5 giờ',
      windowSeconds: 18000,
      usedPercent: 100,
      remainingPercent: 0,
      resetsAt: 1_000,
      resetsInLabel: 'Đang reset...',
      resetAtLabel: '09/09/2026 10:00:00'
    })
    const n4Quota = makeQuota(
      [group('g-p', 'Nhóm N4', 100, [makeClaudeGroup().windows![0], pastReset])],
      'groups',
      'percent'
    )
    const { container } = render(<QuotaPanel quota={n4Quota} />)
    const resetTexts = [...container.querySelectorAll('.quota-group-reset')].map((el) => el.textContent)
    // R3 M2: countdown derive từ resetsAt (5h30p tương lai), KHÔNG phải chuỗi
    // 'Reset sau 99 ngày' của fetch cũ.
    expect(resetTexts).toContain('Reset lúc: 15/09/2026 03:04:05 (còn 5h 30p)')
    expect(container.textContent).not.toContain('99 ngày')
    // Không còn chuỗi lạ "Reset lúc: ... (Đang reset...)".
    expect(resetTexts).toContain('Đang reset... (từ lúc 09/09/2026 10:00:00)')
    expect(container.textContent).not.toContain('(Đang reset...)')
  })

  it('R3 M2: countdown re-derive mỗi render theo Date.now() — không còn đóng băng số fetch lúc trước', async () => {
    // Vi fake timers + act() đẩy đồng hồ 61 phút: nhãn phải đổi từ "(còn 5h 30p)"
    // sang thời lượng mới (còn 4h 30p), chứng minh tick 60s setState → re-render
    // → groupWindowResetText tính lại từ resetsAt.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.now()))
    try {
      const { container } = render(
        <QuotaPanel quota={makeQuota([group('g-m2', 'Nhóm M2', 20, [makeClaudeGroup().windows![0]])], 'groups', 'percent')} />
      )
      expect(container.querySelector('.quota-group-reset')?.textContent).toContain('(còn 5h 30p)')

      await act(async () => {
        vi.advanceTimersByTime(60 * 60 * 1000 + 1000)
      })
      expect(container.querySelector('.quota-group-reset')?.textContent).toContain('(còn 4h 30p)')
    } finally {
      vi.useRealTimers()
    }
  })

  it('bar của window row có aria progressbar đúng % (a11y)', () => {
    render(<QuotaPanel quota={makeQuota([makeClaudeGroup()], 'groups', 'percent')} />)
    const bars = screen.getAllByRole('progressbar')
    // L2 (CODE_REVIEW_QUOTA_GROUPS): 1 row/windowLabel → KHÔNG có `#N` trong aria-label.
    const weekly = bars.find((el) => el.getAttribute('aria-label') === 'Quota 7 ngày — mức đã dùng')
    expect(weekly).toBeDefined()
    expect(weekly?.getAttribute('aria-valuenow')).toBe('70')
    expect(weekly?.getAttribute('aria-valuetext')).toBe('70% đã dùng')
    expect(weekly?.getAttribute('aria-valuemax')).toBe('100')
  })

  it('L2: 2 bucket cùng windowLabel → aria-label có `#N`; nhóm 1 window không có', () => {
    const dupWindowGroup = group('g-dup', 'Nhóm trùng window', 50, [
      win({ windowId: '5h', windowLabel: '5 giờ', windowSeconds: 18000, usedPercent: 30, remainingPercent: 70 }),
      win({ windowId: '5h-b', windowLabel: '5 giờ', windowSeconds: 18000, usedPercent: 80, remainingPercent: 20 })
    ])
    const singleGroup = group('g-single', 'Nhóm 1 window', 10, [
      win({ windowId: 'weekly', windowLabel: '7 ngày', windowSeconds: 604800, usedPercent: 10, remainingPercent: 90 })
    ])
    const { container } = render(
      <QuotaPanel quota={makeQuota([dupWindowGroup, singleGroup], 'groups', 'percent')} />
    )
    const labels = [...container.querySelectorAll('.quota-group-bar')].map((el) => el.getAttribute('aria-label'))
    expect(labels).toEqual([
      'Quota 5 giờ #1 — mức đã dùng',
      'Quota 5 giờ #2 — mức đã dùng',
      'Quota 7 ngày — mức đã dùng'
    ])
  })

  it('L1: 2 row trùng windowLabel KHÔNG liền kề trong mảng → #N đánh theo nhóm label (1,2 chứ không 1,3)', () => {
    // '5h' (18000s) và bucket lạ 'fivehour' (windowSeconds undefined → sort cuối)
    // cùng displayName '5 giờ', chen giữa là weekly → index mảng 0 và 2.
    const l1Group = group('g-l1', 'Nhóm L1', 50, [
      win({ windowId: '5h', windowLabel: '5 giờ', windowSeconds: 18000, usedPercent: 30, remainingPercent: 70 }),
      win({ windowId: 'weekly', windowLabel: '7 ngày', windowSeconds: 604800, usedPercent: 40, remainingPercent: 60 }),
      win({ windowId: 'fivehour', windowLabel: '5 giờ', usedPercent: 80, remainingPercent: 20 })
    ])
    const { container } = render(<QuotaPanel quota={makeQuota([l1Group], 'groups', 'percent')} />)
    const labels = [...container.querySelectorAll('.quota-group-bar')].map((el) => el.getAttribute('aria-label'))
    expect(labels).toEqual([
      'Quota 5 giờ #1 — mức đã dùng',
      'Quota 7 ngày — mức đã dùng',
      'Quota 5 giờ #2 — mức đã dùng'
    ])
  })

  it('R3 M3: bucket disabled trùng windowLabel KHÔNG chiếm số thứ tự — row enabled duy nhất không bị đọc "#2" mồ côi', () => {
    // 2 bucket cùng windowLabel '5 giờ' (1 disabled + 1 enabled — xảy ra thật
    // khi buildGroupWindows giữ bucket disabled và displayName fallback cho ra
    // label trùng). Trước fix: row enabled nhận sequence = 2 dù chỉ có 1 bar
    // trên màn hình → screen reader đọc "#2" mà không có "#1" nào.
    const mixedGroup = group('g-m3', 'Nhóm M3', 50, [
      win({ windowId: '5h-a', windowLabel: '5 giờ', windowSeconds: 18000, usedPercent: 30, remainingPercent: 70 }),
      win({
        windowId: '5h-b',
        windowLabel: '5 giờ',
        windowSeconds: 18000,
        usedPercent: 0,
        remainingPercent: 100,
        disabled: true
      })
    ])
    const { container } = render(<QuotaPanel quota={makeQuota([mixedGroup], 'groups', 'percent')} />)
    const labels = [...container.querySelectorAll('.quota-group-bar')].map((el) => el.getAttribute('aria-label'))
    // Row enabled duy nhất → KHÔNG có `#N`.
    expect(labels).toEqual(['Quota 5 giờ — mức đã dùng'])
    expect(labels[0]).not.toContain('#')

    // 2 row enabled + 1 disabled cùng label → #1/#2 chỉ đếm row enabled.
    const threeGroup = group('g-m3b', 'Nhóm M3b', 50, [
      win({ windowId: '5h-a', windowLabel: '5 giờ', windowSeconds: 18000, usedPercent: 30, remainingPercent: 70 }),
      win({ windowId: '5h-b', windowLabel: '5 giờ', windowSeconds: 18000, usedPercent: 80, remainingPercent: 20 }),
      win({
        windowId: '5h-c',
        windowLabel: '5 giờ',
        windowSeconds: 18000,
        usedPercent: 0,
        remainingPercent: 100,
        disabled: true
      })
    ])
    const { container: c3 } = render(<QuotaPanel quota={makeQuota([threeGroup], 'groups', 'percent')} />)
    const labels3 = [...c3.querySelectorAll('.quota-group-bar')].map((el) => el.getAttribute('aria-label'))
    expect(labels3).toEqual([
      'Quota 5 giờ #1 — mức đã dùng',
      'Quota 5 giờ #2 — mức đã dùng'
    ])
  })

  it('L2: trạng thái reset derive từ numeric resetsAt — countdown cũ nhưng resetsAt đã qua → "Đang reset..."', () => {
    const stale = win({
      windowId: '5h',
      windowLabel: '5 giờ',
      windowSeconds: 18000,
      usedPercent: 100,
      remainingPercent: 0,
      // resetsAt QUA ở quá khứ xa (1970) nhưng resetsInLabel vẫn là countdown
      // cũ (fetch trước đó) — phải normalize, không ghép "(còn ...)" sai.
      resetsAt: 1_000,
      resetsInLabel: 'Reset sau 5h 30p',
      resetAtLabel: '15/09/2026 03:04:05'
    })
    const { container } = render(
      <QuotaPanel quota={makeQuota([group('g-l2', 'Nhóm L2', 100, [stale])], 'groups', 'percent')} />
    )
    const resetTexts = [...container.querySelectorAll('.quota-group-reset')].map((el) => el.textContent)
    expect(resetTexts).toContain('Đang reset... (từ lúc 15/09/2026 03:04:05)')
    expect(container.textContent).not.toContain('(còn 5h 30p)')
  })

  it('row cạn 100% → class danger trên nhãn % của row', () => {
    const exhausted = group(
      'g-d',
      'Nhóm cạn',
      100,
      [win({ windowId: '5h', windowLabel: '5 giờ', windowSeconds: 18000, usedPercent: 100, remainingPercent: 0 })]
    )
    const { container } = render(<QuotaPanel quota={makeQuota([exhausted], 'groups', 'percent')} />)
    expect(container.querySelector('.quota-group-window .quota-danger-text')?.textContent).toBe('100% đã dùng')
  })

  it('compact groups: slice(0, 2) + note "+N nhóm khác" (khác slice models (0,3))', () => {
    const third = group('group-300', 'Nhóm ba', 0, [])
    const { container } = render(
      <QuotaPanel quota={makeQuota([makeClaudeGroup(), geminiGroup, third], 'groups', 'percent')} compact />
    )
    expect(container.querySelectorAll('.quota-card.compact')).toHaveLength(2)
    expect(container.querySelector('.quota-note')?.textContent).toBe('+1 nhóm khác (mở chi tiết để xem quota)')
  })

  it('compact models: slice(0, 3) + note "+N model khác"', () => {
    const models = [
      model('m1', 'Model 1', 10),
      model('m2', 'Model 2', 20),
      model('m3', 'Model 3', 30),
      model('m4', 'Model 4', 40)
    ]
    const { container } = render(<QuotaPanel quota={makeQuota(models, 'models', 'percent')} compact />)
    expect(container.querySelectorAll('.quota-card.compact')).toHaveLength(3)
    expect(container.querySelector('.quota-note')?.textContent).toBe('+1 model khác (mở chi tiết để xem quota)')
  })
})
