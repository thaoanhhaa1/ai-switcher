import { homedir } from 'os'
import { join } from 'path'
import { getDefaultAppDataDir, isDev } from './env'

export function getAppDataDir(): string {
  const override = process.env.AI_SWITCHER_DATA_DIR?.trim()
  if (override) {
    return override
  }
  return getDefaultAppDataDir()
}

export function getAppDataPath(): string {
  return join(getAppDataDir(), 'data.json')
}

export function getCodexHome(): string {
  if (process.env.CODEX_HOME?.trim()) {
    return process.env.CODEX_HOME.trim()
  }
  if (isDev()) {
    return join(getAppDataDir(), '.codex')
  }
  return join(homedir(), '.codex')
}

export function getCodexAuthPath(): string {
  return join(getCodexHome(), 'auth.json')
}

export function getCodexConfigPath(): string {
  return join(getCodexHome(), 'config.toml')
}

export function getOpencodeConfigDir(): string {
  if (process.env.OPENCODE_CONFIG_DIR?.trim()) {
    return process.env.OPENCODE_CONFIG_DIR.trim()
  }
  if (isDev()) {
    return join(getAppDataDir(), 'opencode')
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    return join(appData, 'opencode')
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(xdgConfig, 'opencode')
}

export function getAntigravityAccountsPath(): string {
  return join(getOpencodeConfigDir(), 'antigravity-accounts.json')
}

export function getAntigravityConfigPath(): string {
  return join(getOpencodeConfigDir(), 'antigravity.json')
}
