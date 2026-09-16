import { afterEach, describe, expect, it, vi } from 'vitest'

// Mocks phải set trước khi import module được test.
vi.mock('../../electron/main/antigravity-auth-storage', () => ({
  deleteStoredAntigravityAccount: vi.fn(async () => undefined),
  findAccountIndexByEmail: vi.fn(() => 0),
  isValidAntigravityEntry: (entry: { refreshToken?: string } | null) =>
    !!entry && typeof entry.refreshToken === 'string' && entry.refreshToken.length > 0,
  loadStoredAntigravityAccount: vi.fn(),
  mergeAccountEntry: vi.fn(() => []),
  normalizeAntigravityEntry: (entry: { refreshToken?: string } | null) => entry,
  readLiveAntigravityAccounts: vi.fn(async () => null),
  saveStoredAntigravityAccount: vi.fn(async () => undefined),
  writeLiveAntigravityAccounts: vi.fn(async () => undefined)
}))

vi.mock('../../electron/main/antigravity-oauth-config', () => ({
  getAntigravityOAuthCredentials: vi.fn(async () => ({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret'
  }))
}))

import { loadStoredAntigravityAccount } from '../../electron/main/antigravity-auth-storage'
import { fetchAntigravityQuota } from '../../electron/main/providers/antigravity'

const storedEntry = {
  email: 'test@example.com',
  refreshToken: 'refresh-token-test',
  projectId: 'test-project'
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  } as Response
}

type FetchHandler = (url: string, body?: unknown) => Response

function setupFetch(handler: FetchHandler) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    // Token refresh POST dùng URLSearchParams (không JSON) — JSON.parse throw, bỏ qua.
    let body: unknown
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined
    } catch {
      body = undefined
    }
    return handler(url, body)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const summaryBody = {
  groups: [
    {
      displayName: 'Claude and GPT models',
      buckets: [{ bucketId: 'c1', window: '5h', remainingFraction: 0.8, resetTime: '' }]
    }
  ]
}

const modelsBody = {
  models: {
    'gemini-3-pro': { displayName: 'Gemini 3 Pro', quotaInfo: { remainingFraction: 0.5 } }
  },
  agentModelSorts: [{ groups: [{ modelIds: ['gemini-3-pro'] }] }]
}

function route(url: string): string {
  if (url.includes('oauth2.googleapis.com/token')) return 'token'
  if (url.includes('loadCodeAssist')) return 'projectId'
  if (url.includes('retrieveUserQuotaSummary')) return 'summary'
  if (url.includes('fetchAvailableModels')) return 'models'
  return 'unknown'
}

describe('fetchAntigravityQuota (M1/M2c)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('summary hợp lệ → quotaLayout="groups", không gọi fetchAvailableModels', async () => {
    vi.mocked(loadStoredAntigravityAccount).mockResolvedValue(storedEntry)
    const fetchMock = setupFetch((url) => {
      const which = route(url)
      if (which === 'token') return jsonResponse({ access_token: 't', expires_in: 3600 })
      if (which === 'projectId') return jsonResponse({ cloudaicompanionProject: 'p1' })
      if (which === 'summary') return jsonResponse(summaryBody)
      throw new Error(`unexpected call: ${url}`)
    })

    const quota = await fetchAntigravityQuota('acct-1')
    expect(quota.available).toBe(true)
    expect(quota.quotaLayout).toBe('groups')
    expect(quota.models).toHaveLength(1)
    expect(quota.models?.[0].label).toBe('Claude and GPT models')
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('fetchAvailableModels'))).toBe(false)
  })

  it('summary 401 → buildEmptyQuota "hết hạn", KHÔNG gọi thêm fetchAvailableModels (M1)', async () => {
    vi.mocked(loadStoredAntigravityAccount).mockResolvedValue(storedEntry)
    const fetchMock = setupFetch((url) => {
      const which = route(url)
      if (which === 'token') return jsonResponse({ access_token: 't', expires_in: 3600 })
      if (which === 'projectId') return jsonResponse({ cloudaicompanionProject: 'p1' })
      if (which === 'summary') return jsonResponse({}, 401)
      throw new Error(`unexpected call: ${url}`)
    })

    const quota = await fetchAntigravityQuota('acct-1')
    expect(quota.available).toBe(false)
    expect(quota.message).toContain('hết hạn')
    expect(quota.quotaLayout).toBeUndefined()
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('fetchAvailableModels'))).toBe(false)
  })

  it('summary lỗi (503) + models hợp lệ → fallback, quotaLayout="models" (M2c)', async () => {
    vi.mocked(loadStoredAntigravityAccount).mockResolvedValue(storedEntry)
    setupFetch((url) => {
      const which = route(url)
      if (which === 'token') return jsonResponse({ access_token: 't', expires_in: 3600 })
      if (which === 'projectId') return jsonResponse({ cloudaicompanionProject: 'p1' })
      if (which === 'summary') return jsonResponse({}, 503)
      if (which === 'models') return jsonResponse(modelsBody)
      throw new Error(`unexpected call: ${url}`)
    })

    const quota = await fetchAntigravityQuota('acct-1')
    expect(quota.available).toBe(true)
    expect(quota.quotaLayout).toBe('models')
    expect(quota.models).toHaveLength(1)
    expect(quota.models?.[0].modelId).toBe('gemini-3-pro')
  })

  it('summary OK nhưng toàn bucket disabled → parse rỗng, fallback models, quotaLayout="models" (QUOTA_REVIEW LOW-1)', async () => {
    vi.mocked(loadStoredAntigravityAccount).mockResolvedValue(storedEntry)
    const fetchMock = setupFetch((url) => {
      const which = route(url)
      if (which === 'token') return jsonResponse({ access_token: 't', expires_in: 3600 })
      if (which === 'projectId') return jsonResponse({ cloudaicompanionProject: 'p1' })
      if (which === 'summary')
        return jsonResponse({
          groups: [
            {
              displayName: 'X',
              buckets: [{ bucketId: 'd1', window: '5h', disabled: true }]
            }
          ]
        })
      if (which === 'models') return jsonResponse(modelsBody)
      throw new Error(`unexpected call: ${url}`)
    })

    const quota = await fetchAntigravityQuota('acct-1')
    expect(quota.available).toBe(true)
    expect(quota.quotaLayout).toBe('models')
    expect(quota.models?.[0].modelId).toBe('gemini-3-pro')
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('fetchAvailableModels'))).toBe(true)
  })

  it('summary lỗi + models 401 → buildEmptyQuota "hết hạn" (con đường fallback cũ vẫn giữ)', async () => {
    vi.mocked(loadStoredAntigravityAccount).mockResolvedValue(storedEntry)
    setupFetch((url) => {
      const which = route(url)
      if (which === 'token') return jsonResponse({ access_token: 't', expires_in: 3600 })
      if (which === 'projectId') return jsonResponse({ cloudaicompanionProject: 'p1' })
      if (which === 'summary') return jsonResponse({}, 503)
      if (which === 'models') return jsonResponse({}, 401)
      throw new Error(`unexpected call: ${url}`)
    })

    const quota = await fetchAntigravityQuota('acct-1')
    expect(quota.available).toBe(false)
    expect(quota.message).toContain('hết hạn')
  })
})
