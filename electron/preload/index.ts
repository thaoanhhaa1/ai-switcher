import { contextBridge, ipcRenderer } from 'electron'
import type { Api } from '../../src/types'

const api: Api = {
  getProviders: () => ipcRenderer.invoke('providers:list'),
  getAppData: () => ipcRenderer.invoke('app:getData'),
  getActiveStatus: () => ipcRenderer.invoke('app:getActiveStatus'),
  addAccount: (input) => ipcRenderer.invoke('account:add', input),
  updateAccount: (id, input) => ipcRenderer.invoke('account:update', id, input),
  deleteAccount: (id) => ipcRenderer.invoke('account:delete', id),
  switchAccount: (id) => ipcRenderer.invoke('account:switch', id),
  validateApiKey: (provider, apiKey) => ipcRenderer.invoke('account:validate', provider, apiKey),
  getProviderOptions: (provider, apiKey) => ipcRenderer.invoke('provider:options', provider, apiKey),
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
  openCodexDir: () => ipcRenderer.invoke('codex:openDir'),
  openDocs: (provider) => ipcRenderer.invoke('docs:open', provider)
}

contextBridge.exposeInMainWorld('api', api)
