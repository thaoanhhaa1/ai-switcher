import { createHash, randomBytes } from 'crypto'
import { createServer } from 'http'
import { shell } from 'electron'
import type { AntigravityAccountEntry } from './antigravity-auth-storage'

const CLIENT_ID = 'REDACTED_ANTIGRAVITY_CLIENT_ID'
const CLIENT_SECRET = 'REDACTED_ANTIGRAVITY_CLIENT_SECRET'
const REDIRECT_URI = 'http://localhost:51121/oauth-callback'
const OAUTH_PORT = 51121
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

interface PkceState {
  verifier: string
  projectId: string
}

function encodeState(payload: PkceState): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function decodeState(state: string): PkceState {
  const normalized = state.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=')
  const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as PkceState
  if (!parsed.verifier) {
    throw new Error('Missing PKCE verifier in OAuth state')
  }
  return parsed
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

function buildAuthorizationUrl(verifier: string, projectId = ''): string {
  const challenge = createHash('sha256').update(verifier).digest('base64url')

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('scope', SCOPES.join(' '))
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', encodeState({ verifier, projectId }))
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

      if (typeof data.cloudaicompanionProject === 'string' && data.cloudaicompanionProject) {
        return data.cloudaicompanionProject
      }
      if (
        data.cloudaicompanionProject &&
        typeof data.cloudaicompanionProject.id === 'string' &&
        data.cloudaicompanionProject.id
      ) {
        return data.cloudaicompanionProject.id
      }
    } catch {
      // try next endpoint
    }
  }

  return ''
}

async function exchangeAuthorizationCode(code: string, state: string): Promise<AntigravityAccountEntry> {
  const { verifier, projectId: stateProjectId } = decodeState(state)

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'User-Agent': GEMINI_USER_AGENT
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
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

function waitForOAuthCallback(): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      try {
        const requestUrl = new URL(request.url ?? '/', `http://127.0.0.1:${OAUTH_PORT}`)
        if (requestUrl.pathname !== '/oauth-callback') {
          response.writeHead(404)
          response.end('Not found')
          return
        }

        const error = requestUrl.searchParams.get('error')
        if (error) {
          response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          response.end(`<h2>Đăng nhập thất bại</h2><p>${error}</p>`)
          server.close()
          reject(new Error(`Google OAuth error: ${error}`))
          return
        }

        const code = requestUrl.searchParams.get('code')
        const state = requestUrl.searchParams.get('state')
        if (!code || !state) {
          response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          response.end('<h2>Thiếu mã xác thực</h2>')
          server.close()
          reject(new Error('OAuth callback thiếu code hoặc state'))
          return
        }

        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(
          '<h2>Đăng nhập Antigravity thành công</h2><p>Bạn có thể đóng tab này và quay lại AI Switcher.</p>'
        )
        server.close()
        resolve({ code, state })
      } catch (error) {
        server.close()
        reject(error)
      }
    })

    server.on('error', (error) => {
      reject(
        new Error(
          `Không thể mở cổng OAuth ${OAUTH_PORT}: ${error.message}. Đóng tiến trình đang dùng cổng này rồi thử lại.`
        )
      )
    })

    server.listen(OAUTH_PORT, '127.0.0.1')

    setTimeout(() => {
      server.close()
      reject(new Error('Hết thời gian chờ đăng nhập Google (5 phút)'))
    }, 5 * 60 * 1000)
  })
}

export async function runAntigravityOAuthLogin(): Promise<AntigravityAccountEntry> {
  const { verifier } = generatePkce()
  const authUrl = buildAuthorizationUrl(verifier)

  const callbackPromise = waitForOAuthCallback()
  await shell.openExternal(authUrl)

  const { code, state } = await callbackPromise
  return exchangeAuthorizationCode(code, state)
}
