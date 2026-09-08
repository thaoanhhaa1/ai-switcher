import { randomUUID } from 'crypto'

const GITHUB_BASE_URL = 'https://github.com'

/**
 * OAuth client_id của VS Code Copilot plugin (public information, được các tool
 * open-source như copilot-api dùng chung). Chỉ dùng cho device flow scope
 * `read:user` — đọc quota Copilot per-slot, KHÔNG có quyền repo.
 */
const DEFAULT_COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98'

function getDeviceFlowClientId(): string {
  return process.env.COPILOT_DEVICE_FLOW_CLIENT_ID?.trim() || DEFAULT_COPILOT_CLIENT_ID
}

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

export interface GithubTokenResult {
  accessToken: string
  login?: string
  scopes?: string
}

const standardHeaders = {
  'content-type': 'application/json',
  accept: 'application/json'
}

/**
 * GitHub OAuth device flow (RFC 8628) với client_id của VS Code Copilot plugin
 * (cùng client_id mà copilot-api và các tool tương tự dùng — public information).
 * Scope tối thiểu: read:user. KHÔNG xin repo/workflow.
 */
export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const response = await fetch(`${GITHUB_BASE_URL}/login/device/code`, {
    method: 'POST',
    headers: standardHeaders,
    body: JSON.stringify({
      client_id: getDeviceFlowClientId(),
      scope: 'read:user'
    })
  })

  if (!response.ok) {
    throw new Error(`Không lấy được device code (HTTP ${response.status})`)
  }

  return (await response.json()) as DeviceCodeResponse
}

export async function pollForToken(
  deviceCode: string,
  intervalSeconds: number,
  signal?: AbortSignal
): Promise<GithubTokenResult> {
  let currentInterval = Math.max(intervalSeconds, 1) * 1000

  while (!signal?.aborted) {
    await new Promise((resolve) => setTimeout(resolve, currentInterval))
    if (signal?.aborted) break

    let payload: {
      access_token?: string
      error?: string
      error_description?: string
      interval?: number
    }
    try {
      const response = await fetch(`${GITHUB_BASE_URL}/login/oauth/access_token`, {
        method: 'POST',
        headers: standardHeaders,
        body: JSON.stringify({
          client_id: getDeviceFlowClientId(),
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        })
      })
      payload = (await response.json()) as typeof payload
    } catch (error) {
      // lỗi mạng tạm thời: thử lại tới khi device code hết hạn
      if (signal?.aborted) break
      continue
    }

    if (payload.access_token) {
      const login = await fetchLogin(payload.access_token).catch(() => undefined)
      return { accessToken: payload.access_token, login }
    }

    if (payload.error === 'authorization_pending') {
      const slower = payload.interval ? payload.interval * 1000 : null
      if (slower && slower > currentInterval) currentInterval = slower
      continue
    }

    if (payload.error === 'slow_down') {
      currentInterval += 5000
      continue
    }

    if (payload.error === 'expired_token') {
      throw new Error('Device code đã hết hạn. Hãy thử đăng nhập lại.')
    }

    if (payload.error === 'unsupported_grant_type' || payload.error === 'incorrect_client_credentials') {
      throw new Error(payload.error_description ?? 'GitHub từ chối device flow')
    }

    // lỗi khác (vd access_denied)
    if (payload.error) {
      throw new Error(payload.error_description ?? `GitHub trả lỗi: ${payload.error}`)
    }
  }

  throw new Error('Đã hủy đăng nhập GitHub')
}

async function fetchLogin(accessToken: string): Promise<string | undefined> {
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `token ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': 'GitHubCopilotChat/0.26.0'
      }
    })
    if (!response.ok) return undefined
    const data = (await response.json()) as { login?: string }
    return data.login
  } catch {
    return undefined
  }
}

export function newRequestId(): string {
  return randomUUID()
}
