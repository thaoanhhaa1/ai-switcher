import { describe, expect, it, vi } from 'vitest'
import {
  AutoTestChatJob,
  calculateNextResetDelayMs,
  executeAutoTestChatForAccounts,
  getFamiliesDueForWeeklyReset,
  getFamiliesWith100PercentWeeklyQuota,
  getNextWeeklyResetTimestamp,
  getWeeklyResetTimestamp,
  hasAccountsPendingWeeklyReset,
  hasWeeklyQuota100Percent,
  isFamilyShortTermExhausted,
  isWeeklyQuotaDueForReset,
  isWeeklyQuota100Percent,
  isWeeklyWindow,
  isWindow100Percent
} from '../../src/antigravity-auto-chat'
import type { Account, AccountQuota } from '../../src/types'

function makeAccount(id: string, name: string, provider: any = 'antigravity'): Account {
  return {
    id,
    name,
    provider,
    apiKey: '',
    settings: { model: 'claude', modelReasoningEffort: 'high' },
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    switchCount: 0
  }
}

function makeQuota(models: any[]): AccountQuota {
  return {
    available: true,
    hasActiveLimits: true,
    displayMode: 'percent',
    quotaLayout: 'groups',
    models,
    hourly: {
      usedCents: 0,
      limitCents: 0,
      remainingCents: 0,
      usedPercent: 0,
      remainingPercent: 0,
      resetsAt: null,
      resetsInLabel: ''
    },
    weekly: {
      usedCents: 0,
      limitCents: 0,
      remainingCents: 0,
      usedPercent: 0,
      remainingPercent: 0,
      resetsAt: null,
      resetsInLabel: ''
    },
    updatedAt: new Date().toISOString()
  }
}

