import { createHash, randomBytes } from 'crypto'
import { createServer } from 'http'
import { shell } from 'electron'
import type { AntigravityAccountEntry } from './antigravity-auth-storage'
import { getAntigravityOAuthCredentials } from './antigravity-oauth-config'

const OAUTH_CALLBACK_PATH = '/oauth-callback'
const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000
const LOAD_ENDPOINTS = [
  'https://cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://autopush-cloudcode-pa.sandbox.googleapis.com'
]

const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs'
]

const GEMINI_USER_AGENT = 'google-api-nodejs-client/9.15.1'

interface PendingOAuthSession {
  verifier: string
  projectId: string
  createdAt: number
}

const PENDING_OAUTH_TTL_MS = 5 * 60 * 1000
const pendingOAuthSessions = new Map<string, PendingOAuthSession>()

function pruneExpiredOAuthSessions(now = Date.now()): void {
  for (const [state, session] of pendingOAuthSessions) {
    if (now - session.createdAt > PENDING_OAUTH_TTL_MS) {
      pendingOAuthSessions.delete(state)
    }
  }
}

function createOAuthSession(verifier: string, projectId = ''): string {
  pruneExpiredOAuthSessions()
  const state = randomBytes(32).toString('hex')
  pendingOAuthSessions.set(state, { verifier, projectId, createdAt: Date.now() })
  return state
}

