// ============================================================================
// R5 INFO 1: applyCopilotEntries chỉ finalize (mở connection + WAL checkpoint
// trên DB của IDE) khi THỰC SỰ có mutation — no-op thuần không được "touch" DB.
// Driver được mock để đếm số lần finalize chạy.
// ============================================================================
const driverStub = vi.hoisted(() => ({
  name: 'sqlite3-cli' as const,
  ensureSchema: vi.fn(async () => undefined),
  readValue: vi.fn(async () => null),
  writeValue: vi.fn(async () => undefined),
  writeValues: vi.fn(async () => undefined),
  deleteValues: vi.fn(async () => 0),
  listKeys: vi.fn(async () => [] as string[]),
  finalize: vi.fn(async () => undefined)
}))

vi.mock('../../electron/main/sqlite-db', () => ({
  getSqliteDriver: async () => driverStub,
  fileExists: async () => false,
  backupDatabase: async () => '',
  withDbLock: (_dbPath: string, fn: () => Promise<unknown>) => fn()
}))

import { describe, expect, it, vi } from 'vitest'
import { applyCopilotEntries, filterEntriesForApply } from '../../electron/main/copilot-ide'

const AUTH_KEY = 'secret://{"extensionId":"vscode.github-authentication","key":"github.auth"}'

describe('filterEntriesForApply (Copilot key filtering)', () => {
  it('giữ auth secret + ghi đè username key, loại key lạ', () => {
    const filtered = filterEntriesForApply(
      {
        [AUTH_KEY]: 'tok',
        'github.copilot-github': 'stale-user',
        'github-otheruser': 'x',
        'github-testuser-usages': 'u',
        'random-key': 'v'
      },
      'testuser'
    )

    expect(Object.keys(filtered).sort()).toEqual(
      [AUTH_KEY, 'github.copilot-github', 'github-testuser-usages'].sort()
    )
    expect(filtered['github.copilot-github']).toBe('testuser')
    expect(filtered['github-otheruser']).toBeUndefined()
    expect(filtered['random-key']).toBeUndefined()
  })

  it('-usages key khớp username (case-insensitive) được giữ', () => {
    const filtered = filterEntriesForApply(
      { 'github-TestUser-usages': 'keep-me' },
      'testuser'
    )
    expect(filtered['github-TestUser-usages']).toBe('keep-me')
  })

  it('usages key của user khác bị loại', () => {
    const filtered = filterEntriesForApply(
      { 'github-other-usages': 'drop-me' },
      'testuser'
    )
    expect(filtered['github-other-usages']).toBeUndefined()
  })

  it('defaultAccount.cachedPolicyData + extensionsAssignmentFilterProvider giữ nguyên', () => {
    const filtered = filterEntriesForApply(
      {
        'defaultAccount.cachedPolicyData': 'policy',
        'extensionsAssignmentFilterProvider.copilot.foo': 'bar'
      },
      'testuser'
    )
    expect(filtered['defaultAccount.cachedPolicyData']).toBe('policy')
    expect(filtered['extensionsAssignmentFilterProvider.copilot.foo']).toBe('bar')
  })
})

describe('applyCopilotEntries — gate finalize (R5 INFO 1)', () => {
  const resetCalls = () => {
    driverStub.writeValues.mockClear()
    driverStub.deleteValues.mockClear()
    driverStub.finalize.mockClear()
  }

  it('no-op thuần (không entry áp dụng, DB không có key copilot nào để xóa) → KHÔNG finalize', async () => {
    resetCalls()
    driverStub.deleteValues.mockResolvedValue(0)

    await applyCopilotEntries('/tmp/empty.vscdb', {}, 'testuser')

    expect(driverStub.writeValues).not.toHaveBeenCalled()
    expect(driverStub.finalize).not.toHaveBeenCalled()
  })

  it('chỉ ghi (entries có key) → finalize chạy đúng 1 lần sau writeValues', async () => {
    resetCalls()
    driverStub.deleteValues.mockResolvedValue(0)

    await applyCopilotEntries('/tmp/x.vscdb', { [AUTH_KEY]: 'tok' }, 'testuser')

    expect(driverStub.writeValues).toHaveBeenCalledTimes(1)
    expect(driverStub.finalize).toHaveBeenCalledTimes(1)
    // thứ tự: mọi delete phải trước write, finalize cuối
    const order = vi
      .mocked(driverStub.finalize)
      .mock.invocationCallOrder[0]!
    const writeOrder = vi
      .mocked(driverStub.writeValues)
      .mock.invocationCallOrder[0]!
    expect(order).toBeGreaterThan(writeOrder)
  })

  it('chỉ xóa (entries rỗng nhưng DB CÓ dòng copilot thật bị xóa) → vẫn finalize để checkpoint WAL', async () => {
    resetCalls()
    // R6 L3 (R8 L1 đính chính): clearCopilotEntries batch hoá — 1 lệnh
    // deleteValues duy nhất. COPILOT_CHAT_KEY đã nằm sẵn trong STATIC_KEYS từ
    // trước (không phải "đưa vào tách riêng"), nên batch tự nhiên chứa nó.
    driverStub.deleteValues.mockResolvedValueOnce(1)

    await applyCopilotEntries('/tmp/x.vscdb', {}, 'testuser')

    expect(driverStub.deleteValues).toHaveBeenCalledTimes(1)
    expect(driverStub.writeValues).not.toHaveBeenCalled()
    expect(driverStub.finalize).toHaveBeenCalledTimes(1)
  })

  it('R6 L3: clearCopilotEntries là MỘT lệnh deleteValues batch (không còn N+1 spawn per-key)', async () => {
    resetCalls()
    driverStub.deleteValues.mockResolvedValue(3)

    await applyCopilotEntries('/tmp/x.vscdb', { [AUTH_KEY]: 'tok' }, 'testuser')

    expect(driverStub.deleteValues).toHaveBeenCalledTimes(1)
    // batch chứa STATIC_KEYS (đã có sẵn COPILOT_CHAT_KEY — R8 L1 đính chính)
    const keys = driverStub.deleteValues.mock.calls[0]?.[1] as string[]
    expect(keys).toContain(AUTH_KEY)
    expect(keys).toContain('GitHub.copilot-chat')
    expect(keys.some((key) => key.startsWith('vscode.github-github') || key === 'vscode.github')).toBe(true)
  })

  it('R6 L4: entries chứa COPILOT_CHAT_KEY → key bị lọc khỏi writeValues (khôi phục sạch khi switch lại)', async () => {
    resetCalls()
    driverStub.deleteValues.mockResolvedValue(0)

    await applyCopilotEntries('/tmp/x.vscdb', { 'GitHub.copilot-chat': 'chat', [AUTH_KEY]: 'tok' }, 'testuser')

    const written = driverStub.writeValues.mock.calls[0]?.[1] as Record<string, string>
    expect(written['GitHub.copilot-chat']).toBeUndefined()
    expect(written[AUTH_KEY]).toBe('tok')
  })
})
