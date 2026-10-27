import { readFile, unlink } from 'fs/promises'
import { join } from 'path'
import { getAppDataDir, getCodexAuthPath } from './paths'
import { getScopedJsonPath } from './safe-path'
import {
  ensurePrivateDir,
  readSecureJson,
  writePrivateFile,
  writeSecureJson
} from './secure-storage'

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
  return getScopedJsonPath(getAuthStorageDir(), accountId)
}

export async function saveStoredAuth(accountId: string, auth: CodexAuthJson): Promise<void> {
  await ensurePrivateDir(getAuthStorageDir())
  await writeSecureJson(getStoredAuthPath(accountId), auth)
}

export async function loadStoredAuth(accountId: string): Promise<CodexAuthJson | null> {
  try {
    return await readSecureJson<CodexAuthJson>(getStoredAuthPath(accountId))
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
  await writePrivateFile(getCodexAuthPath(), JSON.stringify(auth, null, 2))
}

export function isChatGptAuth(auth: CodexAuthJson | null): auth is CodexAuthJson & { tokens: CodexAuthTokens } {
  return Boolean(auth?.tokens?.access_token && auth?.tokens?.account_id)
}

export function normalizeChatGptAuthForLive(
  auth: CodexAuthJson & { tokens: CodexAuthTokens }
): CodexAuthJson {
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: auth.tokens.id_token,
      access_token: auth.tokens.access_token,
      refresh_token: auth.tokens.refresh_token,
      account_id: auth.tokens.account_id
    },
    last_refresh: auth.last_refresh ?? new Date().toISOString()
  }
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
