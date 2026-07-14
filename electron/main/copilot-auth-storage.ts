import { mkdir, readFile, unlink, writeFile, chmod } from 'fs/promises'
import { join } from 'path'
import type { CopilotIdeTarget } from './copilot-ide'
import { getAppDataDir } from './paths'

export interface CopilotIdeSnapshot {
  username: string
  entries: Record<string, string>
}

export interface CopilotAccountEntry {
  username: string
  snapshots: Partial<Record<CopilotIdeTarget, CopilotIdeSnapshot>>
  capturedAt?: string
}

function getStorageDir(): string {
  return join(getAppDataDir(), 'copilot-auth')
}

export function getStoredCopilotPath(accountId: string): string {
  return join(getStorageDir(), `${accountId}.json`)
}

export async function saveStoredCopilotAccount(
  accountId: string,
  entry: CopilotAccountEntry
): Promise<void> {
  await mkdir(getStorageDir(), { recursive: true })
  const path = getStoredCopilotPath(accountId)
  await writeFile(
    path,
    JSON.stringify(
      {
        ...entry,
        capturedAt: entry.capturedAt ?? new Date().toISOString()
      },
      null,
      2
    ),
    { mode: 0o600 }
  )
  await chmod(path, 0o600)
}

export async function loadStoredCopilotAccount(
  accountId: string
): Promise<CopilotAccountEntry | null> {
  try {
    const raw = await readFile(getStoredCopilotPath(accountId), 'utf-8')
    return JSON.parse(raw) as CopilotAccountEntry
  } catch {
    return null
  }
}

export async function deleteStoredCopilotAccount(accountId: string): Promise<void> {
  try {
    await unlink(getStoredCopilotPath(accountId))
  } catch {
    // ignore
  }
}

export function isValidCopilotEntry(
  entry: CopilotAccountEntry | null | undefined
): entry is CopilotAccountEntry {
  if (!entry?.username?.trim()) return false
  return Object.values(entry.snapshots ?? {}).some(
    (snapshot) => snapshot && Object.keys(snapshot.entries).length > 0
  )
}

export function mergeCopilotSnapshots(
  current: Partial<Record<CopilotIdeTarget, CopilotIdeSnapshot>>,
  incoming: Partial<Record<CopilotIdeTarget, CopilotIdeSnapshot>>
): Partial<Record<CopilotIdeTarget, CopilotIdeSnapshot>> {
  return {
    ...current,
    ...incoming
  }
}