function consumeOAuthSession(state: string): PendingOAuthSession {
  pruneExpiredOAuthSessions()
  const session = pendingOAuthSessions.get(state)
  if (!session) {
    throw new Error('OAuth state không hợp lệ hoặc đã hết hạn')
  }
  pendingOAuthSessions.delete(state)
  return session
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

async function buildAuthorizationUrl(
  verifier: string,
  state: string,
  redirectUri: string
): Promise<string> {
  const { clientId } = await getAntigravityOAuthCredentials()
  const challenge = createHash('sha256').update(verifier).digest('base64url')

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', SCOPES.join(' '))
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  return url.toString()
}

async function fetchProjectId(accessToken: string): Promise<string> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': GEMINI_USER_AGENT,
    'Client-Metadata': JSON.stringify({
      ideType: 'ANTIGRAVITY',
      platform: process.platform === 'win32' ? 'WINDOWS' : 'MACOS',
      pluginType: 'GEMINI'
    })
  }

  for (const base of LOAD_ENDPOINTS) {
    try {
      const response = await fetch(`${base}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          metadata: {
            ideType: 'ANTIGRAVITY',
            platform: process.platform === 'win32' ? 'WINDOWS' : 'MACOS',
            pluginType: 'GEMINI'
          }
        })
      })

      if (!response.ok) continue

      const data = (await response.json()) as {
        cloudaicompanionProject?: string | { id?: string }
      }

      const project = data.cloudaicompanionProject

      if (typeof project === 'string' && project) {
        return project
      }
      if (
        typeof project === 'object' &&
        project !== null &&
        typeof project.id === 'string' &&
        project.id
      ) {
        return project.id
      }
    } catch {
      // try next endpoint
    }
  }

  return ''
}

async function exchangeAuthorizationCode(
  code: string,
  state: string,
  redirectUri: string
): Promise<AntigravityAccountEntry> {
  const { verifier, projectId: stateProjectId } = consumeOAuthSession(state)
  const { clientId, clientSecret } = await getAntigravityOAuthCredentials()

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'User-Agent': GEMINI_USER_AGENT
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code_verifier: verifier
    })
  })

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text()
    throw new Error(`OAuth token exchange failed: ${errorText.slice(0, 200)}`)
  }

  const tokenPayload = (await tokenResponse.json()) as {
    access_token?: string
    refresh_token?: string
  }

  if (!tokenPayload.refresh_token) {
    throw new Error('Google không trả về refresh token. Thử đăng nhập lại và chọn "Cho phép".')
  }

  let email: string | undefined
  if (tokenPayload.access_token) {
    const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
      headers: {
        Authorization: `Bearer ${tokenPayload.access_token}`,
        'User-Agent': GEMINI_USER_AGENT
      }
    })
    if (userInfoResponse.ok) {
      const userInfo = (await userInfoResponse.json()) as { email?: string }
      email = userInfo.email
    }
  }

  let projectId = stateProjectId
  if (!projectId && tokenPayload.access_token) {
    projectId = await fetchProjectId(tokenPayload.access_token)
  }

  return {
    email,
    refreshToken: tokenPayload.refresh_token,
    projectId: projectId || undefined,
    enabled: true
  }
}

interface OAuthCallbackServer {
  redirectUri: string
  waitForCallback: Promise<{ code: string; state: string }>
  close: () => void
}

function startOAuthCallbackServer(expectedState: string): Promise<OAuthCallbackServer> {
  return new Promise((resolveReady, rejectReady) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    let resolveCallback!: (value: { code: string; state: string }) => void
    let rejectCallback!: (reason: Error) => void

    const waitForCallback = new Promise<{ code: string; state: string }>((resolve, reject) => {
      resolveCallback = resolve
      rejectCallback = reject
    })
    void waitForCallback.catch(() => {})

    const server = createServer((request, response) => {
      const finish = (error: Error | null, value?: { code: string; state: string }): void => {
        if (settled) return
        settled = true
        if (timeout) clearTimeout(timeout)
        server.close()
        if (error) {
          rejectCallback(error)
        } else if (value) {
          resolveCallback(value)
        }
      }

      try {
        const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
        if (requestUrl.pathname !== OAUTH_CALLBACK_PATH) {
          response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          response.end('Not found')
          return
        }

        const error = requestUrl.searchParams.get('error')
        if (error) {
          response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
          response.end('Đăng nhập thất bại: Không thể hoàn tất xác thực Google.')
          finish(new Error(`Google OAuth error: ${error.slice(0, 200)}`))
          return
        }

        const code = requestUrl.searchParams.get('code')
        const state = requestUrl.searchParams.get('state')
        if (!code || !state) {
          response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
          response.end('Yêu cầu xác thực không hợp lệ: thiếu code hoặc state.')
          finish(new Error('OAuth callback thiếu code hoặc state'))
          return
        }

        if (state !== expectedState) {
          response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
          response.end('Yêu cầu xác thực không hợp lệ.')
          finish(new Error('OAuth state không khớp'))
          return
        }

        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(
          '<h2>Đăng nhập Antigravity thành công</h2><p>Bạn có thể đóng tab này và quay lại AI Switcher.</p>'
        )
        finish(null, { code, state })
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error))
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('Yêu cầu xác thực không hợp lệ.')
        finish(normalized)
      }
    })

    server.once('error', (error) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      const wrapped = new Error(`Không thể mở cổng OAuth cục bộ: ${error.message}`)
      rejectReady(wrapped)
      rejectCallback(wrapped)
    })

    server.listen(0, '127.0.0.1', () => {
      if (settled) return

      const address = server.address()
      if (!address || typeof address === 'string') {
        settled = true
        const error = new Error('Không xác định được cổng OAuth cục bộ')
        server.close()
        rejectReady(error)
        rejectCallback(error)
        return
      }

      const redirectUri = `http://127.0.0.1:${address.port}${OAUTH_CALLBACK_PATH}`
      timeout = setTimeout(() => {
        if (settled) return
        settled = true
        server.close()
        rejectCallback(new Error('Hết thời gian chờ đăng nhập Google (5 phút)'))
      }, OAUTH_CALLBACK_TIMEOUT_MS)

      resolveReady({
        redirectUri,
        waitForCallback,
        close: () => {
          if (settled) return
          settled = true
          if (timeout) clearTimeout(timeout)
          server.close()
          rejectCallback(new Error('Đã hủy đăng nhập Google'))
        }
      })
    })
  })
}

export async function runAntigravityOAuthLogin(): Promise<AntigravityAccountEntry> {
  const { verifier } = generatePkce()
  const state = createOAuthSession(verifier)
  let callbackServer: OAuthCallbackServer | undefined

  try {
    callbackServer = await startOAuthCallbackServer(state)
    const authUrl = await buildAuthorizationUrl(verifier, state, callbackServer.redirectUri)
    await shell.openExternal(authUrl)

    const { code, state: callbackState } = await callbackServer.waitForCallback
    return await exchangeAuthorizationCode(code, callbackState, callbackServer.redirectUri)
  } finally {
    callbackServer?.close()
    pendingOAuthSessions.delete(state)
  }
}
