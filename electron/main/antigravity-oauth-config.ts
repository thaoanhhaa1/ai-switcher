const UPSTREAM_CONSTANTS_URL =
  'https://raw.githubusercontent.com/NoeFabris/opencode-antigravity-auth/main/src/constants.ts'

export interface AntigravityOAuthCredentials {
  clientId: string
  clientSecret: string
}

let cachedCredentials: AntigravityOAuthCredentials | null = null

function credentialsFromEnv(): AntigravityOAuthCredentials | null {
  const clientId = process.env.ANTIGRAVITY_CLIENT_ID?.trim()
  const clientSecret = process.env.ANTIGRAVITY_CLIENT_SECRET?.trim()
  if (!clientId || !clientSecret) {
    return null
  }
  return { clientId, clientSecret }
}

function parseUpstreamConstants(source: string): AntigravityOAuthCredentials {
  const clientIdMatch = source.match(/ANTIGRAVITY_CLIENT_ID\s*=\s*"([^"]+)"/)
  const clientSecretMatch = source.match(/ANTIGRAVITY_CLIENT_SECRET\s*=\s*"([^"]+)"/)

  const clientId = clientIdMatch?.[1]?.trim()
  const clientSecret = clientSecretMatch?.[1]?.trim()
  if (!clientId || !clientSecret) {
    throw new Error('Không đọc được Antigravity OAuth credentials từ upstream constants.ts')
  }

  return { clientId, clientSecret }
}

async function fetchUpstreamCredentials(): Promise<AntigravityOAuthCredentials> {
  const response = await fetch(UPSTREAM_CONSTANTS_URL, {
    signal: AbortSignal.timeout(10_000)
  })
  if (!response.ok) {
    throw new Error(
      `Không tải được Antigravity OAuth credentials (HTTP ${response.status}). ` +
        'Đặt ANTIGRAVITY_CLIENT_ID và ANTIGRAVITY_CLIENT_SECRET trong .env, ' +
        'hoặc xem opencode-antigravity-auth/src/constants.ts.'
    )
  }

  return parseUpstreamConstants(await response.text())
}

export async function getAntigravityOAuthCredentials(): Promise<AntigravityOAuthCredentials> {
  if (cachedCredentials) {
    return cachedCredentials
  }

  const fromEnv = credentialsFromEnv()
  if (fromEnv) {
    cachedCredentials = fromEnv
    return fromEnv
  }

  cachedCredentials = await fetchUpstreamCredentials()
  return cachedCredentials
}
