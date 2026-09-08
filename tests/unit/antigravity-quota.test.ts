import { describe, expect, it } from 'vitest'
import {
  collectDisplayModelIds,
  humanizeModelId,
  normalizeRemainingFraction,
  parseAntigravityModelQuotas,
  buildModelQuota
} from '../../electron/main/antigravity-quota'

const future = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString()

describe('normalizeRemainingFraction', () => {
  it('undefined/NaN/không hợp lệ → 0 (semantics: cạn)', () => {
    expect(normalizeRemainingFraction(undefined)).toBe(0)
    expect(normalizeRemainingFraction(NaN)).toBe(0)
    expect(normalizeRemainingFraction('0.5')).toBe(0)
  })

  it('clamp ngoài [0,1]', () => {
    expect(normalizeRemainingFraction(1.5)).toBe(1)
    expect(normalizeRemainingFraction(-0.2)).toBe(0)
  })

  it('giữ nguyên giá trị hợp lệ', () => {
    expect(normalizeRemainingFraction(0.42)).toBe(0.42)
  })
})

describe('humanizeModelId', () => {
  it('tiered model', () => {
    expect(humanizeModelId('gemini-3.8-flash-tiered')).toBe('Gemini 3.8 Flash')
  })
  it('gộp số liền kề thành version', () => {
    expect(humanizeModelId('claude-opus-4-6-thinking')).toBe('Claude Opus 4.6 Thinking')
  })
  it('model thường', () => {
    expect(humanizeModelId('gemini-3-pro')).toBe('Gemini 3 Pro')
  })
})

const modelsResponse = {
  models: {
    'claude-opus-4-6-thinking': { displayName: 'Claude Opus 4.6 Thinking', quotaInfo: { remainingFraction: 1 } },
    'gemini-3-pro': { displayName: 'Gemini 3 Pro', quotaInfo: { remainingFraction: 1 } },
    'gemini-3.8-flash-tiered': { quotaInfo: { remainingFraction: 0.5, resetTime: future(3) } },
    'claude-sonnet-4-5': { displayName: 'Claude Sonnet 4.5', quotaInfo: {} },
    'internal-model-x': {}
  },
  agentModelSorts: [
    {
      displayName: 'Agent',
      groups: [{ modelIds: ['claude-opus-4-6-thinking', 'gemini-3-pro', 'claude-sonnet-4-5', 'internal-model-x'] }]
    }
  ],
  commandModelIds: ['gemini-3.8-flash-tiered'],
  imageGenerationModelIds: [],
  tieredModelIds: { flash: ['gemini-3.8-flash-tiered'] }
}

const summary = {
  groups: [
    {
      displayName: 'Claude and GPT models',
      buckets: [
        { bucketId: 'b1', window: '5h', remainingFraction: 0.8, resetTime: future(2) },
        { bucketId: 'b2', window: 'weekly', remainingFraction: 0.3, resetTime: future(100) }
      ]
    },
    {
      displayName: 'Gemini Models',
      buckets: [
        { bucketId: 'b3', window: 'weekly', remainingFraction: 0.9, resetTime: future(50) },
        { bucketId: 'b4', window: '5h', disabled: true }
      ]
    }
  ]
}

describe('collectDisplayModelIds', () => {
  it('gộp agent+command+tiered, dedupe, lọc model không quotaInfo', () => {
    expect(collectDisplayModelIds(modelsResponse)).toEqual([
      'claude-opus-4-6-thinking',
      'gemini-3-pro',
      'claude-sonnet-4-5',
      'gemini-3.8-flash-tiered'
    ])
  })

  it('fallback dedupe theo label, giữ model cạn nhất', () => {
    const fallback = {
      models: {
        'm-a': { displayName: 'Same Label', quotaInfo: { remainingFraction: 0.9 } },
        'm-b': { displayName: 'Same Label', quotaInfo: { remainingFraction: 0.2 } },
        'm-c': { displayName: 'Other', quotaInfo: { remainingFraction: 1 } }
      }
    }
    expect(collectDisplayModelIds(fallback).sort()).toEqual(['m-b', 'm-c'])
  })
})

describe('parseAntigravityModelQuotas', () => {
  const models = parseAntigravityModelQuotas(modelsResponse, summary)
  const byId = Object.fromEntries(models.map((m) => [m.modelId, m]))

  it('opus: placeholder own=1 nhưng group weekly 0.3 → binding 70% used', () => {
    expect(byId['claude-opus-4-6-thinking'].usedPercent).toBe(70)
    expect(byId['claude-opus-4-6-thinking'].windowLabel).toBe('7 ngày')
  })

  it('windows đầy đủ 2 bucket (5h=20%, weekly=70%)', () => {
    const windows = Object.fromEntries(
      byId['claude-opus-4-6-thinking'].windows!.map((w) => [w.windowId, w])
    )
    expect(windows['5h'].usedPercent).toBe(20)
    expect(windows.weekly.usedPercent).toBe(70)
    expect(windows['5h'].disabled).toBeFalsy()
  })

  it('gemini-pro: bucket disabled vẫn hiển thị với flag', () => {
    const windows = Object.fromEntries(byId['gemini-3-pro'].windows!.map((w) => [w.windowId, w]))
    expect(windows['5h'].disabled).toBe(true)
  })

  it('model thiếu remainingFraction = cạn (100%)', () => {
    expect(byId['claude-sonnet-4-5'].usedPercent).toBe(100)
  })

  it('tiered: own 0.5 < nhóm 0.9 → binding của riêng model', () => {
    expect(byId['gemini-3.8-flash-tiered'].usedPercent).toBe(50)
    expect(byId['gemini-3.8-flash-tiered'].windowLabel).toBeUndefined()
  })

  it('thứ tự: Opus mới nhất #1, Gemini mới nhất #2, còn lại theo % dùng', () => {
    expect(models.map((m) => m.modelId)).toEqual([
      'claude-opus-4-6-thinking',
      'gemini-3.8-flash-tiered',
      'claude-sonnet-4-5',
      'gemini-3-pro'
    ])
  })
})

describe('buildModelQuota (không summary)', () => {
  it('chỉ dùng quota riêng của model', () => {
    const m = buildModelQuota('gemini-3-pro', 'Gemini 3 Pro', {
      remainingFraction: 0.25,
      resetTime: future(5)
    })
    expect(m.usedPercent).toBe(75)
    expect(m.windows).toBeUndefined()
  })

  it('thiếu remainingFraction → 100% used', () => {
    expect(buildModelQuota('x', 'X', {}).usedPercent).toBe(100)
  })
})