describe('antigravity-auto-chat', () => {
  describe('isWeeklyWindow', () => {
    it('identifies weekly windows correctly', () => {
      expect(isWeeklyWindow({ windowId: 'weekly' })).toBe(true)
      expect(isWeeklyWindow({ windowId: '7d', windowSeconds: 604800 })).toBe(true)
      expect(isWeeklyWindow({ windowId: 'window-1', windowLabel: '7 ngày' })).toBe(true)
      expect(isWeeklyWindow({ windowId: 'window-2', windowLabel: 'Tuần này' })).toBe(true)
      expect(isWeeklyWindow({ windowId: '5h', windowLabel: '5 giờ', windowSeconds: 18000 })).toBe(false)
    })
  })

  describe('isWindow100Percent', () => {
    it('returns true when remainingPercent is 100 or usedPercent is 0', () => {
      expect(
        isWindow100Percent({
          windowId: 'weekly',
          windowLabel: '7 ngày',
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: null,
          resetsInLabel: '',
          resetAtLabel: ''
        })
      ).toBe(true)
    })

    it('returns false when disabled', () => {
      expect(
        isWindow100Percent({
          windowId: 'weekly',
          windowLabel: '7 ngày',
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: null,
          resetsInLabel: '',
          resetAtLabel: '',
          disabled: true
        })
      ).toBe(false)
    })

    it('returns false when usedPercent > 0 and remainingPercent < 100', () => {
      expect(
        isWindow100Percent({
          windowId: 'weekly',
          windowLabel: '7 ngày',
          usedPercent: 10,
          remainingPercent: 90,
          resetsAt: 12345,
          resetsInLabel: '',
          resetAtLabel: ''
        })
      ).toBe(false)
    })
  })

  describe('getWeeklyResetTimestamp', () => {
    it('returns the weekly window reset timestamp and ignores 5h window', () => {
      const quota = makeQuota([
        {
          modelId: 'group-gemini',
          label: 'Gemini Models',
          windows: [
            { windowId: '5h', windowLabel: '5 giờ', usedPercent: 50, remainingPercent: 50, resetsAt: 1000 },
            { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 10, remainingPercent: 90, resetsAt: 5000 }
          ]
        }
      ])

      expect(getWeeklyResetTimestamp(quota, 'gemini')).toBe(5000)
      expect(getWeeklyResetTimestamp(quota, 'claude')).toBeNull()
    })

    it('returns null when weekly window has no resetsAt', () => {
      const quota = makeQuota([
        {
          modelId: 'group-gemini',
          label: 'Gemini Models',
          windows: [
            { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 0, remainingPercent: 100, resetsAt: null }
          ]
        }
      ])

      expect(getWeeklyResetTimestamp(quota, 'gemini')).toBeNull()
    })
  })

  describe('hasWeeklyQuota100Percent', () => {
    it('returns true when weekly window has remainingPercent >= 100 or usedPercent == 0', () => {
      const quota = makeQuota([
        {
          modelId: 'group-gemini',
          label: 'Gemini Models',
          windows: [
            { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 0, remainingPercent: 100, resetsAt: 1000 }
          ]
        }
      ])
      expect(hasWeeklyQuota100Percent(quota, 'gemini')).toBe(true)
      expect(hasWeeklyQuota100Percent(quota, 'claude')).toBe(false)
    })

    it('returns false when weekly window has usedPercent > 0 or remainingPercent < 100', () => {
      const quota = makeQuota([
        {
          modelId: 'group-gemini',
          label: 'Gemini Models',
          windows: [
            { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 10, remainingPercent: 90, resetsAt: 1000 }
          ]
        }
      ])
      expect(hasWeeklyQuota100Percent(quota, 'gemini')).toBe(false)
    })
  })

  describe('isWeeklyQuotaDueForReset and getFamiliesDueForWeeklyReset', () => {
    it('returns true when resetsAt is reached AND weekly quota is 100%', () => {
      const quota = makeQuota([
        {
          modelId: 'group-gemini',
          label: 'Gemini Models',
          windows: [
            { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 0, remainingPercent: 100, resetsAt: 1000 }
          ]
        }
      ])

      // At or after resetsAt with 100% quota
      expect(isWeeklyQuotaDueForReset(quota, 'gemini', 1000)).toBe(true)
      expect(isWeeklyQuotaDueForReset(quota, 'gemini', 1050)).toBe(true)
      expect(getFamiliesDueForWeeklyReset(quota, 1050)).toEqual(['gemini'])
    })

    it('returns false when resetsAt is reached but weekly quota is NOT 100% yet', () => {
      const quota = makeQuota([
        {
          modelId: 'group-gemini',
          label: 'Gemini Models',
          windows: [
            { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 80, remainingPercent: 20, resetsAt: 1000 }
          ]
        }
      ])

      // At or after resetsAt but quota is still 20% remaining / 80% used -> DO NOT TRIGGER
      expect(isWeeklyQuotaDueForReset(quota, 'gemini', 1000)).toBe(false)
      expect(isWeeklyQuotaDueForReset(quota, 'gemini', 1050)).toBe(false)
      expect(getFamiliesDueForWeeklyReset(quota, 1050)).toEqual([])
    })

    it('returns true when weekly quota is 100% even if resetsAt is in the future (cycle needs trigger to decrease to 99%)', () => {
      const quota = makeQuota([
        {
          modelId: 'group-gemini',
          label: 'Gemini Models',
          windows: [
            // Quota tuần đang 100%, có mốc resetsAt từ Google nhưng chưa tiêu hao token nào trong chu kỳ này
            { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 0, remainingPercent: 100, resetsAt: 5000 }
          ]
        }
      ])

      // Vẫn đủ điều kiện gửi chat để bắt đầu tiêu thụ token (đưa về 99%) và hiển thị đếm ngược
      expect(isWeeklyQuotaDueForReset(quota, 'gemini', 4000)).toBe(true)
      expect(getFamiliesDueForWeeklyReset(quota, 4000)).toEqual(['gemini'])
    })

    it('returns true when resetsAt is null and quota is 100% (unstarted cycle)', () => {
      const quota = makeQuota([
        {
          modelId: 'group-gemini',
          label: 'Gemini Models',
          windows: [
            { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 0, remainingPercent: 100, resetsAt: null }
          ]
        },
        {
          modelId: 'group-claude',
          label: 'Claude and GPT models',
          windows: [
            { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 20, remainingPercent: 80, resetsAt: null }
          ]
        }
      ])

      expect(isWeeklyQuotaDueForReset(quota, 'gemini')).toBe(true)
      expect(isWeeklyQuotaDueForReset(quota, 'claude')).toBe(false)
      expect(getFamiliesDueForWeeklyReset(quota)).toEqual(['gemini'])
    })

    it('supports backward-compatibility alias isWeeklyQuota100Percent and getFamiliesWith100PercentWeeklyQuota', () => {
      const quota = makeQuota([
        {
          modelId: 'group-gemini',
          label: 'Gemini Models',
          windows: [
            { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 0, remainingPercent: 100 }
          ]
        },
        {
          modelId: 'group-claude',
          label: 'Claude and GPT models',
          windows: [
            { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 0, remainingPercent: 100 }
          ]
        }
      ])

      expect(isWeeklyQuota100Percent(quota, 'gemini')).toBe(true)
      expect(isWeeklyQuota100Percent(quota, 'claude')).toBe(true)
      expect(getFamiliesWith100PercentWeeklyQuota(quota)).toEqual(['gemini', 'claude'])
    })

    it('returns false when 5h short-term window is exhausted, even if resetsAt is due and weekly quota is 100%', () => {
      const quota = makeQuota([
        {
          modelId: 'group-gemini',
          label: 'Gemini Models',
          windows: [
            { windowId: '5h', windowLabel: '5 giờ', usedPercent: 100, remainingPercent: 0, resetsAt: 1200 },
            { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 0, remainingPercent: 100, resetsAt: 1000 }
          ]
        }
      ])

      // now = 1050 (resetsAt 1000 is due and weekly is 100%, but 5h window is 0% remaining)
      expect(isWeeklyQuotaDueForReset(quota, 'gemini', 1050)).toBe(false)
      expect(getFamiliesDueForWeeklyReset(quota, 1050)).toEqual([])

      // When checkShortTerm is disabled explicitly, it evaluates only weekly
      expect(isWeeklyQuotaDueForReset(quota, 'gemini', 1050, { checkShortTerm: false })).toBe(true)
    })
  })

  describe('isFamilyShortTermExhausted', () => {
    it('returns true when all non-weekly windows are exhausted', () => {
      const quota = makeQuota([
        {
          modelId: 'group-gemini',
          label: 'Gemini Models',
          windows: [
            { windowId: '5h', windowLabel: '5 giờ', usedPercent: 100, remainingPercent: 0, resetsAt: 1200 },
            { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 10, remainingPercent: 90, resetsAt: 5000 }
          ]
        }
      ])
      expect(isFamilyShortTermExhausted(quota, 'gemini')).toBe(true)
      expect(isFamilyShortTermExhausted(quota, 'claude')).toBe(false)
    })

    it('returns false when short-term window still has remaining percentage', () => {
      const quota = makeQuota([
        {
          modelId: 'group-gemini',
          label: 'Gemini Models',
          windows: [
            { windowId: '5h', windowLabel: '5 giờ', usedPercent: 60, remainingPercent: 40, resetsAt: 1200 },
            { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 10, remainingPercent: 90, resetsAt: 5000 }
          ]
        }
      ])
      expect(isFamilyShortTermExhausted(quota, 'gemini')).toBe(false)
    })

    it('returns false when model has no short-term windows', () => {
      const quota = makeQuota([
        {
          modelId: 'group-gemini',
          label: 'Gemini Models',
          windows: [
            { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 10, remainingPercent: 90, resetsAt: 5000 }
          ]
        }
      ])
      expect(isFamilyShortTermExhausted(quota, 'gemini')).toBe(false)
    })

    it('returns false when short-term window is disabled', () => {
      const quota = makeQuota([
        {
          modelId: 'group-gemini',
          label: 'Gemini Models',
          windows: [
            { windowId: '5h', windowLabel: '5 giờ', usedPercent: 100, remainingPercent: 0, resetsAt: 1200, disabled: true },
            { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 0, remainingPercent: 100, resetsAt: 5000 }
          ]
        }
      ])
      expect(isFamilyShortTermExhausted(quota, 'gemini')).toBe(false)
    })
  })

  describe('getNextWeeklyResetTimestamp and calculateNextResetDelayMs', () => {
    it('finds the earliest future reset timestamp across all accounts', () => {
      const acc1 = makeAccount('acc-1', 'Account 1')
      const acc2 = makeAccount('acc-2', 'Account 2')

      const quota1 = makeQuota([
        {
          modelId: 'group-gemini',
          label: 'Gemini Models',
          windows: [
            { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 10, remainingPercent: 90, resetsAt: 3000 }
          ]
        }
      ])

      const quota2 = makeQuota([
        {
          modelId: 'group-claude',
          label: 'Claude and GPT models',
          windows: [
            { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 20, remainingPercent: 80, resetsAt: 2000 }
          ]
        }
      ])

      const nowSeconds = 1000
      const nextReset = getNextWeeklyResetTimestamp([acc1, acc2], { 'acc-1': quota1, 'acc-2': quota2 }, nowSeconds)
      expect(nextReset).toBe(2000)

      // calculateNextResetDelayMs should calculate delay with buffer (default 5s)
      const delayMs = calculateNextResetDelayMs([acc1, acc2], { 'acc-1': quota1, 'acc-2': quota2 }, {
        nowSeconds: 1000,
        bufferSeconds: 5,
        maxIntervalMs: 15 * 60 * 1000
      })
      // (2000 - 1000 + 5) * 1000 = 1005000 ms (~16.7 mins) -> capped by 15 * 60 * 1000 = 900000 ms
      expect(delayMs).toBe(15 * 60 * 1000)

      // If next reset is 30s away
      const shortDelayMs = calculateNextResetDelayMs([acc1, acc2], { 'acc-1': quota1, 'acc-2': quota2 }, {
        nowSeconds: 1970, // 30s until 2000
        bufferSeconds: 5,
        maxIntervalMs: 15 * 60 * 1000
      })
      // (2000 - 1970 + 5) * 1000 = 35000 ms
      expect(shortDelayMs).toBe(35000)
    })

    it('returns pendingResetIntervalMs when an account has passed resetsAt but quota is not 100% yet', () => {
      const acc = makeAccount('acc-1', 'Account 1')
      const quota = makeQuota([
        {
          modelId: 'group-gemini',
          label: 'Gemini Models',
          windows: [
            // resetsAt was 1000, now is 1050, but quota is only 20% remaining
            { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 80, remainingPercent: 20, resetsAt: 1000 }
          ]
        }
      ])

      expect(hasAccountsPendingWeeklyReset([acc], { 'acc-1': quota }, 1050)).toBe(true)

      const delayMs = calculateNextResetDelayMs([acc], { 'acc-1': quota }, {
        nowSeconds: 1050,
        pendingResetIntervalMs: 30000
      })
      expect(delayMs).toBe(30000)
    })

    it('returns default maxIntervalMs when no future reset timestamps exist', () => {
      const acc1 = makeAccount('acc-1', 'Account 1')
      const delayMs = calculateNextResetDelayMs([acc1], {}, {
        maxIntervalMs: 60000
      })
      expect(delayMs).toBe(60000)
    })
  })

  describe('executeAutoTestChatForAccounts', () => {
    it('triggers test chat based on weekly reset time arriving (now >= resetsAt) AND quota is 100%', async () => {
      const acc1 = makeAccount('acc-1', 'Account 1')
      const acc2 = makeAccount('acc-2', 'Account 2')

      // acc1: reset time has passed (1000 <= nowMs 1500) AND quota is 100%
      const quota1 = makeQuota([
        {
          modelId: 'group-gemini',
          label: 'Gemini Models',
          windows: [
            { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 0, remainingPercent: 100, resetsAt: 1000 }
          ]
        }
      ])

      // acc2: reset time is in the future (5000 > nowMs 1500) và quota chưa hồi phục 100% (used: 20%, rem: 80%)
      const quota2 = makeQuota([
        {
          modelId: 'group-gemini',
          label: 'Gemini Models',
          windows: [
            { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 20, remainingPercent: 80, resetsAt: 5000 }
          ]
        }
      ])

      const testChatFn = vi.fn().mockResolvedValue({ success: true, message: '200 OK' })
      const onAccountTriggered = vi.fn()
      const lastTriggeredMap = new Map<string, number>()
      const inFlightSet = new Set<string>()

      const res = await executeAutoTestChatForAccounts({
        accounts: [acc1, acc2],
        quotas: {
          'acc-1': quota1,
          'acc-2': quota2
        },
        testChatFn,
        onAccountTriggered,
        lastTriggeredMap,
        inFlightSet,
        cooldownMs: 60000,
        nowMs: 1500 * 1000 // 1500 seconds
      })

      // Only acc1 should trigger; acc2 is not due yet
      expect(res.triggeredCount).toBe(1)
      expect(testChatFn).toHaveBeenCalledTimes(1)
      expect(testChatFn).toHaveBeenCalledWith('acc-1', 'gemini')
      expect(onAccountTriggered).toHaveBeenCalledWith({
        accountId: 'acc-1',
        accountName: 'Account 1',
        family: 'gemini',
        success: true,
        message: '200 OK'
      })
      expect(lastTriggeredMap.get('acc-1:gemini')).toBe(1500000)
    })

    it('does NOT trigger test chat when reset time has passed (now >= resetsAt) but quota is NOT 100% yet', async () => {
      const acc = makeAccount('acc-1', 'Account 1')
      const quota = makeQuota([
        {
          modelId: 'group-gemini',
          label: 'Gemini Models',
          windows: [
            { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 70, remainingPercent: 30, resetsAt: 1000 }
          ]
        }
      ])

      const testChatFn = vi.fn().mockResolvedValue({ success: true, message: '200 OK' })

      const res = await executeAutoTestChatForAccounts({
        accounts: [acc],
        quotas: { 'acc-1': quota },
        testChatFn,
        nowMs: 1500 * 1000
      })

      expect(res.triggeredCount).toBe(0)
      expect(testChatFn).not.toHaveBeenCalled()
    })

    it('prevents duplicate spam within cooldownMs', async () => {
      const acc = makeAccount('acc-1', 'Account 1')
      const quota = makeQuota([
        {
          modelId: 'group-gemini',
          label: 'Gemini Models',
          windows: [
            { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 0, remainingPercent: 100, resetsAt: null }
          ]
        }
      ])

      const testChatFn = vi.fn().mockResolvedValue({ success: true, message: '200 OK' })
      const lastTriggeredMap = new Map<string, number>()

      // First run: triggers and records into lastTriggeredMap
      const res1 = await executeAutoTestChatForAccounts({
        accounts: [acc],
        quotas: { 'acc-1': quota },
        testChatFn,
        lastTriggeredMap,
        cooldownMs: 60000,
        nowMs: 100000
      })

      expect(res1.triggeredCount).toBe(1)
      expect(testChatFn).toHaveBeenCalledTimes(1)
      expect(lastTriggeredMap.get('acc-1:gemini')).toBe(100000)

      // Second run within cooldown: do NOT trigger again
      const res2 = await executeAutoTestChatForAccounts({
        accounts: [acc],
        quotas: { 'acc-1': quota },
        testChatFn,
        lastTriggeredMap,
        cooldownMs: 60000,
        nowMs: 120000 // Only 20s passed, < cooldownMs 60s
      })

      expect(res2.triggeredCount).toBe(0)
      expect(testChatFn).toHaveBeenCalledTimes(1) // Still 1!
    })

    it('uses shorter errorCooldownMs on failure instead of full cooldown', async () => {
      const acc = makeAccount('acc-1', 'Account 1')
      const quota = makeQuota([
        {
          modelId: 'group-gemini',
          label: 'Gemini Models',
          windows: [
            { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 0, remainingPercent: 100, resetsAt: 1000 }
          ]
        }
      ])

      const testChatFn = vi.fn().mockResolvedValue({ success: false, message: '500 Server Error' })
      const lastTriggeredMap = new Map<string, number>()
      const consecutiveErrorMap = new Map<string, number>()

      const cooldownMs = 30 * 60 * 1000 // 30 min
      const errorCooldownMs = 2 * 60 * 1000 // 2 min
      const nowMs = 1500 * 1000 // 1,500,000 ms

      await executeAutoTestChatForAccounts({
        accounts: [acc],
        quotas: { 'acc-1': quota },
        testChatFn,
        lastTriggeredMap,
        consecutiveErrorMap,
        cooldownMs,
        errorCooldownMs,
        nowMs
      })

      expect(consecutiveErrorMap.get('acc-1:gemini')).toBe(1)
      // Check lastTriggeredMap value: should expire in exactly errorCooldownMs
      const recorded = lastTriggeredMap.get('acc-1:gemini')!
      // In 1 minute (60s), still within errorCooldownMs (2 min) -> blocked
      expect(nowMs + 60000 - recorded < cooldownMs).toBe(true)
      // In 2.1 minutes (126s) -> allowed!
      expect(nowMs + 126000 - recorded < cooldownMs).toBe(false)
    })
  })

  describe('AutoTestChatJob (Repeating Job)', () => {
    it('executes recurring checks and sends chat when resetsAt is reached AND quota is 100%', async () => {
      vi.useFakeTimers()
      try {
        const acc = makeAccount('acc-1', 'Account 1')
        const quotaReady = makeQuota([
          {
            modelId: 'group-gemini',
            label: 'Gemini Models',
            windows: [
              { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 0, remainingPercent: 100, resetsAt: 1000 }
            ]
          }
        ])

        const testChatFn = vi.fn().mockResolvedValue({ success: true, message: '200 OK' })
        const onResults = vi.fn()
        const onSuccess = vi.fn()

        const job = new AutoTestChatJob({
          getAccounts: () => [acc],
          getQuotas: () => ({ 'acc-1': quotaReady }),
          fetchQuotas: vi.fn().mockResolvedValue({ 'acc-1': quotaReady }),
          testChatFn,
          onResults,
          onSuccess,
          pendingResetIntervalMs: 10000,
          maxIntervalMs: 60000
        })

        expect(job.active).toBe(false)
        job.start()
        expect(job.active).toBe(true)

        // Allow microtasks to complete first run
        await vi.advanceTimersByTimeAsync(10)

        expect(testChatFn).toHaveBeenCalledTimes(1)
        expect(testChatFn).toHaveBeenCalledWith('acc-1', 'gemini')
        expect(onSuccess).toHaveBeenCalledWith('acc-1', 'gemini')
        expect(onResults).toHaveBeenCalled()

        job.stop()
        expect(job.active).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not send chat when resetsAt is reached but quota is still not 100%, and retries via pendingResetIntervalMs', async () => {
      vi.useFakeTimers()
      try {
        const acc = makeAccount('acc-1', 'Account 1')
        const quotaNotReady = makeQuota([
          {
            modelId: 'group-gemini',
            label: 'Gemini Models',
            windows: [
              { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 40, remainingPercent: 60, resetsAt: 1000 }
            ]
          }
        ])

        const quotaBecameReady = makeQuota([
          {
            modelId: 'group-gemini',
            label: 'Gemini Models',
            windows: [
              { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 0, remainingPercent: 100, resetsAt: 1000 }
            ]
          }
        ])

        const testChatFn = vi.fn().mockResolvedValue({ success: true, message: '200 OK' })
        let currentQuota = quotaNotReady
        const fetchQuotas = vi.fn().mockImplementation(async () => ({ 'acc-1': currentQuota }))

        const job = new AutoTestChatJob({
          getAccounts: () => [acc],
          getQuotas: () => ({ 'acc-1': currentQuota }),
          fetchQuotas,
          testChatFn,
          pendingResetIntervalMs: 20000
        })

        job.start()
        await vi.advanceTimersByTimeAsync(10)

        // First check: quota was not 100% -> testChatFn not called
        expect(testChatFn).not.toHaveBeenCalled()

        // Server updates quota to 100%
        currentQuota = quotaBecameReady

        // Advance timer by pendingResetIntervalMs (20s)
        await vi.advanceTimersByTimeAsync(20000)

        // Second check: quota is now 100% -> testChatFn called!
        expect(testChatFn).toHaveBeenCalledTimes(1)

        job.stop()
      } finally {
        vi.useRealTimers()
      }
    })

    it('recovers gracefully from fetchQuotas network error and retries without stopping', async () => {
      vi.useFakeTimers()
      try {
        const acc = makeAccount('acc-1', 'Account 1')
        const quotaReady = makeQuota([
          {
            modelId: 'group-gemini',
            label: 'Gemini Models',
            windows: [
              { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 0, remainingPercent: 100, resetsAt: 1000 }
            ]
          }
        ])

        const testChatFn = vi.fn().mockResolvedValue({ success: true, message: '200 OK' })
        let shouldFail = true
        const fetchQuotas = vi.fn().mockImplementation(async () => {
          if (shouldFail) {
            throw new Error('Network timeout')
          }
          return { 'acc-1': quotaReady }
        })

        const job = new AutoTestChatJob({
          getAccounts: () => [acc],
          getQuotas: () => ({}),
          fetchQuotas,
          testChatFn,
          errorRetryDelayMs: 15000
        })

        job.start()
        await vi.advanceTimersByTimeAsync(10)

        // Failed due to error
        expect(testChatFn).not.toHaveBeenCalled()
        expect(job.active).toBe(true) // Job is still running!

        // Network recovers
        shouldFail = false

        // Advance timer by errorRetryDelayMs (15s)
        await vi.advanceTimersByTimeAsync(15000)

        // Retried and succeeded!
        expect(testChatFn).toHaveBeenCalledTimes(1)

        job.stop()
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
