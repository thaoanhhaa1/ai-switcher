import { homedir } from 'os'
import { join } from 'path'

export function getAppDataDir(): string {
  return join(homedir(), '.ai-switcher')
}

export function getAppDataPath(): string {
  return join(getAppDataDir(), 'data.json')
}

export function getCodexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex')
}

export function getCodexAuthPath(): string {
  return join(getCodexHome(), 'auth.json')
}

export function getCodexConfigPath(): string {
  return join(getCodexHome(), 'config.toml')
}

export function getOpencodeConfigDir(): string {
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
