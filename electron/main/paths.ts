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
