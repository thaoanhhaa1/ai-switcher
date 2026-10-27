import { unlink } from 'fs/promises'
import { join } from 'path'
import type { CopilotIdeTarget } from './copilot-ide'
import { getAppDataDir } from './paths'
import { getScopedJsonPath } from './safe-path'
import { ensurePrivateDir, readSecureJson, writeSecureJson } from './secure-storage'

export interface CopilotIdeSnapshot {
  username: string
  entries: Record<string, string>
}

export interface CopilotAccountEntry {
  username: string
  snapshots: Partial<Record<CopilotIdeTarget, CopilotIdeSnapshot>>
  capturedAt?: string
  /**
   * GitHub token riêng của slot (device flow, scope read:user) — dùng để đọc
   * quota đúng account thay vì token machine-level (gh CLI). Optional: slot
   * cũ chỉ import từ VS Code sẽ không có và dùng fallback machine token.
   */
  githubToken?: string
  githubLogin?: string
}

function getStorageDir(): string {
  return join(getAppDataDir(), 'copilot-auth')
}

export function getStoredCopilotPath(accountId: string): string {
  return getScopedJsonPath(getStorageDir(), accountId)
}

export async function saveStoredCopilotAccount(
  accountId: string,
  entry: CopilotAccountEntry
): Promise<void> {
  await ensurePrivateDir(getStorageDir())
  await writeSecureJson(getStoredCopilotPath(accountId), {
    ...entry,
    capturedAt: entry.capturedAt ?? new Date().toISOString()
  })
}

export async function loadStoredCopilotAccount(
  accountId: string
): Promise<CopilotAccountEntry | null> {
  try {
    return await readSecureJson<CopilotAccountEntry>(getStoredCopilotPath(accountId))
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
