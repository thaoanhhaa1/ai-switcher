import { access, constants, readdir } from 'fs/promises'
import { spawn } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'

const CODEX_NOT_FOUND_MESSAGE =
  'Không tìm thấy Codex CLI. Cài: npm install -g @openai/codex — hoặc dùng Import từ ~/.codex / chọn file auth.json.'

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function listNvmCodexPaths(): Promise<string[]> {
  const nvmRoot = join(homedir(), '.nvm/versions/node')
  try {
    const versions = await readdir(nvmRoot)
    return versions.map((version) => join(nvmRoot, version, 'bin/codex'))
  } catch {
    return []
  }
}

function getCodexCliCandidates(): string[] {
  const home = homedir()
  return [
    join(home, '.codex/plugins/.plugin-appserver/codex'),
    join(home, '.local/bin/codex'),
    join(home, '.cargo/bin/codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex'
  ]
}

function whichViaShell(): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const child = spawn('where', ['codex'], { env: process.env })
      let output = ''
      child.stdout.on('data', (chunk) => {
        output += String(chunk)
      })
      child.on('close', (code) => {
        if (code !== 0) {
          resolve(null)
          return
        }
        const line = output.trim().split(/\r?\n/)[0]?.trim()
        resolve(line || null)
      })
      child.on('error', () => resolve(null))
      return
    }

    const shell = process.env.SHELL ?? '/bin/zsh'
    const child = spawn(shell, ['-ilc', 'command -v codex'], { env: process.env })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
    })
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(null)
        return
      }
      const line = output.trim().split(/\r?\n/)[0]?.trim()
      resolve(line || null)
    })
    child.on('error', () => resolve(null))
  })
}

export async function resolveCodexCli(): Promise<string> {
  if (process.env.CODEX_CLI_PATH) {
    if (await isExecutable(process.env.CODEX_CLI_PATH)) {
      return process.env.CODEX_CLI_PATH
    }
    throw new Error(`CODEX_CLI_PATH không hợp lệ: ${process.env.CODEX_CLI_PATH}`)
  }

  const fromShell = await whichViaShell()
  if (fromShell && (await isExecutable(fromShell))) {
    return fromShell
  }

  for (const candidate of [...getCodexCliCandidates(), ...(await listNvmCodexPaths())]) {
    if (await isExecutable(candidate)) {
      return candidate
    }
  }

  throw new Error(CODEX_NOT_FOUND_MESSAGE)
}

export async function runCodexLogin(codexHome: string): Promise<void> {
  const codexPath = await resolveCodexCli()

  await new Promise<void>((resolve, reject) => {
    const child = spawn(codexPath, ['login'], {
      env: {
        ...process.env,
        CODEX_HOME: codexHome
      },
      stdio: 'inherit'
    })

    child.on('error', (error) => {
      reject(new Error(`Không thể chạy Codex CLI (${codexPath}): ${error.message}`))
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`codex login thoát với mã ${code ?? 'unknown'}`))
    })
  })
}
