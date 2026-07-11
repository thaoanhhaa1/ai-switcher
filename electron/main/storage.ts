import { mkdir, readFile, writeFile, access } from 'fs/promises'
import { constants } from 'fs'
import { v4 as uuidv4 } from 'uuid'
import type { Account, AppData, UsageEvent } from '../../src/types'
import { getAppDataDir, getAppDataPath } from './paths'

const DEFAULT_DATA: AppData = {
  version: 1,
  activeAccountId: null,
  accounts: [],
  usageLog: []
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function loadAppData(): Promise<AppData> {
  const path = getAppDataPath()
  if (!(await fileExists(path))) {
    return structuredClone(DEFAULT_DATA)
  }

  const raw = await readFile(path, 'utf-8')
  const parsed = JSON.parse(raw) as AppData
  return {
    version: parsed.version ?? 1,
    activeAccountId: parsed.activeAccountId ?? null,
    accounts: parsed.accounts ?? [],
    usageLog: parsed.usageLog ?? []
  }
}

export async function saveAppData(data: AppData): Promise<void> {
  await mkdir(getAppDataDir(), { recursive: true })
  await writeFile(getAppDataPath(), JSON.stringify(data, null, 2), 'utf-8')
}

export async function appendUsageEvent(
  data: AppData,
  event: Omit<UsageEvent, 'id' | 'timestamp'>
): Promise<AppData> {
  const usageEvent: UsageEvent = {
    ...event,
    id: uuidv4(),
    timestamp: new Date().toISOString()
  }

  const next: AppData = {
    ...data,
    usageLog: [usageEvent, ...data.usageLog].slice(0, 200)
  }

  await saveAppData(next)
  return next
}

export function findAccount(data: AppData, id: string): Account | undefined {
  return data.accounts.find((account) => account.id === id)
}
