import { app } from 'electron'
import { homedir } from 'os'
import { join } from 'path'

export type AppEnv = 'development' | 'production'

let cachedEnv: AppEnv | null = null

function normalizeEnv(value: string | undefined): AppEnv | null {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'development' || normalized === 'dev') {
    return 'development'
  }
  if (normalized === 'production' || normalized === 'prod') {
    return 'production'
  }
  return null
}

export function getAppEnv(): AppEnv {
  if (cachedEnv) {
    return cachedEnv
  }

  const override = normalizeEnv(process.env.AI_SWITCHER_ENV)
  if (override) {
    cachedEnv = override
    return cachedEnv
  }

  try {
    cachedEnv = app.isPackaged ? 'production' : 'development'
  } catch {
    cachedEnv = process.env.ELECTRON_RENDERER_URL ? 'development' : 'production'
  }

  return cachedEnv
}

export function isDev(): boolean {
  return getAppEnv() === 'development'
}

export function isProd(): boolean {
  return getAppEnv() === 'production'
}

export function getAppDataDirName(): string {
  return isDev() ? '.ai-switcher-dev' : '.ai-switcher'
}

export function getDefaultAppDataDir(): string {
  return join(homedir(), getAppDataDirName())
}

export function shouldApplyAntigravityIde(): boolean {
  if (isProd()) {
    return true
  }

  const flag = process.env.AI_SWITCHER_APPLY_ANTIGRAVITY_IDE?.trim().toLowerCase()
  return flag === '1' || flag === 'true' || flag === 'yes'
}

export function shouldApplyCopilotIde(): boolean {
  if (isProd()) {
    return true
  }

  const flag = process.env.AI_SWITCHER_APPLY_COPILOT_IDE?.trim().toLowerCase()
  return flag === '1' || flag === 'true' || flag === 'yes'
}

export interface AppRuntimeInfo {
  env: AppEnv
  appDataDir: string
  codexHome: string
  opencodeConfigDir: string
  applyAntigravityIde: boolean
  applyCopilotIde: boolean
}
