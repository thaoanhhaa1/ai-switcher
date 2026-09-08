import { describe, expect, it } from 'vitest'
import {
  getActiveCodexAccountId,
  getActiveAccountIdForProvider,
  isCodexProvider,
  withActiveAccountForProvider,
  findAccount
} from '../../electron/main/storage'
import type { Account, AppData } from '../../src/types'

function makeAccount(overrides: Partial<Account> & { id: string; provider: Account['provider'] }): Account {
  return {
    name: overrides.id,
    apiKey: '',
    settings: { model: 'gpt-5.5', modelReasoningEffort: 'high' },
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: null,
    switchCount: 0,
    ...overrides
  }
}

function makeData(accounts: Account[], activeAccountIds: AppData['activeAccountIds']): AppData {
  return { version: 2, activeAccountIds, accounts, usageLog: [] }
}

describe('storage: shared Codex slot', () => {
  it('isCodexProvider đúng cho 2 codex provider', () => {
    expect(isCodexProvider('codex-freemodel')).toBe(true)
    expect(isCodexProvider('codex-chatgpt')).toBe(true)
    expect(isCodexProvider('antigravity')).toBe(false)
    expect(isCodexProvider('github-copilot')).toBe(false)
  })

  it('switch codex provider này → codex provider kia bị clear (shared ~/.codex)', () => {
    const freemodel = makeAccount({ id: 'fm', provider: 'codex-freemodel' })
    const chatgpt = makeAccount({ id: 'cg', provider: 'codex-chatgpt' })
    const data = makeData([freemodel, chatgpt], {
      'codex-freemodel': 'fm',
      'codex-chatgpt': 'cg',
      antigravity: null,
      'github-copilot': null
    })

    const next = withActiveAccountForProvider(data, 'codex-chatgpt', 'cg')
    expect(getActiveAccountIdForProvider(next, 'codex-chatgpt')).toBe('cg')
    expect(getActiveAccountIdForProvider(next, 'codex-freemodel')).toBeNull()
    // provider không phải codex không bị ảnh hưởng
    const next2 = withActiveAccountForProvider(data, 'antigravity', 'ag1')
    expect(getActiveAccountIdForProvider(next2, 'codex-freemodel')).toBe('fm')
  })

  it('getActiveCodexAccountId trả slot codex đầu tiên còn active', () => {
    const data = makeData([], {
      'codex-freemodel': 'fm1',
      'codex-chatgpt': null,
      antigravity: null,
      'github-copilot': null
    })
    expect(getActiveCodexAccountId(data)).toBe('fm1')
    expect(
      getActiveCodexAccountId(
        makeData([], {
          'codex-freemodel': null,
          'codex-chatgpt': null,
          antigravity: null,
          'github-copilot': 'gh'
        })
      )
    ).toBeNull()
  })

  it('findAccount tìm đúng account', () => {
    const a = makeAccount({ id: 'x1', provider: 'antigravity' })
    expect(findAccount(makeData([a], { 'codex-freemodel': null, 'codex-chatgpt': null, antigravity: null, 'github-copilot': null }), 'x1')).toBe(a)
    expect(findAccount(makeData([], { 'codex-freemodel': null, 'codex-chatgpt': null, antigravity: null, 'github-copilot': null }), 'nope')).toBeUndefined()
  })
})
