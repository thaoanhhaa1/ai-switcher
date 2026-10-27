import { contextBridge, ipcRenderer } from 'electron'
import type { Api } from '../../src/types'

const api: Api = {
  getRuntimeInfo: () => ipcRenderer.invoke('app:getRuntimeInfo'),
  getProviders: () => ipcRenderer.invoke('providers:list'),
  getAppData: () => ipcRenderer.invoke('app:getData'),
  getActiveStatuses: () => ipcRenderer.invoke('app:getActiveStatuses'),
  addAccount: (input) => ipcRenderer.invoke('account:add', input),
  updateAccount: (id, input) => ipcRenderer.invoke('account:update', id, input),
  deleteAccount: (id) => ipcRenderer.invoke('account:delete', id),
  switchAccount: (id) => ipcRenderer.invoke('account:switch', id),
  validateApiKey: (provider, apiKey, accountId) =>
    ipcRenderer.invoke('account:validate', provider, apiKey, accountId),
  getProviderOptions: (provider, apiKey, accountId) =>
    ipcRenderer.invoke('provider:options', provider, apiKey, accountId),
  getAccountQuota: (provider, accountId) => ipcRenderer.invoke('account:quota', provider, accountId),
  getAccountsQuota: (accountIds) => ipcRenderer.invoke('accounts:quota', accountIds),
  getFreeModelLoginStatus: (accountId) => ipcRenderer.invoke('freemodel:loginStatus', accountId),
  sendFreeModelOtp: (email) => ipcRenderer.invoke('freemodel:sendOtp', email),
  verifyFreeModelOtp: (accountId, email, code) =>
    ipcRenderer.invoke('freemodel:verifyOtp', accountId, email, code),
  logoutFreeModel: (accountId) => ipcRenderer.invoke('freemodel:logout', accountId),
  getChatGptLoginStatus: (accountId) => ipcRenderer.invoke('chatgpt:loginStatus', accountId),
  loginChatGpt: (accountId) => ipcRenderer.invoke('chatgpt:login', accountId),
  importChatGptFromLive: (accountId) => ipcRenderer.invoke('chatgpt:importLive', accountId),
  importChatGptFromFile: (accountId, filePath) =>
    ipcRenderer.invoke('chatgpt:importFile', accountId, filePath),
  logoutChatGpt: (accountId) => ipcRenderer.invoke('chatgpt:logout', accountId),
  pickAuthJsonFile: () => ipcRenderer.invoke('chatgpt:pickAuthFile'),
  getAntigravityLoginStatus: (accountId) => ipcRenderer.invoke('antigravity:loginStatus', accountId),
  loginAntigravity: (accountId) => ipcRenderer.invoke('antigravity:login', accountId),
  importAntigravityFromLive: (accountId) => ipcRenderer.invoke('antigravity:importLive', accountId),
  importAntigravityFromFile: (accountId, filePath) =>
    ipcRenderer.invoke('antigravity:importFile', accountId, filePath),
  logoutAntigravity: (accountId) => ipcRenderer.invoke('antigravity:logout', accountId),
  pickAntigravityAccountsFile: () => ipcRenderer.invoke('antigravity:pickAccountsFile'),
  testAntigravityChat: (accountId, family) =>
    ipcRenderer.invoke('antigravity:testChat', accountId, family),
  getCopilotLoginStatus: (accountId) => ipcRenderer.invoke('copilot:loginStatus', accountId),
  importCopilotFromLive: (accountId) => ipcRenderer.invoke('copilot:importLive', accountId),
  importCopilotFromFile: (accountId, filePath) =>
    ipcRenderer.invoke('copilot:importFile', accountId, filePath),
  logoutCopilot: (accountId) => ipcRenderer.invoke('copilot:logout', accountId),
  pickCopilotSnapshotFile: () => ipcRenderer.invoke('copilot:pickSnapshotFile'),
  startCopilotDeviceLogin: (accountId) => ipcRenderer.invoke('copilot:deviceLoginStart', accountId),
  waitForCopilotDeviceLogin: (accountId) => ipcRenderer.invoke('copilot:deviceLoginWait', accountId),
  cancelCopilotDeviceLogin: (accountId) => ipcRenderer.invoke('copilot:deviceLoginCancel', accountId),
  openCodexDir: () => ipcRenderer.invoke('codex:openDir'),
  openAntigravityDir: () => ipcRenderer.invoke('antigravity:openDir'),
  openCopilotDir: () => ipcRenderer.invoke('copilot:openDir'),
  openDocs: (provider) => ipcRenderer.invoke('docs:open', provider)
}

contextBridge.exposeInMainWorld('api', api)
