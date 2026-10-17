import { access, constants } from 'fs/promises';
import { dialog, shell } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import type {
    Account,
    AccountQuota,
    ActiveConfigStatus,
    ActiveStatuses,
    AntigravityLoginStatus,
    AntigravityTestChatResult,
    AppData,
    ChatGptLoginStatus,
    CodexSettings,
    CopilotDeviceLoginStart,
    CopilotLoginStatus,
    FreeModelLoginStatus,
    ProviderId,
    ProviderInfo,
    ProviderOptions,
    QuotaWindow,
} from '../../src/types';
import { hashApiKey } from './crypto';
import {
    readLiveAuth,
    isChatGptAuth,
    parseChatGptIdentity,
    saveStoredAuth,
} from './codex-auth-storage';
import {
    clearFreeModelSession,
    getFreeModelLoginStatus,
    logoutFreeModel,
    sendFreeModelOtp,
    verifyFreeModelOtp,
} from './freemodel-auth';
import {
    applyCodexFreeModelAccount,
    DEFAULT_CODEX_SETTINGS,
    FREEMODEL_CODEX_DOCS,
    getCodexFreeModelOptions,
    fetchFreeModelQuota,
    readCodexAuthKey,
    validateFreeModelKey,
} from './providers/codex-freemodel';
import {
    applyCodexChatGptAccount,
    clearChatGptAuth,
    CODEX_CHATGPT_DOCS,
    DEFAULT_CHATGPT_SETTINGS,
    fetchChatGptQuota,
    getChatGptLoginStatus,
    importChatGptAuthFromFile,
    importChatGptAuthFromLive,
    readLiveChatGptAccountId,
    runChatGptLogin,
    snapshotLiveAuthToAccount,
} from './providers/codex-chatgpt';
import {
    ANTIGRAVITY_DOCS,
    applyAntigravityAccount,
    clearAntigravityAuth,
    DEFAULT_ANTIGRAVITY_SETTINGS,
    fetchAntigravityQuota,
    getAntigravityConfigDirPath,
    getAntigravityLoginStatus,
    importAntigravityFromFile,
    importAntigravityFromLive,
    readLiveAntigravityEmail,
    runAntigravityLogin,
    snapshotLiveAntigravityToAccount,
    testAntigravityChat,
} from './providers/antigravity';
import {
    COPILOT_DOCS,
    applyCopilotAccount,
    cancelCopilotDeviceLogin,
    clearCopilotAuth,
    DEFAULT_COPILOT_SETTINGS,
    fetchCopilotQuota,
    getCopilotLoginStatus,
    importCopilotFromFile,
    importCopilotFromLive,
    readLiveCopilotUsernameForStatus,
    snapshotLiveCopilotToAccount,
    startCopilotDeviceLogin,
    waitForCopilotDeviceLogin,
} from './providers/github-copilot';
import { isValidCopilotEntry, loadStoredCopilotAccount } from './copilot-auth-storage';
import { hasLiveCopilotAuth } from './copilot-ide';
import {
    getAntigravityAccountsPath,
    getAntigravityConfigPath,
    getCodexAuthPath,
    getCodexConfigPath,
    getCodexHome,
    getCopilotConfigDir,
    getOpencodeConfigDir,
} from './paths';
import {
    appendUsageEvent,
    CODEX_PROVIDERS,
    findAccount,
    getActiveAccountIdForProvider,
    isCodexProvider,
    loadAppData,
    saveAppData,
    withActiveAccountForProvider,
} from './storage';

const PROVIDERS: ProviderInfo[] = [
    {
        id: 'codex-freemodel',
        name: 'Codex + FreeModel',
        toolName: 'OpenAI Codex CLI',
        configDir: getCodexHome(),
        docsUrl: FREEMODEL_CODEX_DOCS,
    },
    {
        id: 'codex-chatgpt',
        name: 'Codex + ChatGPT',
        toolName: 'OpenAI Codex CLI',
        configDir: getCodexHome(),
        docsUrl: CODEX_CHATGPT_DOCS,
    },
    {
        id: 'antigravity',
        name: 'Antigravity',
        toolName: 'OpenCode + Antigravity Auth',
        configDir: getOpencodeConfigDir(),
        docsUrl: ANTIGRAVITY_DOCS,
    },
    {
        id: 'github-copilot',
        name: 'GitHub Copilot',
        toolName: 'VS Code',
        configDir: getCopilotConfigDir(),
        docsUrl: COPILOT_DOCS,
    },
];

