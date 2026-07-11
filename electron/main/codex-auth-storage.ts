import { mkdir, readFile, unlink, writeFile, chmod } from 'fs/promises'
import { join } from 'path'
import { getAppDataDir, getCodexAuthPath } from './paths'

export interface CodexAuthTokens {
  id_token: string
  access_token: string
  refresh_token: string
  account_id: string
}

export interface CodexAuthJson {
  auth_mode?: string
  OPENAI_API_KEY?: string | null
  tokens?: CodexAuthTokens
  last_refresh?: string
}

export interface ChatGptIdentity {
  email?: string
  accountId?: string
  planType?: string
  userId?: string
}

function getAuthStorageDir(): string {
  return join(getAppDataDir(), 'codex-auth')
}

export function getStoredAuthPath(accountId: string): string {
  return join(getAuthStorageDir(), `${accountId}.json`)
}

export async function saveStoredAuth(accountId: string, auth: CodexAuthJson): Promise<void> {
  await mkdir(getAuthStorageDir(), { recursive: true })
  const path = getStoredAuthPath(accountId)
  await writeFile(path, JSON.stringify(auth, null, 2), { mode: 0o600 })
  await chmod(path, 0o600)
}

export async function loadStoredAuth(accountId: string): Promise<CodexAuthJson | null> {
  try {
    const raw = await readFile(getStoredAuthPath(accountId), 'utf-8')
    return JSON.parse(raw) as CodexAuthJson
  } catch {
    return null
  }
}

export async function deleteStoredAuth(accountId: string): Promise<void> {
  try {
    await unlink(getStoredAuthPath(accountId))
  } catch {
    // ignore
  }
}

export async function readLiveAuth(): Promise<CodexAuthJson | null> {
  try {
    const raw = await readFile(getCodexAuthPath(), 'utf-8')
    return JSON.parse(raw) as CodexAuthJson
  } catch {
    return null
  }
}

export async function writeLiveAuth(auth: CodexAuthJson): Promise<void> {
  const path = getCodexAuthPath()
  await writeFile(path, JSON.stringify(auth, null, 2), { mode: 0o600 })
  await chmod(path, 0o600)
}

export function isChatGptAuth(auth: CodexAuthJson | null): auth is CodexAuthJson & { tokens: CodexAuthTokens } {
  return Boolean(auth?.tokens?.access_token && auth?.tokens?.account_id)
}

export function parseChatGptIdentity(auth: CodexAuthJson): ChatGptIdentity {
  if (!auth.tokens?.id_token) {
    return {
      accountId: auth.tokens?.account_id
    }
  }

  try {
    const payload = parseJwtPayload(auth.tokens.id_token)
    return {
      email: typeof payload.email === 'string' ? payload.email : undefined,
      accountId:
        (typeof payload.chatgpt_account_id === 'string' ? payload.chatgpt_account_id : undefined) ??
        auth.tokens.account_id,
      planType:
        typeof payload.chatgpt_plan_type === 'string' ? payload.chatgpt_plan_type : undefined,
      userId: typeof payload.chatgpt_user_id === 'string' ? payload.chatgpt_user_id : undefined
    }
  } catch {
    return {
      accountId: auth.tokens.account_id
    }
  }
}

function parseJwtPayload(token: string): Record<string, unknown> {
  const part = token.split('.')[1]
  if (!part) return {}
  const normalized = part.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=')
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8')) as Record<string, unknown>
}
