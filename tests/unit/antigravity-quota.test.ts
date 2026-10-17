import { describe, expect, it } from 'vitest'
import {
  collectDisplayModelIds,
  humanizeModelId,
  normalizeRemainingFraction,
  parseAntigravityModelQuotas,
  parseAntigravityGroupQuotas,
  buildModelQuota,
  resolveBucketRemaining,
  type QuotaSummaryGroup
} from '../../electron/main/antigravity-quota'

const future = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString()
const past = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

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

describe('resolveBucketRemaining (fix M1 — quy tắc thận trọng theo resetTime)', () => {
  it('có số hợp lệ → chỉ clamp, kể cả 0 tường minh = cạn thật', () => {
    expect(resolveBucketRemaining(0.42, future(2))).toBe(0.42)
    expect(resolveBucketRemaining(0, undefined)).toBe(0)
    expect(resolveBucketRemaining(1.5, future(2))).toBe(1)
  })

  it('thiếu fraction + CÓ resetTime = ĐÃ CẠN (0)', () => {
    expect(resolveBucketRemaining(undefined, future(2))).toBe(0)
    expect(resolveBucketRemaining(NaN, future(2))).toBe(0)
  })

  it('thiếu fraction + KHÔNG resetTime = CHƯA DÙNG (1) — bucket mới không bị báo 100%', () => {
    expect(resolveBucketRemaining(undefined, undefined)).toBe(1)
    expect(resolveBucketRemaining(NaN, '')).toBe(1)
  })

  it('resetTime không parse được → coi như không có', () => {
    expect(resolveBucketRemaining(undefined, 'not-a-date')).toBe(1)
    expect(resolveBucketRemaining(undefined, future(1))).toBe(0)
  })

  it('L2: thiếu fraction + resetTime đã QUA SÂU (> grace 2 phút) → stale, coi như chưa dùng (1)', () => {
    expect(resolveBucketRemaining(undefined, past(3))).toBe(1)
    expect(resolveBucketRemaining(undefined, past(60))).toBe(1)
    expect(resolveBucketRemaining(NaN, past(24 * 7))).toBe(1)
  })

  it('L2: thiếu fraction + resetTime quá khứ RẤT GẦN (trong grace 2 phút) → vẫn báo cạn (0)', () => {
    // Race giữa lúc reset: vừa quá vài giây → chưa kịp refill, giữ semantics cạn.
    expect(resolveBucketRemaining(undefined, past(0.5))).toBe(0)
    expect(resolveBucketRemaining(undefined, past(1))).toBe(0)
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

describe('parseAntigravityGroupQuotas', () => {
  it('2 nhóm → 2 items, label = displayName, modelId ổn định theo label (không phải index)', () => {
    const groups = parseAntigravityGroupQuotas(summary)
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.label)).toEqual(['Gemini Models', 'Claude and GPT models'])
    // L3: modelId derive từ hash label → ổn định qua refresh dù thứ tự API đổi.
    const ids = groups.map((g) => g.modelId)
    expect(ids[0]).toMatch(/^group-\d+$/)
    expect(ids[1]).toMatch(/^group-\d+$/)
    expect(new Set(ids).size).toBe(2)
    // Deterministic: parse lại → cùng id.
    const again = parseAntigravityGroupQuotas(summary)
    expect(again.map((g) => g.modelId)).toEqual(ids)
  })

  it('modelId ổn định khi thứ tự groups API đổi (L3 — key React không remount)', () => {
    const original = parseAntigravityGroupQuotas(summary)
    const reversed = parseAntigravityGroupQuotas({ groups: [...summary.groups].reverse() })
    // Cùng label → cùng modelId, dù đứng ở vị trí khác.
    const labelToId = Object.fromEntries(reversed.map((g) => [g.label, g.modelId]))
    expect(labelToId['Gemini Models']).toBe(original.find((g) => g.label === 'Gemini Models')?.modelId)
    expect(labelToId['Claude and GPT models']).toBe(original.find((g) => g.label === 'Claude and GPT models')?.modelId)
  })

  it('N1: hash dương THẬT SỰ (positive modulo) — label có naive hash âm vẫn ra id dương', () => {
    // 'Claude and GPT models' có naive hash `((h<<5)-h+c) % 2**31` = -1125754326
    // (JS `%` giữ dấu dividend). Bản cũ chỉ dương nhờ Math.abs ở bước cuối —
    // abs-collision x vs −x vẫn tồn tại. Bản fix chuẩn modulo ((x % n) + n) % n
    // đưa hash về [0, 2**31): -1125754326 + 2**31 = 1021729322 ≠ 1125754326.
    const [, claude] = parseAntigravityGroupQuotas(summary)
    expect(claude.label).toBe('Claude and GPT models')
    expect(claude.modelId).toBe('group-1021729322')
    expect(claude.modelId).toMatch(/^group-\d+$/)
  })

  it('N2: window mang bucketId gốc — 2 bucket trùng windowId vẫn có định danh riêng cho React key', () => {
    const input = {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'dup1', window: '5h', remainingFraction: 0.5 },
            { bucketId: 'dup2', window: '5h', remainingFraction: 0.4 },
            // Bucket không có bucketId → windowId fallback = window, bucketId undefined
            { window: 'weekly', remainingFraction: 0.9 }
          ]
        }
      ]
    }
    const [group] = parseAntigravityGroupQuotas(input)
    const windows = group.windows!
    // windowId KHÔNG phân biệt được 2 bucket '5h' (bằng nhau), bucketId thì có.
    expect(windows.filter((w) => w.windowId === '5h')).toHaveLength(2)
    expect(new Set(windows.filter((w) => w.windowId === '5h').map((w) => w.bucketId))).toEqual(
      new Set(['dup1', 'dup2'])
    )
    const weekly = windows.find((w) => w.windowId === 'weekly')
    expect(weekly?.bucketId).toBeUndefined()
  })

  it('windows đúng thứ tự 5h → weekly (sort windowSeconds), usedPercent = (1 - remaining) * 100', () => {
    const [, claude] = parseAntigravityGroupQuotas(summary)
    expect(claude.windows?.map((w) => w.windowId)).toEqual(['5h', 'weekly'])
    expect(claude.windows?.map((w) => w.usedPercent)).toEqual([20, 70])
  })

  it('% tổng của thẻ nhóm = bucket cạn nhất (min remaining, bỏ bucket disabled)', () => {
    const groups = parseAntigravityGroupQuotas(summary)
    // Gemini: chỉ weekly 0.9 (5h disabled) → 10% đã dùng
    expect(groups[0].usedPercent).toBe(10)
    expect(groups[0].remainingPercent).toBe(90)
    // Claude: min(0.8, 0.3) = 0.3 → 70% đã dùng
    expect(groups[1].usedPercent).toBe(70)
  })

  it('bucket disabled → disabled: true, vẫn nằm trong windows', () => {
    const [gemini] = parseAntigravityGroupQuotas(summary)
    const fiveHour = gemini.windows?.find((w) => w.windowId === '5h')
    expect(fiveHour?.disabled).toBe(true)
  })

  it('L2 (R2): window lạ + displayName rỗng/whitespace → windowLabel rơi về windowId, không phải ""', () => {
    const input = {
      groups: [
        {
          displayName: 'Lạ',
          buckets: [
            { bucketId: 'e1', window: 'monthly', displayName: '', remainingFraction: 0.5 },
            { bucketId: 'e2', window: 'daily', displayName: '   ', remainingFraction: 0.5 },
            { bucketId: 'e3', window: 'hourly', displayName: ' Giờ ', remainingFraction: 0.5 }
          ]
        }
      ]
    }
    const [group] = parseAntigravityGroupQuotas(input)
    const byId = Object.fromEntries(group.windows!.map((w) => [w.windowId, w.windowLabel]))
    expect(byId.monthly).toBe('monthly')
    expect(byId.daily).toBe('daily')
    // displayName hợp lệ vẫn dùng được, chỉ trim 2 đầu.
    expect(byId.hourly).toBe('Giờ')
  })

  it('nhóm không có bucket hợp lệ (chỉ disabled) → bỏ qua', () => {
    const onlyDisabled = {
      groups: [
        { displayName: 'Chỉ disabled', buckets: [{ bucketId: 'd1', window: '5h', disabled: true }] },
        { displayName: 'Gemini Models', buckets: [{ bucketId: 'g1', window: 'weekly', remainingFraction: 0.5 }] }
      ]
    }
    const groups = parseAntigravityGroupQuotas(onlyDisabled)
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('Gemini Models')
  })

  it('group rỗng / không summary → []', () => {
    expect(parseAntigravityGroupQuotas({})).toEqual([])
    expect(parseAntigravityGroupQuotas({ groups: [] })).toEqual([])
    expect(parseAntigravityGroupQuotas(null)).toEqual([])
    expect(parseAntigravityGroupQuotas(undefined)).toEqual([])
  })

  it('R3 M1: groups chứa phần tử null/undefined → bỏ qua phần tử đó, KHÔNG crash (giữ đường fallback parse)', () => {
    // protobuf-JSON có thể emit nulls trong mảng groups. Trước fix: TypeError
    // thoát ra ngoài → fetchAntigravityQuota bắt lỗi → buildEmptyQuota, mất luôn
    // cả nhánh fallback parse theo model dù fetchAvailableModels chạy được.
    const groupsWithNulls = [
      null,
      undefined,
      {
        displayName: 'Gemini Models',
        buckets: [{ bucketId: 'g1', window: 'weekly', remainingFraction: 0.5 }]
      },
      null
    ] as unknown as QuotaSummaryGroup[]
    const groups = parseAntigravityGroupQuotas({ groups: groupsWithNulls })
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('Gemini Models')
    expect(groups[0].usedPercent).toBe(50)
  })

  it('nhóm thiếu displayName → label fallback theo nội dung bucket (L1), modelId ổn định khi đổi thứ tự', () => {
    const bucketX = { bucketId: 'x1', window: '5h', remainingFraction: 0.5 }
    const bucketY = { bucketId: 'y1', window: 'weekly', remainingFraction: 0.5 }
    const noName = { groups: [{ buckets: [bucketX] }, { buckets: [bucketY] }] }
    const groups = parseAntigravityGroupQuotas(noName)
    // L1: label KHÔNG còn phụ thuộc index (`Nhóm model 1/2`) mà theo bucketId.
    expect(groups.map((g) => g.label)).toEqual(['Nhóm model x1', 'Nhóm model y1'])
    // Đảo thứ tự groups (và bucket đứng sau có windowId thay vì bucketId) → cùng modelId.
    const reversed = parseAntigravityGroupQuotas({
      groups: [{ buckets: [bucketY] }, { buckets: [bucketX] }]
    })
    const labelToId = Object.fromEntries(reversed.map((g) => [g.label, g.modelId]))
    expect(labelToId['Nhóm model x1']).toBe(groups[0].modelId)
    expect(labelToId['Nhóm model y1']).toBe(groups[1].modelId)
  })

  it('M1: ≥3 nhóm trùng displayName → modelId đôi một phân biệt (không duplicate React key)', () => {
    const dup = {
      groups: [
        {
          displayName: 'Claude and GPT models',
          buckets: [{ bucketId: 'k1', window: '5h', remainingFraction: 0.8 }]
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [{ bucketId: 'k2', window: '5h', remainingFraction: 0.6 }]
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [{ bucketId: 'k3', window: '5h', remainingFraction: 0.4 }]
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [{ bucketId: 'k4', window: '5h', remainingFraction: 0.2 }]
        }
      ]
    }
    const groups = parseAntigravityGroupQuotas(dup)
    expect(groups).toHaveLength(4)
    const ids = groups.map((g) => g.modelId)
    expect(new Set(ids).size).toBe(4)
    // Suffix theo fingerprint nội dung bucket → prefix group-<hash> giữ nguyên.
    ids.forEach((id) => expect(id).toMatch(/^group-\d+/))
    // Deterministic: parse lại đúng thứ tự → cùng danh sách id.
    expect(parseAntigravityGroupQuotas(dup).map((g) => g.modelId)).toEqual(ids)
  })

  it('M1: ≥2 nhóm trùng displayName → id không HOÁN ĐỔI khi API đổi thứ tự groups (fix suffix theo fingerprint)', () => {
    // Kịch bản review M1: 2 nhóm cùng label, 2 bucket khác nhau. Suffix gán theo
    // fingerprint bucket (nội dung) chứ KHÔNG phải thứ tự gặp → parse đảo thứ tự
    // vẫn gán CÙNG id cho CÙNG nhóm (trước fix: nhóm gặp trước lấy id gốc, nhóm
    // sau lấy id-suffix → đảo thứ tự = cả 2 đổi id cho nhau → React remount).
    // Nhận diện nhóm theo content (usedPercent bucket) vì cả 2 nhóm cùng label.
    const a = { displayName: 'Claude and GPT models', buckets: [{ bucketId: 'kA', window: '5h', remainingFraction: 0.8 }] }
    const b = { displayName: 'Claude and GPT models', buckets: [{ bucketId: 'kB', window: 'weekly', remainingFraction: 0.6 }] }
    const idByUsedPercent = (groups: ReturnType<typeof parseAntigravityGroupQuotas>) =>
      Object.fromEntries(groups.map((g) => [g.usedPercent, g.modelId]))
    const firstIds = idByUsedPercent(parseAntigravityGroupQuotas({ groups: [a, b] }))
    const reversedIds = idByUsedPercent(parseAntigravityGroupQuotas({ groups: [b, a] }))
    expect(reversedIds).toEqual(firstIds)
    expect(Object.keys(firstIds)).toEqual(['20', '40'])
    expect(new Set(Object.values(firstIds)).size).toBe(2)
  })

  it('L2 integration: bucket cạn có resetTime stale (qua sâu) → window + thẻ 0%, không "100% + Đang reset..."', () => {
    const stale = {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [{ bucketId: 's1', window: '5h', resetTime: past(10) }]
        }
      ]
    }
    const [group] = parseAntigravityGroupQuotas(stale)
    expect(group.windows?.[0].usedPercent).toBe(0)
    expect(group.usedPercent).toBe(0)
    expect(group.remainingPercent).toBe(100)
  })

  it('L2 integration: bucket cạn có resetTime trong grace vài giây → vẫn 100% (giữ H1)', () => {
    const recentReset = {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [{ bucketId: 'r1', window: '5h', resetTime: past(0.5) }]
        }
      ]
    }
    const [group] = parseAntigravityGroupQuotas(recentReset)
    expect(group.windows?.[0].usedPercent).toBe(100)
    expect(group.usedPercent).toBe(100)
  })

  it('bucket non-disabled thiếu remainingFraction = CẠN: window 100% used, không bị bỏ (H1)', () => {
    const partial = {
      groups: [
        {
          displayName: 'Claude and GPT models',
          buckets: [
            { bucketId: 'c1', window: '5h', remainingFraction: 0.8, resetTime: future(2) },
            { bucketId: 'c2', window: 'weekly', resetTime: future(100) }
          ]
        }
      ]
    }
    const [group] = parseAntigravityGroupQuotas(partial)
    const windows = Object.fromEntries(group.windows!.map((w) => [w.windowId, w]))
    expect(windows.weekly.usedPercent).toBe(100)
    expect(windows.weekly.remainingPercent).toBe(0)
    expect(windows.weekly.disabled).toBeFalsy()
    expect(windows.weekly.resetsInLabel).not.toBe('')
    // % tổng = bucket cạn nhất → nhóm 100% (không phải 20%)
    expect(group.usedPercent).toBe(100)
    expect(group.remainingPercent).toBe(0)
  })

  it('mọi bucket cùng cạn (thiếu fraction) → nhóm vẫn hiển thị 100%, không skip (H1)', () => {
    const allExhausted = {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'g1', window: '5h', resetTime: future(1) },
            { bucketId: 'g2', window: 'weekly', resetTime: future(50) }
          ]
        }
      ]
    }
    const groups = parseAntigravityGroupQuotas(allExhausted)
    expect(groups).toHaveLength(1)
    expect(groups[0].usedPercent).toBe(100)
  })

  it('bucket mới (thiếu cả fraction lẫn resetTime) → 0% đã dùng, KHÔNG báo 100% (fix M1)', () => {
    const freshAccount = {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            // Bucket chưa dùng/chưa khởi tạo: không fraction, không resetTime
            { bucketId: 'fresh1', window: '5h' },
            { bucketId: 'fresh2', window: 'weekly' }
          ]
        }
      ]
    }
    const [group] = parseAntigravityGroupQuotas(freshAccount)
    expect(group.usedPercent).toBe(0)
    expect(group.remainingPercent).toBe(100)
    const windows = Object.fromEntries(group.windows!.map((w) => [w.windowId, w]))
    expect(windows['5h'].usedPercent).toBe(0)
    expect(windows.weekly.usedPercent).toBe(0)
  })

  it('trộn bucket mới + bucket cạn → nhóm bị chi phối bởi bucket cạn (100%), bucket mới 0%', () => {
    const mixed = {
      groups: [
        {
          displayName: 'Claude and GPT models',
          buckets: [
            { bucketId: 'm1', window: '5h', resetTime: future(2) }, // cạn (thiếu fraction + có resetTime)
            { bucketId: 'm2', window: 'weekly' } // bucket mới (thiếu cả hai)
          ]
        }
      ]
    }
    const [group] = parseAntigravityGroupQuotas(mixed)
    expect(group.usedPercent).toBe(100)
    const windows = Object.fromEntries(group.windows!.map((w) => [w.windowId, w]))
    expect(windows['5h'].usedPercent).toBe(100)
    expect(windows.weekly.usedPercent).toBe(0)
  })

  it('bucket không có cả window lẫn bucketId → loại khỏi windows & binding; nhóm chỉ có bucket này → bỏ qua (chống Infinity)', () => {
    const orphan = {
      groups: [
        {
          displayName: 'Chỉ bucket mồ côi',
          buckets: [{ displayName: 'orphan', remainingFraction: 0.5, resetTime: future(1) }]
        },
        {
          displayName: 'Gemini Models',
          buckets: [{ bucketId: 'g1', window: 'weekly', remainingFraction: 0.4 }]
        }
      ]
    }
    const groups = parseAntigravityGroupQuotas(orphan)
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('Gemini Models')
    expect(Number.isFinite(groups[0].usedPercent)).toBe(true)
  })

  it('window lạ ngoài 5h/weekly (vd daily) → sort cuối, label fallback displayName (M2b)', () => {
    const unknownWindow = {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'u1', window: 'daily', displayName: 'Hàng ngày', remainingFraction: 0.5 },
            { bucketId: 'u2', window: 'weekly', remainingFraction: 0.9 }
          ]
        }
      ]
    }
    const [group] = parseAntigravityGroupQuotas(unknownWindow)
    expect(group.windows?.map((w) => w.windowId)).toEqual(['weekly', 'daily'])
    const daily = group.windows?.find((w) => w.windowId === 'daily')
    expect(daily?.windowLabel).toBe('Hàng ngày')
    expect(daily?.windowSeconds).toBeUndefined()
  })

  it('M2: 2 bucket cùng windowSeconds (undefined) → tie-breaker lexicographic theo windowId (stable)', () => {
    // 2 bucket window lạ (windowSeconds đều = undefined) → sort không stable trên
    // V8 cũ; tie-breaker windowId đảm bảo thứ tự lexicographic nhất quán, không
    // phụ thuộc thứ tự bucket API (tránh UI flash giữa 2 lần fetch).
    const sameWindow = {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'zzz', window: 'monthly', remainingFraction: 0.5 },
            { bucketId: 'aaa', window: 'daily', remainingFraction: 0.7 }
          ]
        }
      ]
    }
    const [group] = parseAntigravityGroupQuotas(sameWindow)
    expect(group.windows?.map((w) => w.windowId)).toEqual(['daily', 'monthly'])
    // Đảo thứ tự bucket API → cùng thứ tự output (không flash).
    const reversed = parseAntigravityGroupQuotas({
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'aaa', window: 'daily', remainingFraction: 0.7 },
            { bucketId: 'zzz', window: 'monthly', remainingFraction: 0.5 }
          ]
        }
      ]
    })
    expect(reversed[0].windows?.map((w) => w.windowId)).toEqual(['daily', 'monthly'])
  })

  it('M1: parse snapshot `now` 1 lần → stale bucket cho kết quả deterministic (không flip giữa 2 parse)', () => {
    // ResetTime cố định QUA SÂU (10 phút) so với mọi lúc chạy test → luôn > grace 120s
    // → stale → bucket "chưa dùng" (0% used). Nhờ parse snapshot `now` 1 lần,
    // mọi bucket trong cùng 1 parse dùng cùng mốc thời gian → không có trường hợp
    // bucket A tính stale ở mốc t1, bucket B tính cạn ở mốc t2 (khi grace nhỏ).
    const resetTime = past(10)
    const input = {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 's1', window: '5h', resetTime },
            { bucketId: 's2', window: 'weekly', resetTime }
          ]
        }
      ]
    }
    const first = parseAntigravityGroupQuotas(input)
    const second = parseAntigravityGroupQuotas(input)
    expect(first[0].usedPercent).toBe(0)
    expect(second[0].usedPercent).toBe(0)
    expect(second[0].windows?.map((w) => w.usedPercent)).toEqual(first[0].windows?.map((w) => w.usedPercent))
  })

  it('L3: ưu tiên Gemini Models trước, rồi đến Claude and GPT models, sau đó đến các nhóm khác (deterministic bất kể thứ tự API)', () => {
    const l3 = {
      groups: [
        // Thứ tự API bất kỳ — parse phải sắp xếp Gemini lên đầu, Claude thứ hai
        { displayName: 'Claude and GPT models', buckets: [{ bucketId: 'l2', window: '5h', remainingFraction: 0.1 }] },
        { displayName: 'Mid Group', buckets: [{ bucketId: 'l3', window: '5h', remainingFraction: 0.5 }] },
        { displayName: 'Gemini Models', buckets: [{ bucketId: 'l1', window: '5h', remainingFraction: 0.95 }] }
      ]
    }
    const groups = parseAntigravityGroupQuotas(l3)
    expect(groups.map((g) => g.label)).toEqual([
      'Gemini Models',
      'Claude and GPT models',
      'Mid Group'
    ])
    expect(groups.map((g) => g.usedPercent)).toEqual([5, 90, 50])
    // Deterministic: đảo thứ tự API → cùng output (tie-breaker theo nội dung).
    const reversed = parseAntigravityGroupQuotas({ groups: [...l3.groups].reverse() })
    expect(reversed.map((g) => g.modelId)).toEqual(groups.map((g) => g.modelId))
  })

  it('L-NEW-1: windowId là prototype key → không leak function từ Object.prototype (label fallback, seconds undefined)', () => {
    const prototypeKey = {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'p1', window: 'toString', displayName: 'Cửa sổ lạ', remainingFraction: 0.5 },
            { bucketId: 'constructor', remainingFraction: 0.9 }
          ]
        }
      ]
    }
    const [group] = parseAntigravityGroupQuotas(prototypeKey)
    const windows = group.windows!
    const byLabel = windows.find((w) => w.windowId === 'toString')
    expect(typeof byLabel?.windowLabel).toBe('string')
    expect(byLabel?.windowLabel).toBe('Cửa sổ lạ')
    expect(byLabel?.windowSeconds).toBeUndefined()
    const byBucketId = windows.find((w) => w.windowId === 'constructor')
    expect(typeof byBucketId?.windowLabel).toBe('string')
    expect(byBucketId?.windowLabel).toBe('constructor')
    expect(byBucketId?.windowSeconds).toBeUndefined()
    // Sort không NaN (P4): comparator vẫn finite dù windowSeconds undefined.
    expect(windows.map((w) => w.windowId)).toEqual(['constructor', 'toString'])
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

