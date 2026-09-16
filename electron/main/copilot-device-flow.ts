const GITHUB_BASE_URL = 'https://github.com'

/**
 * Convention message khi user chủ động hủy device flow — waitForCopilotDeviceLogin
 * (github-copilot.ts) và dialog (CopilotLoginDialog.tsx) cùng so khớp chuỗi này
 * để phân biệt "hủy do abort" với lỗi thật. KHÔNG import value này qua ranh giới
 * IPC (main↔renderer) — 2 consumer giữ literal + trỏ về constant này khi cần đổi.
 */
export const COPILOT_DEVICE_FLOW_CANCELLED = 'Đã hủy đăng nhập GitHub'

/**
 * Timeout cho các request một lần (device code / verify /user). R6 L5: fetch
 * không timeout mặc định — mạng chết treo fetch vô thời hạn, kẹt dialog ở
 * trạng thái "đang mở github.com" không thoát được.
 */
const REQUEST_TIMEOUT_MS = 15_000

/** Kết hợp signal user-cancel với timeout mạng thành 1 signal cho fetch. */
function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

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
  /**
   * true khi GitHub `/user` xác minh được chủ token (CODE_REVIEW N2).
   * false khi không gọi được /user (mạng lỗi/rate limit) — caller KHÔNG được
   * suy ra token thuộc về username của slot.
   */
  loginVerified: boolean
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
export async function requestDeviceCode(signal?: AbortSignal): Promise<DeviceCodeResponse> {
  let response
  try {
    response = await fetch(`${GITHUB_BASE_URL}/login/device/code`, {
      method: 'POST',
      headers: standardHeaders,
      body: JSON.stringify({
        client_id: getDeviceFlowClientId(),
        scope: 'read:user'
      }),
      signal: withTimeout(signal)
    })
  } catch (error) {
    // R6 L5: lỗi timeout/abort phải là message tiếng Việt rõ ràng (abort user
    // dùng đúng convention 'Đã hủy đăng nhập GitHub' mà dialog so khớp).
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw new Error(COPILOT_DEVICE_FLOW_CANCELLED)
    }
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error('Không kết nối được github.com (hết thời gian chờ). Kiểm tra mạng rồi thử lại.')
    }
    throw error instanceof Error ? error : new Error(String(error))
  }

  if (!response.ok) {
    throw new Error(`Không lấy được device code (HTTP ${response.status})`)
  }

  return (await response.json()) as DeviceCodeResponse
}

/** Sleep có thể bị abort ngay (R6 L5): cancel không phải chờ hết interval. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function pollForToken(
  deviceCode: string,
  intervalSeconds: number,
  signal?: AbortSignal
): Promise<GithubTokenResult> {
  let currentInterval = Math.max(intervalSeconds, 1) * 1000

  while (!signal?.aborted) {
    await abortableSleep(currentInterval, signal)
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
        }),
        signal: withTimeout(signal)
      })
      payload = (await response.json()) as typeof payload
    } catch (error) {
      // R6 L5: signal bị abort giữa fetch → thoát loop ngay (ném 'Đã hủy')
      // thay vì đợi vòng poll kế tiếp.
      if (signal?.aborted) break
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error('Không kết nối được github.com (hết thời gian chờ). Kiểm tra mạng rồi thử lại.')
      }
      // lỗi mạng tạm thời: thử lại tới khi device code hết hạn
      continue
    }

    if (payload.access_token) {
      const identity = await fetchLogin(payload.access_token, signal)
      return {
        accessToken: payload.access_token,
        login: identity.login,
        loginVerified: identity.verified
      }
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
      // N3: kèm client_id đang dùng + cách override — khi GitHub đổi/suspend
      // client_id của Copilot plugin, user/tooling có thể tự trỏ client_id khác.
      throw new Error(
        `${payload.error_description ?? 'GitHub từ chối device flow'} (client_id: ${getDeviceFlowClientId()}; ` +
          `nếu client_id bị thu hồi, đặt env COPILOT_DEVICE_FLOW_CLIENT_ID)`
      )
    }

    // lỗi khác (vd access_denied)
    if (payload.error) {
      throw new Error(payload.error_description ?? `GitHub trả lỗi: ${payload.error}`)
    }
  }

  throw new Error(COPILOT_DEVICE_FLOW_CANCELLED)
}

/**
 * Gọi GitHub `/user` để xác minh chủ token. KHÔNG ném lỗi — trả `verified: false`
 * để caller phân biệt "không xác minh được" với "xác minh được nhưng login khác"
 * (CODE_REVIEW N2 — trước đây lỗi mạng bị silent catch thành login undefined).
 */
async function fetchLogin(
  accessToken: string,
  signal?: AbortSignal
): Promise<{ login?: string; verified: boolean }> {
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `token ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': 'GitHubCopilotChat/0.26.0'
      },
      signal: withTimeout(signal)
    })
    if (!response.ok) return { verified: false }
    const data = (await response.json()) as { login?: string }
    return data.login ? { login: data.login, verified: true } : { verified: false }
  } catch {
    return { verified: false }
  }
}
