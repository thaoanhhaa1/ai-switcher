import './load-env'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { isDev, shouldApplyAntigravityIde, shouldApplyCopilotIde, type AppRuntimeInfo } from './env'
import {
  addAccount,
  deleteAccount,
  getAccountQuota,
  getAccountsQuota,
  getAccountLoginStatus,
  getChatGptStatus,
  getActiveStatuses,
  getProviderOptions,
  getProviders,
  importChatGptFileAccount,
  importChatGptLiveAccount,
  importAntigravityFileAccount,
  importAntigravityLiveAccount,
  importCopilotFileAccount,
  importCopilotLiveAccount,
  loginAntigravityAccount,
  loginChatGptAccount,
  logoutAccount,
  logoutAntigravityAccount,
  testAntigravityAccountChat,
  logoutChatGptAccount,
  logoutCopilotAccount,
  openAntigravityDir,
  openCodexDir,
  openCopilotDir,
  openDocs,
  pickAntigravityAccountsFile,
  pickAuthJsonFile,
  pickCopilotSnapshotFile,
  cancelCopilotLogin,
  startCopilotLogin,
  waitCopilotLogin,
  getAntigravityStatus,
  getCopilotStatus,
  sendAccountOtp,
  switchAccount,
  updateAccount,
  validateApiKey,
  verifyAccountOtp
} from './services'
import { loadAppData } from './storage'
import { getAppDataDir, getCodexHome, getOpencodeConfigDir } from './paths'

function getRuntimeInfo(): AppRuntimeInfo {
  return {
    env: isDev() ? 'development' : 'production',
    appDataDir: getAppDataDir(),
    codexHome: getCodexHome(),
    opencodeConfigDir: getOpencodeConfigDir(),
    applyAntigravityIde: shouldApplyAntigravityIde(),
    applyCopilotIde: shouldApplyCopilotIde()
  }
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: isDev() ? 'AI Switcher [DEV]' : 'AI Switcher',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle('app:getRuntimeInfo', () => getRuntimeInfo())
  ipcMain.handle('providers:list', () => getProviders())
  ipcMain.handle('app:getData', () => loadAppData())
  ipcMain.handle('app:getActiveStatuses', () => getActiveStatuses())
  ipcMain.handle('account:add', (_event, input) => addAccount(input).then((result) => result.account))
  ipcMain.handle('account:update', (_event, id, input) => updateAccount(id, input).then((result) => result.account))
  ipcMain.handle('account:delete', (_event, id) => deleteAccount(id))
  ipcMain.handle('account:switch', (_event, id) => switchAccount(id).then((result) => result.statuses))
  ipcMain.handle('account:validate', (_event, provider, apiKey) => validateApiKey(provider, apiKey))
  ipcMain.handle('provider:options', (_event, provider, apiKey) => getProviderOptions(provider, apiKey))
  ipcMain.handle('account:quota', (_event, provider, accountId) => getAccountQuota(provider, accountId))
  ipcMain.handle('accounts:quota', (_event, accountIds) => getAccountsQuota(accountIds))
  ipcMain.handle('freemodel:loginStatus', (_event, accountId) => getAccountLoginStatus(accountId))
  ipcMain.handle('freemodel:sendOtp', (_event, email) => sendAccountOtp(email))
  ipcMain.handle('freemodel:verifyOtp', (_event, accountId, email, code) =>
    verifyAccountOtp(accountId, email, code)
  )
  ipcMain.handle('freemodel:logout', (_event, accountId) => logoutAccount(accountId))
  ipcMain.handle('chatgpt:loginStatus', (_event, accountId) => getChatGptStatus(accountId))
  ipcMain.handle('chatgpt:login', (_event, accountId) => loginChatGptAccount(accountId))
  ipcMain.handle('chatgpt:importLive', (_event, accountId) => importChatGptLiveAccount(accountId))
  ipcMain.handle('chatgpt:importFile', (_event, accountId, filePath) =>
    importChatGptFileAccount(accountId, filePath)
  )
  ipcMain.handle('chatgpt:logout', (_event, accountId) => logoutChatGptAccount(accountId))
  ipcMain.handle('chatgpt:pickAuthFile', () => pickAuthJsonFile())
  ipcMain.handle('antigravity:loginStatus', (_event, accountId) => getAntigravityStatus(accountId))
  ipcMain.handle('antigravity:login', (_event, accountId) => loginAntigravityAccount(accountId))
  ipcMain.handle('antigravity:importLive', (_event, accountId) => importAntigravityLiveAccount(accountId))
  ipcMain.handle('antigravity:importFile', (_event, accountId, filePath) =>
    importAntigravityFileAccount(accountId, filePath)
  )
  ipcMain.handle('antigravity:logout', (_event, accountId) => logoutAntigravityAccount(accountId))
  ipcMain.handle('antigravity:pickAccountsFile', () => pickAntigravityAccountsFile())
  ipcMain.handle('antigravity:testChat', (_event, accountId, family) =>
    testAntigravityAccountChat(accountId, family)
  )
  ipcMain.handle('copilot:loginStatus', (_event, accountId) => getCopilotStatus(accountId))
  ipcMain.handle('copilot:importLive', (_event, accountId) => importCopilotLiveAccount(accountId))
  ipcMain.handle('copilot:importFile', (_event, accountId, filePath) =>
    importCopilotFileAccount(accountId, filePath)
  )
  ipcMain.handle('copilot:logout', (_event, accountId) => logoutCopilotAccount(accountId))
  ipcMain.handle('copilot:pickSnapshotFile', () => pickCopilotSnapshotFile())
  ipcMain.handle('copilot:deviceLoginStart', (_event, accountId) => startCopilotLogin(accountId))
  ipcMain.handle('copilot:deviceLoginWait', (_event, accountId) => waitCopilotLogin(accountId))
  ipcMain.handle('copilot:deviceLoginCancel', (_event, accountId) => cancelCopilotLogin(accountId))
  ipcMain.handle('codex:openDir', () => openCodexDir())
  ipcMain.handle('antigravity:openDir', () => openAntigravityDir())
  ipcMain.handle('copilot:openDir', () => openCopilotDir())
  ipcMain.handle('docs:open', (_event, provider) => openDocs(provider))
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId(isDev() ? 'dev.aiswitcher.app.dev' : 'dev.aiswitcher.app')
  }

  if (isDev()) {
    const runtime = getRuntimeInfo()
    console.info('[ai-switcher] development mode')
    console.info(`  app data: ${runtime.appDataDir}`)
    console.info(`  codex:    ${runtime.codexHome}`)
    console.info(`  opencode: ${runtime.opencodeConfigDir}`)
    if (!runtime.applyAntigravityIde) {
      console.info('  antigravity IDE sync: disabled')
    }
    if (!runtime.applyCopilotIde) {
      console.info('  copilot IDE sync: disabled')
    }
  }

  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