async function fileExists(path: string): Promise<boolean> {
    try {
        await access(path, constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

function defaultSettings(provider: ProviderId): CodexSettings {
    if (provider === 'codex-chatgpt') return { ...DEFAULT_CHATGPT_SETTINGS };
    if (provider === 'antigravity') return { ...DEFAULT_ANTIGRAVITY_SETTINGS };
    if (provider === 'github-copilot') return { ...DEFAULT_COPILOT_SETTINGS };
    return { ...DEFAULT_CODEX_SETTINGS };
}

/** Fallback khi provider chưa hỗ trợ / lỗi bất ngờ — 1 tài khoản hỏng không kéo cả danh sách. */
function buildUnavailableQuota(message: string): AccountQuota {
    const emptyWindow: QuotaWindow = {
        usedCents: 0,
        limitCents: 0,
        remainingCents: 0,
        usedPercent: 0,
        remainingPercent: 0,
        resetsAt: null,
        resetsInLabel: '',
    };
    return {
        available: false,
        hasActiveLimits: false,
        message,
        hourly: emptyWindow,
        weekly: emptyWindow,
        updatedAt: new Date().toISOString(),
    };
}

async function persistCopilotIdentity(
    accountId: string,
    identity: { username?: string },
): Promise<Account | null> {
    const data = await loadAppData();
    const account = findAccount(data, accountId);
    if (!account) return null;

    const updated: Account = {
        ...account,
        copilotUsername: identity.username ?? account.copilotUsername,
    };

    const next: AppData = {
        ...data,
        accounts: data.accounts.map((item) =>
            item.id === accountId ? updated : item,
        ),
    };
    await saveAppData(next);
    return updated;
}

async function persistAntigravityIdentity(
    accountId: string,
    identity: { email?: string; projectId?: string },
): Promise<Account | null> {
    const data = await loadAppData();
    const account = findAccount(data, accountId);
    if (!account) return null;

    const updated: Account = {
        ...account,
        antigravityEmail: identity.email ?? account.antigravityEmail,
    };

    const next: AppData = {
        ...data,
        accounts: data.accounts.map((item) =>
            item.id === accountId ? updated : item,
        ),
    };
    await saveAppData(next);
    return updated;
}

async function persistChatGptIdentity(
    accountId: string,
    identity: {
        email?: string;
        accountId?: string;
        planType?: string;
    },
): Promise<Account | null> {
    const data = await loadAppData();
    const account = findAccount(data, accountId);
    if (!account) return null;

    const updated: Account = {
        ...account,
        chatgptEmail: identity.email ?? account.chatgptEmail,
        chatgptAccountId: identity.accountId ?? account.chatgptAccountId,
        planType: identity.planType ?? account.planType,
    };

    const next: AppData = {
        ...data,
        accounts: data.accounts.map((item) =>
            item.id === accountId ? updated : item,
        ),
    };
    await saveAppData(next);
    return updated;
}

async function snapshotActiveAccountAuth(
    data: AppData,
    provider: ProviderId,
): Promise<void> {
    // Codex providers share ~/.codex — snapshot whichever Codex account is currently live.
    const providersToSnapshot = isCodexProvider(provider)
        ? CODEX_PROVIDERS
        : [provider];

    for (const snapshotProvider of providersToSnapshot) {
        const activeId = getActiveAccountIdForProvider(data, snapshotProvider);
        if (!activeId) continue;

        const active = findAccount(data, activeId);
        if (!active) continue;

        if (active.provider === 'codex-chatgpt') {
            await snapshotLiveAuthToAccount(active.id);
            return;
        }

        if (active.provider === 'antigravity') {
            await snapshotLiveAntigravityToAccount(active.id);
            return;
        }

        if (active.provider === 'github-copilot') {
            await snapshotLiveCopilotToAccount(
                active.id,
                active.copilotUsername ?? undefined,
            );
        }
    }
}

export function getProviders(): ProviderInfo[] {
    return PROVIDERS;
}

async function buildActiveStatusFromAccount(
    active: Account,
): Promise<ActiveConfigStatus> {
    if (active.provider === 'antigravity') {
        return {
            provider: 'antigravity',
            accountId: active.id,
            accountName: active.name,
            codexHome: getAntigravityConfigDirPath(),
            configExists: await fileExists(getAntigravityConfigPath()),
            authExists: await fileExists(getAntigravityAccountsPath()),
            authMode: 'google-oauth',
        };
    }

    if (active.provider === 'github-copilot') {
        const stored = await loadStoredCopilotAccount(active.id);
        return {
            provider: 'github-copilot',
            accountId: active.id,
            accountName: active.name,
            codexHome: getCopilotConfigDir(),
            configExists: await fileExists(getCopilotConfigDir()),
            authExists: isValidCopilotEntry(stored),
            authMode: 'github-oauth',
        };
    }

    const configExists = await fileExists(getCodexConfigPath());
    const authExists = await fileExists(getCodexAuthPath());

    if (active.provider === 'codex-chatgpt') {
        return {
            provider: 'codex-chatgpt',
            accountId: active.id,
            accountName: active.name,
            codexHome: getCodexHome(),
            configExists,
            authExists,
            authMode: 'chatgpt',
        };
    }

    return {
        provider: 'codex-freemodel',
        accountId: active.id,
        accountName: active.name,
        codexHome: getCodexHome(),
        configExists,
        authExists,
        authMode: 'apikey',
    };
}

async function getInactiveStatus(
    provider: ProviderId,
): Promise<ActiveConfigStatus> {
    if (provider === 'antigravity') {
        return {
            provider: 'antigravity',
            accountId: null,
            accountName: null,
            codexHome: getAntigravityConfigDirPath(),
            configExists: await fileExists(getAntigravityConfigPath()),
            authExists: await fileExists(getAntigravityAccountsPath()),
            authMode: 'google-oauth',
        };
    }

    if (provider === 'github-copilot') {
        return {
            provider: 'github-copilot',
            accountId: null,
            accountName: null,
            codexHome: getCopilotConfigDir(),
            configExists: await fileExists(getCopilotConfigDir()),
            authExists: await hasLiveCopilotAuth(),
            authMode: 'github-oauth',
        };
    }

    const configExists = await fileExists(getCodexConfigPath());
    const authExists = await fileExists(getCodexAuthPath());

    return {
        provider,
        accountId: null,
        accountName: null,
        codexHome: getCodexHome(),
        configExists,
        authExists,
        authMode: provider === 'codex-chatgpt' ? 'chatgpt' : 'apikey',
    };
}

export async function getActiveStatusForProvider(
    appData: AppData,
    provider: ProviderId,
): Promise<ActiveConfigStatus> {
    const activeId = getActiveAccountIdForProvider(appData, provider);
    if (activeId) {
        const active = findAccount(appData, activeId);
        if (active?.provider === provider) {
            return buildActiveStatusFromAccount(active);
        }
    }

    if (provider === 'antigravity') {
        const liveAntigravityEmail = await readLiveAntigravityEmail();
        if (liveAntigravityEmail) {
            const matched = appData.accounts.find(
                (account) =>
                    account.provider === 'antigravity' &&
                    account.antigravityEmail?.toLowerCase() ===
                        liveAntigravityEmail.toLowerCase(),
            );

            if (matched) {
                return buildActiveStatusFromAccount(matched);
            }
        }

        return getInactiveStatus('antigravity');
    }

    if (provider === 'github-copilot') {
        const liveUsername = await readLiveCopilotUsernameForStatus();
        if (liveUsername) {
            const matched = appData.accounts.find(
                (account) =>
                    account.provider === 'github-copilot' &&
                    account.copilotUsername?.toLowerCase() ===
                        liveUsername.toLowerCase(),
            );

            if (matched) {
                return buildActiveStatusFromAccount(matched);
            }
        }

        return getInactiveStatus('github-copilot');
    }

    const configExists = await fileExists(getCodexConfigPath());
    const authExists = await fileExists(getCodexAuthPath());
    const liveAuth = await readLiveAuth();

    if (provider === 'codex-chatgpt') {
        if (isChatGptAuth(liveAuth)) {
            const liveAccountId = await readLiveChatGptAccountId();
            const matched = appData.accounts.find(
                (account) =>
                    account.provider === 'codex-chatgpt' &&
                    account.chatgptAccountId === liveAccountId,
            );

            if (matched) {
                return buildActiveStatusFromAccount(matched);
            }
        }

        return {
            ...(await getInactiveStatus('codex-chatgpt')),
            configExists,
            authExists,
            authMode: isChatGptAuth(liveAuth) ? 'chatgpt' : authExists ? 'unknown' : undefined,
        };
    }

    if (isChatGptAuth(liveAuth)) {
        return getInactiveStatus('codex-freemodel');
    }

    const currentKey = await readCodexAuthKey();
    if (currentKey) {
        const currentHash = hashApiKey(currentKey);
        const matched = appData.accounts.find(
            (account) =>
                account.provider === 'codex-freemodel' &&
                hashApiKey(account.apiKey) === currentHash,
        );

        if (matched) {
            return buildActiveStatusFromAccount(matched);
        }
    }

    return {
        ...(await getInactiveStatus('codex-freemodel')),
        configExists,
        authExists,
        authMode: authExists ? 'unknown' : undefined,
    };
}

const ALL_PROVIDERS: ProviderId[] = [
    'codex-freemodel',
    'codex-chatgpt',
    'antigravity',
    'github-copilot',
];

export async function getActiveStatuses(
    data?: AppData,
): Promise<ActiveStatuses> {
    const appData = data ?? (await loadAppData());
    const entries = await Promise.all(
        ALL_PROVIDERS.map(
            async (provider) =>
                [provider, await getActiveStatusForProvider(appData, provider)] as const,
        ),
    );

    return Object.fromEntries(entries) as ActiveStatuses;
}

export async function addAccount(input: {
    name: string;
    provider: ProviderId;
    apiKey?: string;
    settings?: Partial<CodexSettings>;
    note?: string;
}): Promise<{ data: AppData; account: Account }> {
    const data = await loadAppData();
    const account: Account = {
        id: uuidv4(),
        name: input.name.trim(),
        provider: input.provider,
        apiKey: input.apiKey?.trim() ?? '',
        settings: {
            ...defaultSettings(input.provider),
            ...input.settings,
        },
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        switchCount: 0,
        note: input.note?.trim() || undefined,
    };

    const next: AppData = {
        ...data,
        accounts: [...data.accounts, account],
    };

    await saveAppData(next);
    const withLog = await appendUsageEvent(next, {
        accountId: account.id,
        accountName: account.name,
        provider: account.provider,
        action: 'add',
        success: true,
        message: 'Đã thêm tài khoản',
    });

    return { data: withLog, account };
}

export async function updateAccount(
    id: string,
    input: {
        name?: string;
        apiKey?: string;
        settings?: Partial<CodexSettings>;
        note?: string;
    },
): Promise<{ data: AppData; account: Account }> {
    const data = await loadAppData();
    const existing = findAccount(data, id);
    if (!existing) {
        throw new Error('Không tìm thấy tài khoản');
    }

    const updated: Account = {
        ...existing,
        name: input.name?.trim() ?? existing.name,
        apiKey: input.apiKey?.trim() ?? existing.apiKey,
        settings: {
            ...existing.settings,
            ...input.settings,
        },
        note:
            input.note !== undefined
                ? input.note.trim() || undefined
                : existing.note,
    };

    const next: AppData = {
        ...data,
        accounts: data.accounts.map((account) =>
            account.id === id ? updated : account,
        ),
    };

    await saveAppData(next);

    // Chỉ re-apply khi phần config/auth thực sự đổi. Sửa name/note thuần metadata
    // không được phép kick lại IDE (Copilot apply là destructive — CODE_REVIEW H3).
    const configChanged =
        updated.apiKey !== existing.apiKey ||
        updated.settings.model !== existing.settings.model ||
        updated.settings.modelReasoningEffort !== existing.settings.modelReasoningEffort;

    if (configChanged && getActiveAccountIdForProvider(data, updated.provider) === id) {
        if (updated.provider === 'codex-freemodel') {
            await applyCodexFreeModelAccount(updated);
        } else if (updated.provider === 'codex-chatgpt') {
            await applyCodexChatGptAccount(updated);
        } else if (updated.provider === 'antigravity') {
            await applyAntigravityAccount(updated);
        } else if (updated.provider === 'github-copilot') {
            await applyCopilotAccount(updated);
        }
    }

    const withLog = await appendUsageEvent(next, {
        accountId: updated.id,
        accountName: updated.name,
        provider: updated.provider,
        action: 'update',
        success: true,
        message: 'Đã cập nhật tài khoản',
    });

    return { data: withLog, account: updated };
}

export async function deleteAccount(id: string): Promise<AppData> {
    const data = await loadAppData();
    const existing = findAccount(data, id);
    if (!existing) {
        throw new Error('Không tìm thấy tài khoản');
    }

    const next = withActiveAccountForProvider(
        {
            ...data,
            accounts: data.accounts.filter((account) => account.id !== id),
        },
        existing.provider,
        getActiveAccountIdForProvider(data, existing.provider) === id
            ? null
            : getActiveAccountIdForProvider(data, existing.provider),
    );

    await saveAppData(next);
    await clearFreeModelSession(id);
    await clearChatGptAuth(id);
    await clearAntigravityAuth(id);
    await clearCopilotAuth(id);

    return appendUsageEvent(next, {
        accountId: existing.id,
        accountName: existing.name,
        provider: existing.provider,
        action: 'delete',
        success: true,
        message: 'Đã xóa tài khoản',
    });
}

export async function switchAccount(
    id: string,
): Promise<{ data: AppData; statuses: ActiveStatuses }> {
    const data = await loadAppData();
    const account = findAccount(data, id);
    if (!account) {
        throw new Error('Không tìm thấy tài khoản');
    }

    await snapshotActiveAccountAuth(data, account.provider);

    if (account.provider === 'codex-freemodel') {
        await applyCodexFreeModelAccount(account);
    } else if (account.provider === 'codex-chatgpt') {
        await applyCodexChatGptAccount(account);
    } else if (account.provider === 'antigravity') {
        await applyAntigravityAccount(account);
    } else if (account.provider === 'github-copilot') {
        await applyCopilotAccount(account);
    }

    const updatedAccount: Account = {
        ...account,
        lastUsedAt: new Date().toISOString(),
        switchCount: account.switchCount + 1,
    };

    const next = withActiveAccountForProvider(
        {
            ...data,
            accounts: data.accounts.map((item) =>
                item.id === id ? updatedAccount : item,
            ),
        },
        account.provider,
        id,
    );

    await saveAppData(next);

    const withLog = await appendUsageEvent(next, {
        accountId: updatedAccount.id,
        accountName: updatedAccount.name,
        provider: updatedAccount.provider,
        action: 'switch',
        success: true,
        message: 'Đã chuyển sang tài khoản này',
    });

    const statuses = await getActiveStatuses(withLog);
    return { data: withLog, statuses };
}

export async function validateApiKey(
    provider: ProviderId,
    apiKey: string,
): Promise<{ valid: boolean; message: string }> {
    if (provider === 'codex-freemodel') {
        return validateFreeModelKey(apiKey.trim());
    }

    if (provider === 'antigravity') {
        return {
            valid: false,
            message: 'Antigravity dùng Google OAuth, không dùng API key',
        };
    }

    if (provider === 'github-copilot') {
        return {
            valid: false,
            message: 'GitHub Copilot dùng OAuth qua VS Code/Cursor, không dùng API key',
        };
    }

    return { valid: false, message: 'ChatGPT dùng OAuth, không dùng API key' };
}

export async function getProviderOptions(
    provider: ProviderId,
    apiKey?: string,
): Promise<ProviderOptions> {
    if (provider === 'codex-freemodel') {
        return getCodexFreeModelOptions(apiKey);
    }

    if (provider === 'codex-chatgpt') {
        return {
            models: [
                { id: 'gpt-5.4', ownedBy: 'openai' },
                { id: 'gpt-5.3-codex', ownedBy: 'openai' },
                { id: 'gpt-5.5-codex', ownedBy: 'openai' },
            ],
            reasoningEfforts: [
                { value: 'low', label: 'low' },
                { value: 'medium', label: 'medium' },
                { value: 'high', label: 'high' },
                { value: 'xhigh', label: 'xhigh' },
            ],
        };
    }

    if (provider === 'antigravity') {
        return {
            models: [
                { id: 'claude-opus-4-5-thinking', ownedBy: 'anthropic' },
                { id: 'gemini-3-pro', ownedBy: 'google' },
                { id: 'gemini-3-flash', ownedBy: 'google' },
            ],
            reasoningEfforts: [
                { value: 'low', label: 'low' },
                { value: 'medium', label: 'medium' },
                { value: 'high', label: 'high' },
            ],
        };
    }

    if (provider === 'github-copilot') {
        // Copilot không chọn model qua app (do VS Code quản lý) — dialog Copilot
        // cũng không gọi endpoint này. Trả rỗng thay vì hardcode model lỗi thời (CODE_REVIEW L3).
        return {
            models: [],
            reasoningEfforts: [],
        };
    }

    throw new Error('Provider chưa được hỗ trợ');
}

export async function getAccountQuota(
    provider: ProviderId,
    accountId: string,
): Promise<AccountQuota> {
    const data = await loadAppData();
    const account = findAccount(data, accountId);
    if (!account) {
        throw new Error('Không tìm thấy tài khoản');
    }

    if (provider === 'codex-freemodel') {
        return fetchFreeModelQuota(accountId, account.apiKey);
    }

    if (provider === 'codex-chatgpt') {
        return fetchChatGptQuota(accountId);
    }

    if (provider === 'antigravity') {
        return fetchAntigravityQuota(accountId);
    }

    if (provider === 'github-copilot') {
        return fetchCopilotQuota(accountId);
    }

    throw new Error('Provider chưa được hỗ trợ');
}

export async function getAccountsQuota(
    accountIds?: string[],
): Promise<Record<string, AccountQuota>> {
    const data = await loadAppData();
    const targets = accountIds?.length
        ? data.accounts.filter((account) => accountIds.includes(account.id))
        : data.accounts;

    const entries = await Promise.all(
        targets.map(async (account) => {
            const quota = await getAccountQuota(account.provider, account.id).catch(
                (error: unknown) => buildUnavailableQuota(
                    error instanceof Error ? error.message : 'Không thể lấy quota',
                ),
            );
            return [account.id, quota] as const;
        }),
    );

    return Object.fromEntries(entries);
}

export async function getAccountLoginStatus(
    accountId: string,
): Promise<FreeModelLoginStatus> {
    return getFreeModelLoginStatus(accountId);
}

export async function sendAccountOtp(
    email: string,
): Promise<{ success: boolean; message: string }> {
    return sendFreeModelOtp(email);
}

export async function verifyAccountOtp(
    accountId: string,
    email: string,
    code: string,
): Promise<{
    success: boolean;
    message: string;
    loginStatus?: FreeModelLoginStatus;
}> {
    const result = await verifyFreeModelOtp(accountId, email, code);
    if (!result.success) {
        return result;
    }

    const data = await loadAppData();
    const account = findAccount(data, accountId);
    if (account) {
        const next: AppData = {
            ...data,
            accounts: data.accounts.map((item) =>
                item.id === accountId
                    ? {
                          ...item,
                          freemodelEmail: email.trim().toLowerCase(),
                      }
                    : item,
            ),
        };
        await saveAppData(next);
    }

    return result;
}

export async function logoutAccount(accountId: string): Promise<void> {
    await logoutFreeModel(accountId);
}

export async function getChatGptStatus(
    accountId: string,
): Promise<ChatGptLoginStatus> {
    return getChatGptLoginStatus(accountId);
}

export async function loginChatGptAccount(
    accountId: string,
): Promise<ChatGptLoginStatus> {
    const auth = await runChatGptLogin();
    const identity = parseChatGptIdentity(auth);
    await saveStoredAuth(accountId, auth);
    await persistChatGptIdentity(accountId, identity);

    const data = await loadAppData();
    await appendUsageEvent(data, {
        accountId,
        accountName: findAccount(data, accountId)?.name ?? accountId,
        provider: 'codex-chatgpt',
        action: 'login',
        success: true,
        message: 'Đăng nhập ChatGPT thành công',
    });

    return getChatGptLoginStatus(accountId);
}

export async function importChatGptLiveAccount(
    accountId: string,
): Promise<ChatGptLoginStatus> {
    const auth = await importChatGptAuthFromLive(accountId);
    const identity = parseChatGptIdentity(auth);
    await persistChatGptIdentity(accountId, identity);
    return getChatGptLoginStatus(accountId);
}

export async function importChatGptFileAccount(
    accountId: string,
    filePath: string,
): Promise<ChatGptLoginStatus> {
    const auth = await importChatGptAuthFromFile(accountId, filePath);
    const identity = parseChatGptIdentity(auth);
    await persistChatGptIdentity(accountId, identity);
    return getChatGptLoginStatus(accountId);
}

export async function logoutChatGptAccount(accountId: string): Promise<void> {
    await clearChatGptAuth(accountId);
}

export async function getAntigravityStatus(
    accountId: string,
): Promise<AntigravityLoginStatus> {
    return getAntigravityLoginStatus(accountId);
}

export async function loginAntigravityAccount(
    accountId: string,
): Promise<AntigravityLoginStatus> {
    const status = await runAntigravityLogin(accountId);
    await persistAntigravityIdentity(accountId, {
        email: status.email,
        projectId: status.projectId,
    });

    const data = await loadAppData();
    await appendUsageEvent(data, {
        accountId,
        accountName: findAccount(data, accountId)?.name ?? accountId,
        provider: 'antigravity',
        action: 'login',
        success: true,
        message: 'Đăng nhập Antigravity thành công',
    });

    return status;
}

export async function importAntigravityLiveAccount(
    accountId: string,
): Promise<AntigravityLoginStatus> {
    const status = await importAntigravityFromLive(accountId);
    await persistAntigravityIdentity(accountId, {
        email: status.email,
        projectId: status.projectId,
    });
    return status;
}

export async function importAntigravityFileAccount(
    accountId: string,
    filePath: string,
): Promise<AntigravityLoginStatus> {
    const status = await importAntigravityFromFile(accountId, filePath);
    await persistAntigravityIdentity(accountId, {
        email: status.email,
        projectId: status.projectId,
    });
    return status;
}

export async function logoutAntigravityAccount(
    accountId: string,
): Promise<void> {
    await clearAntigravityAuth(accountId);
}

export async function testAntigravityAccountChat(
    accountId: string,
    family: 'gemini' | 'claude',
): Promise<AntigravityTestChatResult> {
    return testAntigravityChat(accountId, family);
}

export async function getCopilotStatus(
    accountId: string,
): Promise<CopilotLoginStatus> {
    return getCopilotLoginStatus(accountId);
}

export async function importCopilotLiveAccount(
    accountId: string,
): Promise<CopilotLoginStatus> {
    const status = await importCopilotFromLive(accountId);
    await persistCopilotIdentity(accountId, { username: status.username });
    return status;
}

export async function importCopilotFileAccount(
    accountId: string,
    filePath: string,
): Promise<CopilotLoginStatus> {
    const status = await importCopilotFromFile(accountId, filePath);
    await persistCopilotIdentity(accountId, { username: status.username });
    return status;
}

export async function logoutCopilotAccount(accountId: string): Promise<void> {
    await cancelCopilotDeviceLogin(accountId);
    await clearCopilotAuth(accountId);
}

export async function startCopilotLogin(
    accountId: string,
): Promise<CopilotDeviceLoginStart> {
    return startCopilotDeviceLogin(accountId);
}

export async function waitCopilotLogin(accountId: string): Promise<CopilotLoginStatus> {
    const status = await waitForCopilotDeviceLogin(accountId);
    const data = await loadAppData();
    await appendUsageEvent(data, {
        accountId,
        accountName: findAccount(data, accountId)?.name ?? accountId,
        provider: 'github-copilot',
        action: 'login',
        success: true,
        message: 'Đăng nhập GitHub (device flow) thành công',
    });
    return status;
}

export async function cancelCopilotLogin(accountId: string): Promise<void> {
    await cancelCopilotDeviceLogin(accountId);
}

export async function pickCopilotSnapshotFile(): Promise<string | null> {
    const result = await dialog.showOpenDialog({
        title: 'Chọn file snapshot Copilot',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }],
    });

    if (result.canceled || !result.filePaths.length) {
        return null;
    }

    return result.filePaths[0];
}

export async function pickAuthJsonFile(): Promise<string | null> {
    const result = await dialog.showOpenDialog({
        title: 'Chọn file auth.json',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }],
    });

    if (result.canceled || !result.filePaths.length) {
        return null;
    }

    return result.filePaths[0];
}

export async function pickAntigravityAccountsFile(): Promise<string | null> {
    const result = await dialog.showOpenDialog({
        title: 'Chọn file antigravity-accounts.json',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }],
    });

    if (result.canceled || !result.filePaths.length) {
        return null;
    }

    return result.filePaths[0];
}

export async function openCodexDir(): Promise<void> {
    await shell.openPath(getCodexHome());
}

export async function openAntigravityDir(): Promise<void> {
    await shell.openPath(getOpencodeConfigDir());
}

export async function openCopilotDir(): Promise<void> {
    await shell.openPath(getCopilotConfigDir());
}

export async function openDocs(provider: ProviderId): Promise<void> {
    const info = PROVIDERS.find((item) => item.id === provider);
    if (info) {
        await shell.openExternal(info.docsUrl);
    }
}
