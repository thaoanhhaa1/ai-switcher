import { mkdir, readFile, unlink, writeFile, chmod } from 'fs/promises'
import { dirname, join } from 'path'
import { getAppDataDir, getAntigravityAccountsPath } from './paths'
import { getScopedJsonPath } from './safe-path'
import { ensurePrivateDir, readSecureJson, writeSecureJson } from './secure-storage'

export interface AntigravityAccountEntry {
  email?: string
  refreshToken: string
  projectId?: string
  managedProjectId?: string
  enabled?: boolean
}

export interface AntigravityAccountsFile {
  version?: number
  accounts: AntigravityAccountEntry[]
  activeIndex?: number
  activeIndexByFamily?: {
    claude?: number
    gemini?: number
  }
}

function getStorageDir(): string {
  return join(getAppDataDir(), 'antigravity-auth')
}

export function getStoredAntigravityPath(accountId: string): string {
  return getScopedJsonPath(getStorageDir(), accountId)
}

export async function saveStoredAntigravityAccount(
  accountId: string,
  entry: AntigravityAccountEntry
): Promise<void> {
  await ensurePrivateDir(getStorageDir())
  await writeSecureJson(getStoredAntigravityPath(accountId), entry)
}

export async function loadStoredAntigravityAccount(
  accountId: string
): Promise<AntigravityAccountEntry | null> {
  try {
    return await readSecureJson<AntigravityAccountEntry>(
      getStoredAntigravityPath(accountId)
    )
  } catch {
    return null
  }
}

export async function deleteStoredAntigravityAccount(accountId: string): Promise<void> {
  try {
    await unlink(getStoredAntigravityPath(accountId))
  } catch {
    // ignore
  }
}

export async function readLiveAntigravityAccounts(): Promise<AntigravityAccountsFile | null> {
  try {
    const raw = await readFile(getAntigravityAccountsPath(), 'utf-8')
    return JSON.parse(raw) as AntigravityAccountsFile
  } catch {
    return null
  }
}

export async function writeLiveAntigravityAccounts(data: AntigravityAccountsFile): Promise<void> {
  const path = getAntigravityAccountsPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    JSON.stringify(
      {
        version: data.version ?? 3,
        ...data
      },
      null,
      2
    ),
    { mode: 0o600 }
  )
  await chmod(path, 0o600)
}

export function normalizeAntigravityEntry(entry: AntigravityAccountEntry): AntigravityAccountEntry {
  if (!entry.refreshToken.includes('|')) {
    return entry
  }

  const [refreshToken, embeddedProjectId] = entry.refreshToken.split('|', 2)
  return {
    ...entry,
    refreshToken,
    projectId: entry.projectId ?? (embeddedProjectId || undefined)
  }
}

export function isValidAntigravityEntry(
  entry: AntigravityAccountEntry | null | undefined
): entry is AntigravityAccountEntry {
  return Boolean(normalizeAntigravityEntry(entry ?? { refreshToken: '' }).refreshToken?.trim())
}

export function findAccountIndexByEmail(
  data: AntigravityAccountsFile,
  email?: string
): number {
  if (!email) return -1
  return data.accounts.findIndex(
    (account) => account.email?.toLowerCase() === email.toLowerCase()
  )
}

export function mergeAccountEntry(
  accounts: AntigravityAccountEntry[],
  entry: AntigravityAccountEntry
): AntigravityAccountEntry[] {
  const index = findAccountIndexByEmail({ accounts }, entry.email)
  if (index >= 0) {
    return accounts.map((item, itemIndex) =>
      itemIndex === index ? { ...item, ...entry } : item
    )
  }
  return [...accounts, entry]
}
