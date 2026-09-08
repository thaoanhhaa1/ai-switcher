import { describe, expect, it } from 'vitest'
import { mapPercentCategory } from '../../electron/main/providers/github-copilot'
import type { QuotaWindow } from '../../src/types'

describe('mapPercentCategory (Copilot quota mapping — CODE_REVIEW M4)', () => {
  it('category undefined → null', () => {
    expect(mapPercentCategory(undefined, 'Chat')).toBeNull()
  })

  it('unlimited → 0% used với nhãn Unlimited', () => {
    const w = mapPercentCategory({ unlimited: true }, 'Chat') as QuotaWindow
    expect(w.usedPercent).toBe(0)
    expect(w.remainingPercent).toBe(100)
    expect(w.windowLabel).toContain('Unlimited')
  })

  it('percent_remaining có số → dùng trực tiếp', () => {
    const w = mapPercentCategory({ percent_remaining: 42 }, 'Chat') as QuotaWindow
    expect(w.remainingPercent).toBe(42)
    expect(w.usedPercent).toBe(58)
  })

  it('không có percent_remaining nhưng có remaining/entitlement → tính từ counts', () => {
    const w = mapPercentCategory({ remaining: 30, entitlement: 100 }, 'Chat') as QuotaWindow
    expect(w.remainingPercent).toBe(30)
    expect(w.usedPercent).toBe(70)
    expect(w.usedUnits).toBe(70)
    expect(w.limitUnits).toBe(100)
  })

  it('không có bất kỳ số liệu nào → null (KHÔNG suy ra 100% used)', () => {
    expect(mapPercentCategory({}, 'Chat')).toBeNull()
    expect(mapPercentCategory({ remaining: 0, entitlement: 0 }, 'Chat')).toBeNull()
  })

  it('percent_remaining ngoài [0,100] bị clamp', () => {
    const w = mapPercentCategory({ percent_remaining: 150 }, 'Chat') as QuotaWindow
    expect(w.remainingPercent).toBe(100)
    const w2 = mapPercentCategory({ percent_remaining: -5 }, 'Chat') as QuotaWindow
    expect(w2.remainingPercent).toBe(0)
  })
})
