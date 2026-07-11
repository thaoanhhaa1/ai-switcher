import { access, constants, readdir } from 'fs/promises'
import { spawn } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'

const OPENCODE_NOT_FOUND_MESSAGE =
  'Không tìm thấy OpenCode CLI. Cài: npm install -g opencode — hoặc import file antigravity-accounts.json.'

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function listNvmBinaryPaths(name: string): Promise<string[]> {
  const nvmRoot = join(homedir(), '.nvm/versions/node')
  try {
    const versions = await readdir(nvmRoot)
    return versions.map((version) => join(nvmRoot, version, 'bin', name))
  } catch {
    return []
  }
}

function getOpencodeCliCandidates(): string[] {
  const home = homedir()
  return [
    join(home, '.local/bin/opencode'),
    join(home, '.cargo/bin/opencode'),
    '/opt/homebrew/bin/opencode',
    '/usr/local/bin/opencode'
  ]
}

function whichViaShell(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const child = spawn('where', [binary], { env: process.env })
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
    const child = spawn(shell, ['-ilc', `command -v ${binary}`], { env: process.env })
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

export async function resolveOpencodeCli(): Promise<string> {
  if (process.env.OPENCODE_CLI_PATH) {
    if (await isExecutable(process.env.OPENCODE_CLI_PATH)) {
      return process.env.OPENCODE_CLI_PATH
    }
    throw new Error(`OPENCODE_CLI_PATH không hợp lệ: ${process.env.OPENCODE_CLI_PATH}`)
  }

  const fromShell = await whichViaShell('opencode')
  if (fromShell && (await isExecutable(fromShell))) {
    return fromShell
  }

  for (const candidate of [...getOpencodeCliCandidates(), ...(await listNvmBinaryPaths('opencode'))]) {
    if (await isExecutable(candidate)) {
      return candidate
    }
  }

  throw new Error(OPENCODE_NOT_FOUND_MESSAGE)
}

export async function runOpencodeAuthLogin(): Promise<void> {
  const opencodePath = await resolveOpencodeCli()

  await new Promise<void>((resolve, reject) => {
    const child = spawn(opencodePath, ['auth', 'login'], {
      env: process.env,
      stdio: 'inherit'
    })

    child.on('error', (error) => {
      reject(new Error(`Không thể chạy OpenCode CLI (${opencodePath}): ${error.message}`))
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`opencode auth login thoát với mã ${code ?? 'unknown'}`))
    })
  })
}
