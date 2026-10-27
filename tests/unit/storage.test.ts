import { describe, expect, it } from 'vitest'
import {
  getActiveCodexAccountId,
  getActiveAccountIdForProvider,
  isCodexProvider,
  withActiveAccountForProvider,
  findAccount,
  sanitizeAccountForRenderer,
  sanitizeAppDataForRenderer
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

describe('storage: sanitize dữ liệu gửi Renderer (SEC-09)', () => {
  it('loại bỏ apiKey nguyên bản và chỉ trả về bản đã che', () => {
    const account = makeAccount({
      id: 'fm',
      provider: 'codex-freemodel',
      apiKey: 'sk-super-secret-1234'
    })

    const sanitized = sanitizeAccountForRenderer(account)

    expect(sanitized.apiKey).toBe('')
    expect(sanitized.apiKeyMasked).toBe('sk-s••••1234')
    expect(JSON.stringify(sanitized)).not.toContain('super-secret')
  })

  it('sanitize toàn bộ accounts trong AppData', () => {
    const data = makeData(
      [
        makeAccount({ id: 'fm', provider: 'codex-freemodel', apiKey: 'sk-aaaaaaaa-1111' }),
        makeAccount({ id: 'cg', provider: 'codex-chatgpt', apiKey: '' })
      ],
      {
        'codex-freemodel': 'fm',
        'codex-chatgpt': null,
        antigravity: null,
        'github-copilot': null
      }
    )

    const sanitized = sanitizeAppDataForRenderer(data)

    expect(sanitized.accounts.every((account) => account.apiKey === '')).toBe(true)
    expect(sanitized.accounts[0].apiKeyMasked).toBe('sk-a••••1111')
    expect(JSON.stringify(sanitized)).not.toContain('aaaaaaaa')
  })
})
