import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

function parseEnvFile(content: string): void {
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const separator = trimmed.indexOf('=')
    if (separator === -1) continue

    const key = trimmed.slice(0, separator).trim()
    if (!key || key in process.env) continue

    let value = trimmed.slice(separator + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    process.env[key] = value
  }
}

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return
  parseEnvFile(readFileSync(path, 'utf-8'))
}

export function loadProjectEnv(): void {
  const root = resolve(__dirname, '../..')
  const mode =
    process.env.NODE_ENV === 'production' ||
    process.env.NODE_ENV_ELECTRON_VITE === 'production'
      ? 'production'
      : 'development'

  loadEnvFile(resolve(root, '.env'))
  loadEnvFile(resolve(root, `.env.${mode}`))
  loadEnvFile(resolve(root, '.env.local'))
}

loadProjectEnv()
