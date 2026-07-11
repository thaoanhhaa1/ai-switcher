import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import {
  addAccount,
  deleteAccount,
  getAccountQuota,
  getAccountsQuota,
  getAccountLoginStatus,
  getChatGptStatus,
  getActiveStatus,
  getProviderOptions,
  getProviders,
  importChatGptFileAccount,
  importChatGptLiveAccount,
  importAntigravityFileAccount,
  importAntigravityLiveAccount,
  loginAntigravityAccount,
  loginChatGptAccount,
  logoutAccount,
  logoutAntigravityAccount,
  logoutChatGptAccount,
  openAntigravityDir,
  openCodexDir,
  openDocs,
  pickAntigravityAccountsFile,
  pickAuthJsonFile,
  getAntigravityStatus,
  sendAccountOtp,
  switchAccount,
  updateAccount,
  validateApiKey,
  verifyAccountOtp
} from './services'
import { loadAppData } from './storage'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'AI Switcher',
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
  ipcMain.handle('providers:list', () => getProviders())
  ipcMain.handle('app:getData', () => loadAppData())
  ipcMain.handle('app:getActiveStatus', () => getActiveStatus())
  ipcMain.handle('account:add', (_event, input) => addAccount(input).then((result) => result.account))
  ipcMain.handle('account:update', (_event, id, input) => updateAccount(id, input).then((result) => result.account))
  ipcMain.handle('account:delete', (_event, id) => deleteAccount(id))
  ipcMain.handle('account:switch', (_event, id) => switchAccount(id).then((result) => result.status))
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
  ipcMain.handle('codex:openDir', () => openCodexDir())
  ipcMain.handle('antigravity:openDir', () => openAntigravityDir())
  ipcMain.handle('docs:open', (_event, provider) => openDocs(provider))
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('dev.aiswitcher.app')
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
