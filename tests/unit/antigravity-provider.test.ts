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
import { fetchAntigravityQuota, testAntigravityChat } from '../../electron/main/providers/antigravity'

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

  it('ưu tiên host daily trước (match IDE) và trả về cả 2 nhóm Gemini + Claude (không gọi thêm prod khi đã đủ)', async () => {
    vi.mocked(loadStoredAntigravityAccount).mockResolvedValue(storedEntry)
    const calls: string[] = []
    setupFetch((url) => {
      calls.push(url)
      const which = route(url)
      if (which === 'token') return jsonResponse({ access_token: 't', expires_in: 3600 })
      if (which === 'projectId') return jsonResponse({ cloudaicompanionProject: 'p1' })
      if (which === 'summary') {
        return jsonResponse({
          groups: [
            {
              displayName: 'Gemini Models',
              buckets: [{ bucketId: 'g1', window: '5h', remainingFraction: 0.9, resetTime: '' }]
            },
            {
              displayName: 'Claude and GPT models',
              buckets: [{ bucketId: 'c1', window: '5h', remainingFraction: 0.8, resetTime: '' }]
            }
          ]
        })
      }
      throw new Error(`unexpected call: ${url}`)
    })

    const quota = await fetchAntigravityQuota('acct-1')
    expect(quota.available).toBe(true)
    expect(quota.quotaLayout).toBe('groups')
    expect(quota.models).toHaveLength(2)
    const labels = quota.models?.map((m) => m.label)
    expect(labels).toContain('Gemini Models')
    expect(labels).toContain('Claude and GPT models')

    // Host daily được gọi đầu tiên (match endpoint của Antigravity IDE)
    const summaryCalls = calls.filter((u) => u.includes('retrieveUserQuotaSummary'))
    expect(summaryCalls).toHaveLength(1)
    expect(summaryCalls[0]).toContain('daily-cloudcode-pa.googleapis.com')
  })

  it('nếu một host thiếu nhóm Gemini → tự động merge từ host còn lại', async () => {
    vi.mocked(loadStoredAntigravityAccount).mockResolvedValue(storedEntry)
    setupFetch((url) => {
      const which = route(url)
      if (which === 'token') return jsonResponse({ access_token: 't', expires_in: 3600 })
      if (which === 'projectId') return jsonResponse({ cloudaicompanionProject: 'p1' })
      if (which === 'summary') {
        if (url.includes('daily-cloudcode-pa')) {
          return jsonResponse({
            groups: [
              {
                displayName: 'Gemini Models',
                buckets: [{ bucketId: 'g1', window: '5h', remainingFraction: 0.9, resetTime: '' }]
              }
            ]
          })
        }
        // Prod chỉ trả Claude
        return jsonResponse({
          groups: [
            {
              displayName: 'Claude and GPT models',
              buckets: [{ bucketId: 'c1', window: '5h', remainingFraction: 0.8, resetTime: '' }]
            }
          ]
        })
      }
      throw new Error(`unexpected call: ${url}`)
    })

    const quota = await fetchAntigravityQuota('acct-1')
    expect(quota.available).toBe(true)
    expect(quota.quotaLayout).toBe('groups')
    expect(quota.models).toHaveLength(2)
    const labels = quota.models?.map((m) => m.label)
    expect(labels).toContain('Gemini Models')
    expect(labels).toContain('Claude and GPT models')
  })
})

describe('testAntigravityChat', () => {
  it('trả về lỗi nếu tài khoản chưa có thông tin đăng nhập', async () => {
    vi.mocked(loadStoredAntigravityAccount).mockResolvedValue(null)
    const result = await testAntigravityChat('missing-acct', 'gemini')
    expect(result.success).toBe(false)
    expect(result.message).toContain('Chưa có thông tin đăng nhập')
  })

  it('gửi chat thành công cho Gemini khi API trả về 200', async () => {
    vi.mocked(loadStoredAntigravityAccount).mockResolvedValue(storedEntry)
    let capturedBody: any
    setupFetch((url, body) => {
      const which = route(url)
      if (which === 'token') return jsonResponse({ access_token: 'valid-token', expires_in: 3600 })
      if (which === 'projectId') return jsonResponse({ cloudaicompanionProject: 'p1' })
      if (url.includes('generateContent')) {
        capturedBody = body
        return jsonResponse({
          candidates: [{ content: { parts: [{ text: 'ok' }] } }]
        })
      }
      throw new Error(`unexpected call: ${url}`)
    })

    const result = await testAntigravityChat('acct-1', 'gemini')
    expect(result.success).toBe(true)
    expect(result.status).toBe(200)
    expect(capturedBody?.model).toBe('gemini-3.8-flash-high')
    expect(capturedBody?.request?.contents[0]?.parts[0]?.text).toBe('Say ok')
  })

  it('gửi chat thất bại khi API trả về 429 Resource Exhausted', async () => {
    vi.mocked(loadStoredAntigravityAccount).mockResolvedValue(storedEntry)
    setupFetch((url) => {
      const which = route(url)
      if (which === 'token') return jsonResponse({ access_token: 'valid-token', expires_in: 3600 })
      if (which === 'projectId') return jsonResponse({ cloudaicompanionProject: 'p1' })
      if (url.includes('generateContent')) {
        return jsonResponse(
          {
            error: {
              code: 429,
              message: 'Resource has been exhausted (e.g. check quota).'
            }
          },
          429
        )
      }
      throw new Error(`unexpected call: ${url}`)
    })

    const result = await testAntigravityChat('acct-1', 'claude')
    expect(result.success).toBe(false)
    expect(result.status).toBe(429)
    expect(result.message).toContain('Resource has been exhausted')
  })

  it('thử model kế tiếp nếu model đầu tiên trả về 404', async () => {
    vi.mocked(loadStoredAntigravityAccount).mockResolvedValue(storedEntry)
    const testedModels: string[] = []
    setupFetch((url, body: any) => {
      const which = route(url)
      if (which === 'token') return jsonResponse({ access_token: 'valid-token', expires_in: 3600 })
      if (which === 'projectId') return jsonResponse({ cloudaicompanionProject: 'p1' })
      if (url.includes('generateContent')) {
        testedModels.push(body?.model)
        if (body?.model === 'gemini-3.8-flash-high') {
          return jsonResponse({ error: { message: 'Not found' } }, 404)
        }
        return jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
      }
      throw new Error(`unexpected call: ${url}`)
    })

    const result = await testAntigravityChat('acct-1', 'gemini')
    expect(result.success).toBe(true)
    expect(testedModels[0]).toBe('gemini-3.8-flash-high')
    expect(testedModels[1]).toBe('gemini-3.8-flash-tiered')
  })
})