describe('buildModelQuota (có nhóm — QUOTA_REVIEW N3)', () => {
  const group = {
    displayName: 'Claude and GPT models',
    buckets: [
      { bucketId: 'n1', window: '5h', remainingFraction: 0.8, resetTime: future(2) },
      { bucketId: 'n2', window: 'weekly', resetTime: future(100) } // thiếu fraction = cạn
    ]
  }

  it('bucket nhóm non-disabled thiếu fraction = cạn → thẻ 100%, KHÔNG skip về 20%', () => {
    const m = buildModelQuota('claude-opus-4-6', 'Claude Opus 4.6', { remainingFraction: 1 }, group)
    expect(m.usedPercent).toBe(100)
    expect(m.remainingPercent).toBe(0)
    expect(m.windowLabel).toBe('7 ngày')
  })

  it('% thẻ nhất quán với window row (cùng 100%, không còn lệch row-vs-overview)', () => {
    const m = buildModelQuota('claude-opus-4-6', 'Claude Opus 4.6', { remainingFraction: 1 }, group)
    const windows = Object.fromEntries(m.windows!.map((w) => [w.windowId, w]))
    expect(windows.weekly.usedPercent).toBe(100)
    expect(windows['5h'].usedPercent).toBe(20)
  })

  it('bucket disabled thiếu fraction vẫn bị loại khỏi binding (không đổi hành vi)', () => {
    const disabledGroup = {
      displayName: 'Gemini Models',
      buckets: [
        { bucketId: 'g1', window: 'weekly', remainingFraction: 0.9, resetTime: future(50) },
        { bucketId: 'g2', window: '5h', disabled: true }
      ]
    }
    const m = buildModelQuota('gemini-3-pro', 'Gemini 3 Pro', { remainingFraction: 1 }, disabledGroup)
    expect(m.usedPercent).toBe(10)
    expect(m.windowLabel).toBe('7 ngày')
  })

  it('bucket nhóm mới (thiếu cả fraction lẫn resetTime) → không kéo thẻ model về 100% (fix M1)', () => {
    const freshGroup = {
      displayName: 'Gemini Models',
      buckets: [{ bucketId: 'f1', window: '5h' }] // bucket mới — chưa dùng
    }
    const m = buildModelQuota('gemini-3-pro', 'Gemini 3 Pro', { remainingFraction: 0.7 }, freshGroup)
    // Trước fix: bucket mới bị coi là cạn (0) → thẻ 100% sai.
    // Sau fix: bucket mới = 1.0 → binding = own (0.7, cạn nhất) → thẻ 30%.
    expect(m.usedPercent).toBe(30)
    // Đồng bộ: window row của bucket mới 0%, không báo 100%
    expect(m.windows?.[0]?.usedPercent).toBe(0)
  })

  it('bucket nhóm cạn (thiếu fraction + có resetTime) vẫn kéo thẻ về 100% (không hồi quy H1/N3)', () => {
    const exhaustedGroup = {
      displayName: 'Claude and GPT models',
      buckets: [{ bucketId: 'e1', window: '5h', resetTime: future(2) }]
    }
    const m = buildModelQuota('claude-opus-4-6', 'Claude Opus 4.6', { remainingFraction: 1 }, exhaustedGroup)
    expect(m.usedPercent).toBe(100)
    expect(m.windows?.[0]?.usedPercent).toBe(100)
  })

  it('tiêu thụ một lượng nhỏ token (0 < remaining < 1) -> usedPercent ít nhất 1%, remainingPercent tối đa 99% (không bị làm tròn về 100% còn lại)', () => {
    const tinyUsageGroup = {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            // Chat thử nghiệm tiêu thụ ~0.04% quota -> remainingFraction 0.99958
            { bucketId: 'g1', window: '5h', remainingFraction: 0.99958, resetTime: future(3) },
            { bucketId: 'g2', window: 'weekly', remainingFraction: 0.99988, resetTime: future(100) }
          ]
        }
      ]
    }
    const [group] = parseAntigravityGroupQuotas(tinyUsageGroup)
    expect(group.usedPercent).toBe(1)
    expect(group.remainingPercent).toBe(99)
    const windows = Object.fromEntries(group.windows!.map((w) => [w.windowId, w]))
    expect(windows['5h'].usedPercent).toBe(1)
    expect(windows['5h'].remainingPercent).toBe(99)
    expect(windows.weekly.usedPercent).toBe(1)
    expect(windows.weekly.remainingPercent).toBe(99)
  })
})

