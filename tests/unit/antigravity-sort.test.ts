import { describe, expect, it } from 'vitest'
import { getAccountResetTimestamp, sortAntigravityAccounts } from '../../src/antigravity-sort'
import type { Account, AccountQuota } from '../../src/types'

function makeAccount(id: string, name: string): Account {
  return {
    id,
    name,
    provider: 'antigravity',
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

describe('antigravity-sort', () => {
  const acct1 = makeAccount('acc-1', 'Account 1')
  const acct2 = makeAccount('acc-2', 'Account 2')
  const acct3 = makeAccount('acc-3', 'Account 3')
  const acctNoQuota = makeAccount('acc-none', 'Account No Quota')

  const quota1 = makeQuota([
    {
      modelId: 'group-gemini',
      label: 'Gemini Models',
      windows: [
        { windowId: '5h', usedPercent: 10, resetsAt: 1000 },
        { windowId: 'weekly', usedPercent: 20, resetsAt: 5000 }
      ]
    },
    {
      modelId: 'group-claude',
      label: 'Claude and GPT models',
      windows: [
        { windowId: '5h', usedPercent: 10, resetsAt: 8000 },
        { windowId: 'weekly', usedPercent: 20, resetsAt: 20000 }
      ]
    }
  ])

  const quota2 = makeQuota([
    {
      modelId: 'group-gemini',
      label: 'Gemini Models',
      windows: [
        { windowId: '5h', usedPercent: 10, resetsAt: 3000 },
        { windowId: 'weekly', usedPercent: 20, resetsAt: 7000 }
      ]
    },
    {
      modelId: 'group-claude',
      label: 'Claude and GPT models',
      windows: [
        { windowId: '5h', usedPercent: 10, resetsAt: 2000 },
        { windowId: 'weekly', usedPercent: 20, resetsAt: 15000 }
      ]
    }
  ])

  const quota3 = makeQuota([
    {
      modelId: 'group-gemini',
      label: 'Gemini Models',
      windows: [
        { windowId: '5h', usedPercent: 10, resetsAt: 2000 },
        { windowId: 'weekly', usedPercent: 20, resetsAt: 6000 }
      ]
    },
    {
      modelId: 'group-claude',
      label: 'Claude and GPT models',
      windows: [
        { windowId: '5h', usedPercent: 10, resetsAt: 5000 },
        { windowId: 'weekly', usedPercent: 20, resetsAt: 10000 }
      ]
    }
  ])

  const quotas: Record<string, AccountQuota> = {
    'acc-1': quota1,
    'acc-2': quota2,
    'acc-3': quota3
  }

  const allAccounts = [acct1, acct2, acct3, acctNoQuota]

  it('default: giữ nguyên thứ tự', () => {
    const sorted = sortAntigravityAccounts(allAccounts, quotas, 'default')
    expect(sorted.map((a) => a.id)).toEqual(['acc-1', 'acc-2', 'acc-3', 'acc-none'])
  })

  it('gemini-asc: tăng dần theo reset Gemini tuần, tài khoản không có quota ở cuối', () => {
    // Gemini weekly resets: acc-1: 5000, acc-2: 7000, acc-3: 6000
    // Asc: acc-1 (5000) -> acc-3 (6000) -> acc-2 (7000) -> acc-none
    const sorted = sortAntigravityAccounts(allAccounts, quotas, 'gemini-asc')
    expect(sorted.map((a) => a.id)).toEqual(['acc-1', 'acc-3', 'acc-2', 'acc-none'])
  })

  it('gemini-desc: giảm dần theo reset Gemini tuần, tài khoản không có quota ở cuối', () => {
    // Desc: acc-2 (7000) -> acc-3 (6000) -> acc-1 (5000) -> acc-none
    const sorted = sortAntigravityAccounts(allAccounts, quotas, 'gemini-desc')
    expect(sorted.map((a) => a.id)).toEqual(['acc-2', 'acc-3', 'acc-1', 'acc-none'])
  })

  it('claude-asc: tăng dần theo reset Claude and GPT tuần, tài khoản không có quota ở cuối', () => {
    // Claude weekly resets: acc-1: 20000, acc-2: 15000, acc-3: 10000
    // Asc: acc-3 (10000) -> acc-2 (15000) -> acc-1 (20000) -> acc-none
    const sorted = sortAntigravityAccounts(allAccounts, quotas, 'claude-asc')
    expect(sorted.map((a) => a.id)).toEqual(['acc-3', 'acc-2', 'acc-1', 'acc-none'])
  })

  it('claude-desc: giảm dần theo reset Claude and GPT tuần, tài khoản không có quota ở cuối', () => {
    // Desc: acc-1 (20000) -> acc-2 (15000) -> acc-3 (10000) -> acc-none
    const sorted = sortAntigravityAccounts(allAccounts, quotas, 'claude-desc')
    expect(sorted.map((a) => a.id)).toEqual(['acc-1', 'acc-2', 'acc-3', 'acc-none'])
  })

  it('khi có cửa sổ cạn (100% đã dùng) → lấy thời điểm mở lại của cửa sổ cạn', () => {
    // weekly là 100% dùng (reset lúc 5000), 5h là 20% dùng (reset lúc 1000)
    const qExhausted = makeQuota([
      {
        modelId: 'group-gemini',
        label: 'Gemini Models',
        windows: [
          { windowId: 'weekly', usedPercent: 100, resetsAt: 5000 },
          { windowId: '5h', usedPercent: 20, resetsAt: 1000 }
        ]
      }
    ])
    expect(getAccountResetTimestamp(qExhausted, 'gemini')).toBe(5000)
  })

  it('bỏ qua cửa sổ disabled', () => {
    const qDisabled = makeQuota([
      {
        modelId: 'group-gemini',
        label: 'Gemini Models',
        windows: [
          { windowId: '5h', disabled: true, usedPercent: 0, resetsAt: 500 },
          { windowId: 'weekly', disabled: false, usedPercent: 20, resetsAt: 3500 }
        ]
      }
    ])
    expect(getAccountResetTimestamp(qDisabled, 'gemini')).toBe(3500)
  })

  it('hỗ trợ layout models (fallback đơn lẻ)', () => {
    const qModels = makeQuota([
      {
        modelId: 'gemini-3.8-flash-tiered',
        label: 'Gemini 3.8 Flash',
        usedPercent: 20,
        resetsAt: 2500
      },
      {
        modelId: 'claude-opus-4-6-thinking',
        label: 'Claude Opus 4.6 Thinking',
        usedPercent: 30,
        resetsAt: 1500
      }
    ])
    expect(getAccountResetTimestamp(qModels, 'gemini')).toBe(2500)
    expect(getAccountResetTimestamp(qModels, 'claude')).toBe(1500)
  })
})
