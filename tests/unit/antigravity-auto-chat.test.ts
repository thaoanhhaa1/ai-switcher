import { describe, expect, it, vi } from 'vitest'
import {
  calculateNextResetDelayMs,
  executeAutoTestChatForAccounts,
  getFamiliesDueForWeeklyReset,
  getFamiliesWith100PercentWeeklyQuota,
  getNextWeeklyResetTimestamp,
  getWeeklyResetTimestamp,
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

  describe('isWeeklyQuotaDueForReset and getFamiliesDueForWeeklyReset', () => {
    it('returns true when resetsAt is reached or passed (nowSeconds >= resetsAt), even if usedPercent > 0', () => {
      const quota = makeQuota([
        {
          modelId: 'group-gemini',
          label: 'Gemini Models',
          windows: [
            { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 80, remainingPercent: 20, resetsAt: 1000 }
          ]
        }
      ])

      // At or after resetsAt
      expect(isWeeklyQuotaDueForReset(quota, 'gemini', 1000)).toBe(true)
      expect(isWeeklyQuotaDueForReset(quota, 'gemini', 1050)).toBe(true)
      expect(getFamiliesDueForWeeklyReset(quota, 1050)).toEqual(['gemini'])
    })

    it('returns false when resetsAt is in the future (nowSeconds < resetsAt), even if remainingPercent is 100%', () => {
      const quota = makeQuota([
        {
          modelId: 'group-gemini',
          label: 'Gemini Models',
          windows: [
            // Quota vừa được kích hoạt, usedPercent = 0 / 100% còn lại, nhưng resetsAt tận 7 ngày sau
            { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 0, remainingPercent: 100, resetsAt: 5000 }
          ]
        }
      ])

      // Trước resetsAt
      expect(isWeeklyQuotaDueForReset(quota, 'gemini', 4000)).toBe(false)
      expect(getFamiliesDueForWeeklyReset(quota, 4000)).toEqual([])
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

    it('returns default maxIntervalMs when no future reset timestamps exist', () => {
      const acc1 = makeAccount('acc-1', 'Account 1')
      const delayMs = calculateNextResetDelayMs([acc1], {}, {
        maxIntervalMs: 60000
      })
      expect(delayMs).toBe(60000)
    })
  })

  describe('executeAutoTestChatForAccounts', () => {
    it('triggers test chat based on weekly reset time arriving (now >= resetsAt)', async () => {
      const acc1 = makeAccount('acc-1', 'Account 1')
      const acc2 = makeAccount('acc-2', 'Account 2')

      // acc1: reset time has passed (1000 <= nowMs 1500)
      const quota1 = makeQuota([
        {
          modelId: 'group-gemini',
          label: 'Gemini Models',
          windows: [
            { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 50, remainingPercent: 50, resetsAt: 1000 }
          ]
        }
      ])

      // acc2: reset time is in the future (5000 > nowMs 1500)
      const quota2 = makeQuota([
        {
          modelId: 'group-gemini',
          label: 'Gemini Models',
          windows: [
            { windowId: 'weekly', windowLabel: '7 ngày', usedPercent: 0, remainingPercent: 100, resetsAt: 5000 }
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
  })
})
