import { useEffect, useMemo, useRef, useState } from 'react';
import {
    AUTO_TEST_CHAT_INITIAL_TRIGGERED_KEY,
    AUTO_TEST_CHAT_LAST_TRIGGERED_KEY,
    AUTO_TEST_CHAT_STORAGE_KEY,
    calculateNextResetDelayMs,
    executeAutoTestChatForAccounts,
} from './antigravity-auto-chat';
import { sortAntigravityAccounts } from './antigravity-sort';
import './App.css';
import { AccountDialog } from './components/AccountDialog';
import { AntigravityAccountDialog } from './components/AntigravityAccountDialog';
import { AntigravityLoginDialog } from './components/AntigravityLoginDialog';
import { ChatGptAccountDialog } from './components/ChatGptAccountDialog';
import { ChatGptLoginDialog } from './components/ChatGptLoginDialog';
import { CopilotAccountDialog } from './components/CopilotAccountDialog';
import { CopilotLoginDialog } from './components/CopilotLoginDialog';
import { FreeModelLoginDialog } from './components/FreeModelLoginDialog';
import { QuotaPanel } from './components/QuotaPanel';
import type {
    Account,
    AccountQuota,
    ActiveConfigStatus,
    ActiveStatuses,
    AntigravityLoginStatus,
    AntigravitySortOption,
    AppData,
    AppRuntimeInfo,
    ChatGptLoginStatus,
    CodexSettings,
    CopilotLoginStatus,
    FreeModelLoginStatus,
    ProviderId,
    ProviderInfo,
} from './types';

function formatDate(value: string | null): string {
    if (!value) return 'Chưa dùng';
    return new Date(value).toLocaleString('vi-VN');
}

function maskKey(key: string): string {
    if (!key) return 'OAuth';
    if (key.length <= 8) return '••••••••';
    return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

function providerLabel(provider: ProviderId): string {
    if (provider === 'codex-chatgpt') return 'ChatGPT';
    if (provider === 'antigravity') return 'Antigravity';
    if (provider === 'github-copilot') return 'Copilot';
    return 'FreeModel';
}

function providerShortLabel(provider: ProviderId): string {
    if (provider === 'codex-freemodel') return 'Codex + FreeModel';
    if (provider === 'codex-chatgpt') return 'Codex + ChatGPT';
    if (provider === 'github-copilot') return 'GitHub Copilot';
    return 'Antigravity';
}

function providerDescription(provider: ProviderId, configDir: string): string {
    if (provider === 'codex-freemodel') {
        return `Quản lý API key FreeModel cho Codex CLI. Ghi config vào ${configDir}.`;
    }
    if (provider === 'codex-chatgpt') {
        return `Quản lý tài khoản ChatGPT OAuth cho Codex CLI. Ghi config vào ${configDir}.`;
    }
    if (provider === 'github-copilot') {
        return `Quản lý tài khoản GitHub Copilot cho VS Code. Ghi auth vào state.vscdb (${configDir}).`;
    }
    return 'Quản lý Google OAuth cho Antigravity (OpenCode + IDE). Ghi vào thư mục OpenCode và Antigravity IDE (prod).';
}

function authModeLabel(mode?: ActiveConfigStatus['authMode']): string {
    if (
        mode === 'chatgpt' ||
        mode === 'google-oauth' ||
        mode === 'github-oauth'
    )
        return 'OAuth';
    if (mode === 'apikey') return 'API key';
    return '—';
}

export default function App() {
    const [providers, setProviders] = useState<ProviderInfo[]>([]);
    const [selectedProviderId, setSelectedProviderId] =
        useState<ProviderId | null>(null);
    const [data, setData] = useState<AppData | null>(null);
    const [statuses, setStatuses] = useState<ActiveStatuses | null>(null);
    const [loading, setLoading] = useState(true);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editingAccount, setEditingAccount] = useState<Account | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [quotas, setQuotas] = useState<Record<string, AccountQuota>>({});
    const [quotaLoading, setQuotaLoading] = useState(false);
    const [freeModelLogins, setFreeModelLogins] = useState<
        Record<string, FreeModelLoginStatus>
    >({});
    const [chatGptLogins, setChatGptLogins] = useState<
        Record<string, ChatGptLoginStatus>
    >({});
    const [antigravityLogins, setAntigravityLogins] = useState<
        Record<string, AntigravityLoginStatus>
    >({});
    const [copilotLogins, setCopilotLogins] = useState<
        Record<string, CopilotLoginStatus>
    >({});
    const [loginAccount, setLoginAccount] = useState<Account | null>(null);
    const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(
        new Set(),
    );
    const [usageLogVisible, setUsageLogVisible] = useState(false);
    const [runtimeInfo, setRuntimeInfo] = useState<AppRuntimeInfo | null>(null);

    const selectedProvider = useMemo(
        () =>
            providers.find((provider) => provider.id === selectedProviderId) ??
            null,
        [providers, selectedProviderId],
    );

    const providerAccounts = useMemo(
        () =>
            data?.accounts.filter(
                (account) => account.provider === selectedProviderId,
            ) ?? [],
        [data?.accounts, selectedProviderId],
    );

    const [antigravitySort, setAntigravitySort] =
        useState<AntigravitySortOption>(() => {
            const saved = localStorage.getItem('ai-switcher:antigravity-sort');
            if (
                saved === 'gemini-desc' ||
                saved === 'gemini-asc' ||
                saved === 'claude-desc' ||
                saved === 'claude-asc'
            ) {
                return saved;
            }
            return 'default';
        });

    function handleAntigravitySortChange(option: AntigravitySortOption) {
        setAntigravitySort(option);
        try {
            localStorage.setItem('ai-switcher:antigravity-sort', option);
        } catch {
            // ignore
        }
    }

    function loadInitialTriggeredSet(): Set<string> {
        try {
            const raw = localStorage.getItem(
                AUTO_TEST_CHAT_INITIAL_TRIGGERED_KEY,
            );
            if (raw) {
                const arr = JSON.parse(raw);
                if (Array.isArray(arr)) return new Set(arr);
            }
        } catch {
            // ignore
        }
        return new Set();
    }

    function saveInitialTriggeredSet(set: Set<string>): void {
        try {
            localStorage.setItem(
                AUTO_TEST_CHAT_INITIAL_TRIGGERED_KEY,
                JSON.stringify(Array.from(set)),
            );
        } catch {
            // ignore
        }
    }

    function loadLastTriggeredMap(): Map<string, number> {
        try {
            const raw = localStorage.getItem(AUTO_TEST_CHAT_LAST_TRIGGERED_KEY);
            if (raw) {
                const obj = JSON.parse(raw);
                if (obj && typeof obj === 'object') {
                    const map = new Map<string, number>();
                    for (const [k, v] of Object.entries(obj)) {
                        if (typeof v === 'number') map.set(k, v);
                    }
                    return map;
                }
            }
        } catch {
            // ignore
        }
        return new Map();
    }

    function saveLastTriggeredMap(map: Map<string, number>): void {
        try {
            const obj: Record<string, number> = {};
            map.forEach((v, k) => {
                obj[k] = v;
            });
            localStorage.setItem(
                AUTO_TEST_CHAT_LAST_TRIGGERED_KEY,
                JSON.stringify(obj),
            );
        } catch {
            // ignore
        }
    }

    const [autoTestChatEnabled, setAutoTestChatEnabled] = useState<boolean>(
        () => {
            try {
                return (
                    localStorage.getItem(AUTO_TEST_CHAT_STORAGE_KEY) === 'true'
                );
            } catch {
                return false;
            }
        },
    );

    const [autoChatNotification, setAutoChatNotification] = useState<{
        type: 'success' | 'error' | 'info';
        text: string;
    } | null>(null);

    const autoChatLastTriggeredRef = useRef<Map<string, number>>(
        loadLastTriggeredMap(),
    );
    const autoChatInitialTriggeredRef = useRef<Set<string>>(
        loadInitialTriggeredSet(),
    );
    const autoChatConsecutiveErrorsRef = useRef<Map<string, number>>(new Map());
    const autoChatInFlightRef = useRef<Set<string>>(new Set());

    const runAutoTestChatCheck = async (
        accountsToProcess: Account[],
        currentQuotas: Record<string, AccountQuota>,
    ) => {
        if (!autoTestChatEnabled) return;

        const { results } = await executeAutoTestChatForAccounts({
            accounts: accountsToProcess,
            quotas: currentQuotas,
            testChatFn: (accountId, family) =>
                window.api.testAntigravityChat(accountId, family),
            lastTriggeredMap: autoChatLastTriggeredRef.current,
            initialTriggeredSet: autoChatInitialTriggeredRef.current,
            consecutiveErrorMap: autoChatConsecutiveErrorsRef.current,
            inFlightSet: autoChatInFlightRef.current,
        });

        saveLastTriggeredMap(autoChatLastTriggeredRef.current);
        saveInitialTriggeredSet(autoChatInitialTriggeredRef.current);

        if (results.length > 0) {
            const successes = results.filter((r) => r.success);
            const fails = results.filter((r) => !r.success);

            if (results.length === 1) {
                const res = results[0];
                const familyLabel =
                    res.family === 'gemini'
                        ? 'Gemini Models'
                        : 'Claude and GPT models';
                if (res.success) {
                    setAutoChatNotification({
                        type: 'success',
                        text: `Đã tự động gửi chat thử nghiệm ("Say ok") cho tài khoản "${res.accountName}" (${familyLabel}) để kích hoạt chu kỳ 7 ngày.`,
                    });
                } else {
                    setAutoChatNotification({
                        type: 'error',
                        text: `Tự động gửi chat thử nghiệm thất bại cho "${res.accountName}" (${familyLabel}): ${res.message || 'Lỗi không xác định'}`,
                    });
                }
            } else if (fails.length === 0) {
                setAutoChatNotification({
                    type: 'success',
                    text: `Đã tự động gửi chat thử nghiệm thành công cho ${successes.length} tài khoản (${successes.map((s) => s.accountName).join(', ')}) để kích hoạt chu kỳ 7 ngày.`,
                });
            } else {
                setAutoChatNotification({
                    type: 'info',
                    text: `Tự động kích hoạt chu kỳ tuần: thành công ${successes.length} tài khoản, thất bại ${fails.length} tài khoản.`,
                });
            }

            // Đợi 3.5 giây để server Google cập nhật quota trước khi refresh lại
            if (successes.length > 0) {
                setTimeout(() => {
                    for (const s of successes) {
                        const acc = accountsToProcess.find(
                            (a) => a.id === s.accountId,
                        );
                        if (acc) {
                            void refreshAccountQuota(acc);
                        }
                    }
                }, 3500);
            }
        }
    };

    function handleAutoTestChatToggle(enabled: boolean) {
        setAutoTestChatEnabled(enabled);
        try {
            localStorage.setItem(
                AUTO_TEST_CHAT_STORAGE_KEY,
                enabled ? 'true' : 'false',
            );
        } catch {
            // ignore
        }
        if (enabled && data?.accounts) {
            void runAutoTestChatCheck(data.accounts, quotas);
        }
    }

    useEffect(() => {
        if (!autoChatNotification) return;
        const timer = setTimeout(() => {
            setAutoChatNotification(null);
        }, 10_000);
        return () => clearTimeout(timer);
    }, [autoChatNotification]);

    useEffect(() => {
        if (!autoTestChatEnabled) return;

        const agAccounts =
            data?.accounts.filter(
                (account) => account.provider === 'antigravity',
            ) ?? [];
        if (!agAccounts.length) return;

        // Tự động tính thời gian chờ tối ưu dựa trên mốc reset tuần gần nhất của các tài khoản
        const delayMs = calculateNextResetDelayMs(agAccounts, quotas);

        const timerId = setTimeout(() => {
            window.api
                .getAccountsQuota(agAccounts.map((account) => account.id))
                .then((nextQuotas) => {
                    setQuotas((prev) => ({ ...prev, ...nextQuotas }));
                    return runAutoTestChatCheck(agAccounts, nextQuotas);
                })
                .catch((err) => {
                    console.error(
                        'Lỗi kiểm tra định kỳ Antigravity auto test chat:',
                        err,
                    );
                });
        }, delayMs);

        return () => {
            clearTimeout(timerId);
        };
    }, [autoTestChatEnabled, data?.accounts, quotas]);

    const displayedAccounts = useMemo(() => {
        if (selectedProviderId === 'antigravity') {
            return sortAntigravityAccounts(
                providerAccounts,
                quotas,
                antigravitySort,
            );
        }
        return providerAccounts;
    }, [selectedProviderId, providerAccounts, quotas, antigravitySort]);

    const providerUsageLog = useMemo(
        () =>
            data?.usageLog.filter(
                (event) => event.provider === selectedProviderId,
            ) ?? [],
        [data?.usageLog, selectedProviderId],
    );

    const status = selectedProviderId
        ? (statuses?.[selectedProviderId] ?? null)
        : null;

    async function refreshLoginStatuses(accounts: Account[]): Promise<void> {
        if (!accounts.length) {
            setFreeModelLogins({});
            setChatGptLogins({});
            setAntigravityLogins({});
            setCopilotLogins({});
            return;
        }

        const entries = await Promise.all(
            accounts.map(async (account) => {
                if (account.provider === 'codex-chatgpt') {
                    const loginStatus = await window.api.getChatGptLoginStatus(
                        account.id,
                    );
                    return {
                        id: account.id,
                        freeModel: null,
                        chatGpt: loginStatus,
                        antigravity: null,
                        copilot: null,
                    };
                }

                if (account.provider === 'antigravity') {
                    const loginStatus =
                        await window.api.getAntigravityLoginStatus(account.id);
                    return {
                        id: account.id,
                        freeModel: null,
                        chatGpt: null,
                        antigravity: loginStatus,
                        copilot: null,
                    };
                }

                if (account.provider === 'github-copilot') {
                    const loginStatus = await window.api.getCopilotLoginStatus(
                        account.id,
                    );
                    return {
                        id: account.id,
                        freeModel: null,
                        chatGpt: null,
                        antigravity: null,
                        copilot: loginStatus,
                    };
                }

                const loginStatus = await window.api.getFreeModelLoginStatus(
                    account.id,
                );
                return {
                    id: account.id,
                    freeModel: loginStatus,
                    chatGpt: null,
                    antigravity: null,
                    copilot: null,
                };
            }),
        );

        setFreeModelLogins(
            Object.fromEntries(
                entries
                    .filter((item) => item.freeModel)
                    .map((item) => [item.id, item.freeModel!]),
            ),
        );
        setChatGptLogins(
            Object.fromEntries(
                entries
                    .filter((item) => item.chatGpt)
                    .map((item) => [item.id, item.chatGpt!]),
            ),
        );
        setAntigravityLogins(
            Object.fromEntries(
                entries
                    .filter((item) => item.antigravity)
                    .map((item) => [item.id, item.antigravity!]),
            ),
        );
        setCopilotLogins(
            Object.fromEntries(
                entries
                    .filter((item) => item.copilot)
                    .map((item) => [item.id, item.copilot!]),
            ),
        );
    }

    async function refreshQuotas(accounts: Account[]): Promise<void> {
        if (!accounts.length) {
            setQuotas({});
            return;
        }

        setQuotaLoading(true);
        try {
            const next = await window.api.getAccountsQuota(
                accounts.map((account) => account.id),
            );
            setQuotas(next);
            if (autoTestChatEnabled) {
                void runAutoTestChatCheck(accounts, next);
            }
        } catch (err) {
            setError(
                err instanceof Error ? err.message : 'Không thể tải quota',
            );
        } finally {
            setQuotaLoading(false);
        }
    }

    const [refreshingQuotaIds, setRefreshingQuotaIds] = useState<Set<string>>(
        new Set(),
    );

    async function refreshAccountQuota(account: Account): Promise<void> {
        setRefreshingQuotaIds((prev) => new Set(prev).add(account.id));
        try {
            const nextQuota = await window.api.getAccountQuota(
                account.provider,
                account.id,
            );
            setQuotas((prev) => {
                const updated = { ...prev, [account.id]: nextQuota };
                if (autoTestChatEnabled && account.provider === 'antigravity') {
                    void runAutoTestChatCheck([account], updated);
                }
                return updated;
            });
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : `Không thể tải quota tài khoản ${account.name}`,
            );
        } finally {
            setRefreshingQuotaIds((prev) => {
                const next = new Set(prev);
                next.delete(account.id);
                return next;
            });
        }
    }

    async function refresh(): Promise<void> {
        const [providerList, appData, activeStatuses, runtime] =
            await Promise.all([
                window.api.getProviders(),
                window.api.getAppData(),
                window.api.getActiveStatuses(),
                window.api.getRuntimeInfo(),
            ]);
        setProviders(providerList);
        setData(appData);
        setStatuses(activeStatuses);
        setRuntimeInfo(runtime);
        setSelectedProviderId(
            (current) => current ?? providerList[0]?.id ?? null,
        );
        await Promise.all([
            refreshQuotas(appData.accounts),
            refreshLoginStatuses(appData.accounts),
        ]);
    }

    useEffect(() => {
        refresh()
            .catch((err: Error) => setError(err.message))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => {
        if (!selectedProviderId || !statuses?.[selectedProviderId]?.accountId)
            return;
        const accountId = statuses[selectedProviderId].accountId!;
        setExpandedAccounts((current) => {
            if (current.has(accountId)) return current;
            const next = new Set(current);
            next.add(accountId);
            return next;
        });
    }, [selectedProviderId, statuses]);

    function toggleAccountExpanded(accountId: string): void {
        setExpandedAccounts((current) => {
            const next = new Set(current);
            if (next.has(accountId)) {
                next.delete(accountId);
            } else {
                next.add(accountId);
            }
            return next;
        });
    }

    async function handleSwitch(account: Account): Promise<void> {
        // Apply Copilot đóng VS Code để ghi state.vscdb — hành động destructive,
        // phải confirm trước (CODE_REVIEW H3).
        if (
            account.provider === 'github-copilot' &&
            runtimeInfo?.applyCopilotIde &&
            !window.confirm(
                `Chuyển sang "${account.name}" sẽ ĐÓNG VS Code để ghi auth Copilot vào state.vscdb.\n\n` +
                    'Lưu công việc đang làm trong VS Code trước khi tiếp tục.\n\nTiếp tục?',
            )
        ) {
            return;
        }

        setBusyId(account.id);
        setError(null);
        try {
            const nextStatuses = await window.api.switchAccount(account.id);
            setStatuses(nextStatuses);
            await refresh();
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : 'Không thể chuyển tài khoản',
            );
        } finally {
            setBusyId(null);
        }
    }

    async function handleDelete(account: Account): Promise<void> {
        const confirmed = window.confirm(`Xóa tài khoản "${account.name}"?`);
        if (!confirmed) return;

        setBusyId(account.id);
        setError(null);
        try {
            await window.api.deleteAccount(account.id);
            await refresh();
        } catch (err) {
            setError(
                err instanceof Error ? err.message : 'Không thể xóa tài khoản',
            );
        } finally {
            setBusyId(null);
        }
    }

    function openCreateDialog(): void {
        if (!selectedProviderId) return;
        setEditingAccount(null);
        setDialogOpen(true);
    }

    function openEditDialog(account: Account): void {
        setEditingAccount(account);
        setSelectedProviderId(account.provider);
        setDialogOpen(true);
    }

    async function handleFreeModelSubmit(input: {
        name: string;
        apiKey: string;
        model: string;
        modelReasoningEffort: Account['settings']['modelReasoningEffort'];
        note?: string;
    }): Promise<void> {
        if (editingAccount) {
            await window.api.updateAccount(editingAccount.id, {
                name: input.name,
                apiKey: input.apiKey || undefined,
                settings: {
                    model: input.model,
                    modelReasoningEffort: input.modelReasoningEffort,
                },
                note: input.note,
            });
        } else {
            await window.api.addAccount({
                name: input.name,
                provider: 'codex-freemodel',
                apiKey: input.apiKey,
                settings: {
                    model: input.model,
                    modelReasoningEffort: input.modelReasoningEffort,
                },
                note: input.note,
            });
        }

        setDialogOpen(false);
        setEditingAccount(null);
        await refresh();
    }

    async function handleChatGptSubmit(input: {
        name: string;
        model: string;
        modelReasoningEffort: Account['settings']['modelReasoningEffort'];
        note?: string;
    }): Promise<void> {
        if (editingAccount) {
            await window.api.updateAccount(editingAccount.id, {
                name: input.name,
                settings: {
                    model: input.model,
                    modelReasoningEffort: input.modelReasoningEffort,
                },
                note: input.note,
            });
        } else {
            await window.api.addAccount({
                name: input.name,
                provider: 'codex-chatgpt',
                settings: {
                    model: input.model,
                    modelReasoningEffort: input.modelReasoningEffort,
                },
                note: input.note,
            });
        }

        setDialogOpen(false);
        setEditingAccount(null);
        await refresh();
    }

    async function handleAntigravitySubmit(input: {
        name: string;
        note?: string;
        settings?: Partial<CodexSettings>;
    }): Promise<void> {
        if (editingAccount) {
            await window.api.updateAccount(editingAccount.id, {
                name: input.name,
                note: input.note,
                settings: input.settings,
            });
        } else {
            await window.api.addAccount({
                name: input.name,
                provider: 'antigravity',
                note: input.note,
                settings: input.settings,
            });
        }

        setDialogOpen(false);
        setEditingAccount(null);
        await refresh();
    }

    async function handleCopilotSubmit(input: {
        name: string;
        note?: string;
    }): Promise<void> {
        if (editingAccount) {
            await window.api.updateAccount(editingAccount.id, {
                name: input.name,
                note: input.note,
            });
        } else {
            await window.api.addAccount({
                name: input.name,
                provider: 'github-copilot',
                note: input.note,
            });
        }

        setDialogOpen(false);
        setEditingAccount(null);
        await refresh();
    }

    function getLoginInfo(account: Account): {
        loggedIn: boolean;
        email?: string;
        label: string;
    } {
        if (account.provider === 'codex-chatgpt') {
            const login = chatGptLogins[account.id];
            return {
                loggedIn: Boolean(login?.loggedIn),
                email: login?.email ?? account.chatgptEmail,
                label: login?.loggedIn
                    ? 'Quản lý ChatGPT'
                    : 'Đăng nhập ChatGPT',
            };
        }

        if (account.provider === 'antigravity') {
            const login = antigravityLogins[account.id];
            return {
                loggedIn: Boolean(login?.loggedIn),
                email: login?.email ?? account.antigravityEmail,
                label: login?.loggedIn
                    ? 'Quản lý Antigravity'
                    : 'Đăng nhập Antigravity',
            };
        }

        if (account.provider === 'github-copilot') {
            const login = copilotLogins[account.id];
            const username = login?.username ?? account.copilotUsername;
            return {
                loggedIn: Boolean(login?.loggedIn),
                email: username ? `@${username}` : undefined,
                label: login?.loggedIn ? 'Quản lý Copilot' : 'Import Copilot',
            };
        }

        const login = freeModelLogins[account.id];
        return {
            loggedIn: Boolean(login?.loggedIn),
            email: login?.email ?? account.freemodelEmail,
            label: login?.loggedIn
                ? 'Quản lý FreeModel'
                : 'Đăng nhập FreeModel',
        };
    }

    function renderQuotaPanel(account: Account, compact = false): JSX.Element {
        const loginInfo = getLoginInfo(account);
        const isRefreshing = refreshingQuotaIds.has(account.id);

        return (
            <QuotaPanel
                quota={quotas[account.id] ?? null}
                loading={
                    (quotaLoading && !quotas[account.id]) ||
                    (isRefreshing && !quotas[account.id])
                }
                refreshing={isRefreshing}
                onRefresh={() => refreshAccountQuota(account)}
                loginStatus={
                    loginInfo.loggedIn
                        ? { loggedIn: true, email: loginInfo.email }
                        : null
                }
                loginPrompt={
                    account.provider === 'antigravity'
                        ? 'Đăng nhập Antigravity để xem quota'
                        : account.provider === 'github-copilot'
                          ? 'Import auth Copilot để xem quota'
                          : account.provider === 'codex-chatgpt'
                            ? 'Đăng nhập ChatGPT để xem quota'
                            : 'Đăng nhập FreeModel để xem quota'
                }
                onLogin={() => setLoginAccount(account)}
                onTestChat={
                    account.provider === 'antigravity'
                        ? async (family) => {
                              const res = await window.api.testAntigravityChat(
                                  account.id,
                                  family,
                              );
                              if (res?.success) {
                                  await refreshAccountQuota(account);
                              }
                              return res;
                          }
                        : undefined
                }
                compact={compact}
            />
        );
    }

    function countAccountsForProvider(providerId: ProviderId): number {
        return (
            data?.accounts.filter((account) => account.provider === providerId)
                .length ?? 0
        );
    }

    function isProviderActive(providerId: ProviderId): boolean {
        return Boolean(statuses?.[providerId]?.accountId);
    }

    const activeAccount = status?.accountId
        ? data?.accounts.find((account) => account.id === status.accountId)
        : undefined;
    const providerActiveAccount =
        activeAccount?.provider === selectedProviderId ? activeAccount : null;
    const providerActiveQuota = providerActiveAccount
        ? quotas[providerActiveAccount.id]
        : null;
    const providerActiveLoginInfo = providerActiveAccount
        ? getLoginInfo(providerActiveAccount)
        : null;

    if (loading) {
        return <div className='main'>Đang tải...</div>;
    }

    return (
        <div className='app'>
            <aside className='sidebar'>
                <div className='brand'>
                    <div className='brand-mark'>AI</div>
                    <div>
                        <h1>AI Switcher</h1>
                        <p>Quản lý & chuyển tài khoản AI</p>
                    </div>
                </div>

                <nav className='sidebar-nav'>
                    <div className='sidebar-nav-label'>Providers</div>
                    {providers.map((provider) => {
                        const isSelected = selectedProviderId === provider.id;
                        const accountCount = countAccountsForProvider(
                            provider.id,
                        );
                        const isActive = isProviderActive(provider.id);

                        return (
                            <button
                                key={provider.id}
                                type='button'
                                className={`sidebar-nav-item ${isSelected ? 'active' : ''}`}
                                onClick={() => {
                                    setSelectedProviderId(provider.id);
                                    setError(null);
                                }}
                            >
                                <div className='sidebar-nav-item-head'>
                                    <span className='sidebar-nav-title'>
                                        {providerShortLabel(provider.id)}
                                    </span>
                                    {isActive && (
                                        <span
                                            className='sidebar-nav-dot'
                                            title='Đang active'
                                        />
                                    )}
                                </div>
                                <span className='sidebar-nav-sub'>
                                    {accountCount} tài khoản ·{' '}
                                    {provider.toolName}
                                </span>
                            </button>
                        );
                    })}
                </nav>
            </aside>

            <main className='main'>
                {runtimeInfo?.env === 'development' && (
                    <div className='dev-banner'>
                        <strong>Development</strong>
                        <span>
                            Dữ liệu: {runtimeInfo.appDataDir} · Codex:{' '}
                            {runtimeInfo.codexHome}
                            {!runtimeInfo.applyAntigravityIde
                                ? ' · Antigravity IDE sync: tắt'
                                : ''}
                            {!runtimeInfo.applyCopilotIde
                                ? ' · Copilot IDE sync: tắt'
                                : ''}
                        </span>
                    </div>
                )}
                {!selectedProvider || !selectedProviderId ? (
                    <div className='empty-state'>Chọn provider từ sidebar.</div>
                ) : (
                    <>
                        <div className='header'>
                            <div>
                                <h2>{selectedProvider.name}</h2>
                                <p>
                                    {providerDescription(
                                        selectedProviderId,
                                        selectedProvider.configDir,
                                    )}
                                </p>
                                <div className='header-meta'>
                                    Config: {selectedProvider.configDir}
                                </div>
                            </div>

                            <div
                                className={`status-card ${
                                    providerActiveAccount ||
                                    isProviderActive(selectedProviderId)
                                        ? ''
                                        : 'inactive'
                                }`}
                            >
                                <div className='status-label'>
                                    Active trong provider này
                                </div>
                                <div className='status-value'>
                                    {providerActiveAccount?.name ??
                                        (isProviderActive(selectedProviderId)
                                            ? status?.accountName
                                            : 'Chưa chọn')}
                                </div>
                                {providerActiveAccount ||
                                isProviderActive(selectedProviderId) ? (
                                    <div className='status-meta'>
                                        {authModeLabel(status?.authMode)} ·{' '}
                                        {selectedProviderId === 'antigravity'
                                            ? status?.authExists
                                                ? 'accounts.json ✓'
                                                : 'accounts.json ✗'
                                            : selectedProviderId ===
                                                'github-copilot'
                                              ? status?.authExists
                                                  ? 'state.vscdb ✓'
                                                  : 'state.vscdb ✗'
                                              : `${status?.configExists ? 'config.toml ✓' : 'config.toml ✗'} · ${status?.authExists ? 'auth.json ✓' : 'auth.json ✗'}`}
                                    </div>
                                ) : (
                                    <div className='status-meta'>
                                        Chuyển sang một tài khoản bên dưới
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className='provider-toolbar'>
                            <div className='provider-toolbar-start'>
                                <button
                                    className='btn btn-primary'
                                    onClick={openCreateDialog}
                                >
                                    + Thêm tài khoản
                                </button>
                                <button
                                    className='btn btn-secondary'
                                    onClick={() =>
                                        window.api.openDocs(selectedProviderId)
                                    }
                                >
                                    Tài liệu
                                </button>
                                {selectedProviderId === 'antigravity' ? (
                                    <button
                                        className='btn btn-secondary'
                                        onClick={() =>
                                            window.api.openAntigravityDir()
                                        }
                                    >
                                        Mở config opencode
                                    </button>
                                ) : selectedProviderId === 'github-copilot' ? (
                                    <button
                                        className='btn btn-secondary'
                                        onClick={() =>
                                            window.api.openCopilotDir()
                                        }
                                    >
                                        Mở globalStorage
                                    </button>
                                ) : (
                                    <button
                                        className='btn btn-secondary'
                                        onClick={() =>
                                            window.api.openCodexDir()
                                        }
                                    >
                                        Mở ~/.codex
                                    </button>
                                )}
                                <button
                                    className='btn btn-ghost'
                                    disabled={
                                        quotaLoading || !providerAccounts.length
                                    }
                                    onClick={() =>
                                        refreshQuotas(providerAccounts)
                                    }
                                >
                                    {quotaLoading
                                        ? 'Đang tải quota...'
                                        : 'Làm mới quota'}
                                </button>
                            </div>
                            <button
                                type='button'
                                className={`btn btn-icon usage-log-toggle ${usageLogVisible ? 'active' : ''}`}
                                onClick={() =>
                                    setUsageLogVisible((visible) => !visible)
                                }
                                aria-pressed={usageLogVisible}
                                aria-label={
                                    usageLogVisible
                                        ? 'Ẩn nhật ký'
                                        : 'Hiện nhật ký'
                                }
                                title={
                                    usageLogVisible
                                        ? 'Ẩn nhật ký'
                                        : 'Hiện nhật ký'
                                }
                            >
                                <svg
                                    viewBox='0 0 24 24'
                                    fill='none'
                                    stroke='currentColor'
                                    strokeWidth='2'
                                >
                                    <path
                                        d='M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01'
                                        strokeLinecap='round'
                                        strokeLinejoin='round'
                                    />
                                </svg>
                            </button>
                        </div>

                        {error && (
                            <div className='inline-message error'>{error}</div>
                        )}
                        {autoChatNotification && (
                            <div
                                className={`inline-message ${autoChatNotification.type} auto-chat-notification`}
                            >
                                <div className='auto-chat-notification-content'>
                                    <span
                                        className='auto-chat-notification-icon'
                                        aria-hidden='true'
                                    >
                                        {autoChatNotification.type === 'success'
                                            ? '✓'
                                            : 'ℹ'}
                                    </span>
                                    <span>{autoChatNotification.text}</span>
                                </div>
                                <button
                                    type='button'
                                    className='btn-dismiss'
                                    onClick={() =>
                                        setAutoChatNotification(null)
                                    }
                                    aria-label='Đóng thông báo'
                                >
                                    ×
                                </button>
                            </div>
                        )}

                        {providerActiveAccount && (
                            <section className='header-quota'>
                                <div className='panel'>
                                    <div className='panel-header'>
                                        <h3>
                                            Quota active —{' '}
                                            {providerActiveAccount.name}
                                        </h3>
                                        <div className='panel-header-actions'>
                                            <button
                                                className='btn btn-ghost'
                                                disabled={refreshingQuotaIds.has(
                                                    providerActiveAccount.id,
                                                )}
                                                onClick={() =>
                                                    refreshAccountQuota(
                                                        providerActiveAccount,
                                                    )
                                                }
                                            >
                                                {refreshingQuotaIds.has(
                                                    providerActiveAccount.id,
                                                )
                                                    ? 'Đang tải...'
                                                    : 'Làm mới quota'}
                                            </button>
                                            <button
                                                className='btn btn-ghost'
                                                onClick={() =>
                                                    setLoginAccount(
                                                        providerActiveAccount,
                                                    )
                                                }
                                            >
                                                {providerActiveLoginInfo?.label}
                                            </button>
                                        </div>
                                    </div>
                                    <div className='panel-body'>
                                        <QuotaPanel
                                            quota={providerActiveQuota ?? null}
                                            loading={
                                                quotaLoading &&
                                                !providerActiveQuota
                                            }
                                            refreshing={refreshingQuotaIds.has(
                                                providerActiveAccount.id,
                                            )}
                                            onRefresh={() =>
                                                refreshAccountQuota(
                                                    providerActiveAccount,
                                                )
                                            }
                                            loginStatus={
                                                providerActiveLoginInfo?.loggedIn
                                                    ? {
                                                          loggedIn: true,
                                                          email: providerActiveLoginInfo.email,
                                                      }
                                                    : null
                                            }
                                            loginPrompt={
                                                selectedProviderId ===
                                                'antigravity'
                                                    ? 'Đăng nhập Antigravity để xem quota'
                                                    : selectedProviderId ===
                                                        'github-copilot'
                                                      ? 'Import auth Copilot để xem quota'
                                                      : selectedProviderId ===
                                                          'codex-chatgpt'
                                                        ? 'Đăng nhập ChatGPT để xem quota'
                                                        : 'Đăng nhập FreeModel để xem quota'
                                            }
                                            onLogin={() =>
                                                setLoginAccount(
                                                    providerActiveAccount,
                                                )
                                            }
                                            onTestChat={
                                                selectedProviderId ===
                                                'antigravity'
                                                    ? async (family) => {
                                                          const res =
                                                              await window.api.testAntigravityChat(
                                                                  providerActiveAccount.id,
                                                                  family,
                                                              );
                                                          if (res?.success) {
                                                              await refreshAccountQuota(
                                                                  providerActiveAccount,
                                                              );
                                                          }
                                                          return res;
                                                      }
                                                    : undefined
                                            }
                                        />
                                    </div>
                                </div>
                            </section>
                        )}

                        <div
                            className={`grid${usageLogVisible ? '' : ' grid-single'}`}
                        >
                            <section className='panel'>
                                <div className='panel-header'>
                                    <h3>
                                        Tài khoản{' '}
                                        {providerLabel(selectedProviderId)} (
                                        {displayedAccounts.length})
                                    </h3>
                                    {selectedProviderId === 'antigravity' && (
                                        <div className='panel-header-actions'>
                                            <div
                                                className={`ag-auto-chat-pill ${autoTestChatEnabled ? 'active' : ''}`}
                                                onClick={() =>
                                                    handleAutoTestChatToggle(
                                                        !autoTestChatEnabled,
                                                    )
                                                }
                                                title="Tự động gửi chat thử nghiệm ('Say ok') cho nhóm Gemini và Claude & GPT khi đến thời gian reset tuần hoặc quota tuần đạt 100% để kích hoạt chu kỳ 7 ngày mới (bảo vệ hạn mức 5h, chống spam và tự động thử lại khi lỗi)"
                                                role='checkbox'
                                                aria-checked={
                                                    autoTestChatEnabled
                                                }
                                                tabIndex={0}
                                                onKeyDown={(e) => {
                                                    if (
                                                        e.key === ' ' ||
                                                        e.key === 'Enter'
                                                    ) {
                                                        e.preventDefault();
                                                        handleAutoTestChatToggle(
                                                            !autoTestChatEnabled,
                                                        );
                                                    }
                                                }}
                                            >
                                                <span className='ag-auto-chat-switch'>
                                                    <span className='ag-auto-chat-knob' />
                                                </span>
                                                <span className='ag-auto-chat-text'>
                                                    Auto gửi khi tuần 100%
                                                </span>
                                            </div>
                                            <label
                                                htmlFor='ag-sort-select'
                                                className='sort-label'
                                            >
                                                Sắp xếp:
                                            </label>
                                            <select
                                                id='ag-sort-select'
                                                className='sort-select'
                                                value={antigravitySort}
                                                onChange={(e) =>
                                                    handleAntigravitySortChange(
                                                        e.target
                                                            .value as AntigravitySortOption,
                                                    )
                                                }
                                            >
                                                <option value='default'>
                                                    Default (sort theo hiện tại)
                                                </option>
                                                <option value='gemini-desc'>
                                                    Thời gian reset Quota của
                                                    Gemini giảm dần
                                                </option>
                                                <option value='gemini-asc'>
                                                    Thời gian reset Quota của
                                                    Gemini tăng dần
                                                </option>
                                                <option value='claude-desc'>
                                                    Thời gian reset Quota Claude
                                                    and GPT giảm dần
                                                </option>
                                                <option value='claude-asc'>
                                                    Thời gian reset Quota Claude
                                                    and GPT tăng dần
                                                </option>
                                            </select>
                                        </div>
                                    )}
                                </div>
                                <div className='panel-body'>
                                    {!displayedAccounts.length ? (
                                        <div className='empty-state'>
                                            Chưa có tài khoản{' '}
                                            {providerLabel(selectedProviderId)}.
                                            Bấm &quot;Thêm tài khoản&quot; để
                                            bắt đầu.
                                        </div>
                                    ) : (
                                        <div className='account-list'>
                                            {displayedAccounts.map(
                                                (account) => {
                                                    const isActive =
                                                        statuses?.[
                                                            account.provider
                                                        ]?.accountId ===
                                                        account.id;
                                                    const loginInfo =
                                                        getLoginInfo(account);
                                                    const isExpanded =
                                                        expandedAccounts.has(
                                                            account.id,
                                                        );

                                                    return (
                                                        <article
                                                            key={account.id}
                                                            className={`account-card ${isActive ? 'active' : ''} ${isExpanded ? 'expanded' : 'collapsed'}`}
                                                        >
                                                            <button
                                                                type='button'
                                                                className='account-card-header'
                                                                onClick={() =>
                                                                    toggleAccountExpanded(
                                                                        account.id,
                                                                    )
                                                                }
                                                                aria-expanded={
                                                                    isExpanded
                                                                }
                                                            >
                                                                <div className='account-card-header-main'>
                                                                    <div className='account-title'>
                                                                        <strong>
                                                                            {
                                                                                account.name
                                                                            }
                                                                        </strong>
                                                                        {isActive && (
                                                                            <span className='badge'>
                                                                                Active
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                    <div className='account-meta account-summary'>
                                                                        {account.provider ===
                                                                        'codex-freemodel'
                                                                            ? `Key: ${account.apiKeyMasked ?? maskKey(account.apiKey)}`
                                                                            : `Auth: ${loginInfo.loggedIn ? (loginInfo.email ?? 'OAuth') : 'Chưa login'}`}
                                                                        {account.provider !==
                                                                            'antigravity' &&
                                                                            account.provider !==
                                                                                'github-copilot' && (
                                                                                <>
                                                                                    {' '}
                                                                                    ·{' '}
                                                                                    {
                                                                                        account
                                                                                            .settings
                                                                                            .model
                                                                                    }
                                                                                </>
                                                                            )}
                                                                        {!isExpanded && (
                                                                            <>
                                                                                {' '}
                                                                                ·
                                                                                Chuyển:{' '}
                                                                                {
                                                                                    account.switchCount
                                                                                }{' '}
                                                                                lần
                                                                            </>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                                <span
                                                                    className={`collapse-toggle ${isExpanded ? 'expanded' : ''}`}
                                                                    aria-hidden='true'
                                                                >
                                                                    <svg
                                                                        viewBox='0 0 24 24'
                                                                        fill='none'
                                                                        stroke='currentColor'
                                                                        strokeWidth='2.5'
                                                                    >
                                                                        <path
                                                                            d='M9 6l6 6-6 6'
                                                                            strokeLinecap='round'
                                                                            strokeLinejoin='round'
                                                                        />
                                                                    </svg>
                                                                </span>
                                                            </button>

                                                            {isExpanded && (
                                                                <div className='account-card-body'>
                                                                    <div className='account-meta'>
                                                                        {account.provider ===
                                                                        'codex-freemodel'
                                                                            ? `Key: ${account.apiKeyMasked ?? maskKey(account.apiKey)}`
                                                                            : `Auth: ${loginInfo.loggedIn ? (loginInfo.email ?? 'OAuth') : 'Chưa login'}`}
                                                                        {account.provider !==
                                                                            'antigravity' &&
                                                                            account.provider !==
                                                                                'github-copilot' && (
                                                                                <>
                                                                                    {' '}
                                                                                    ·
                                                                                    Model:{' '}
                                                                                    {
                                                                                        account
                                                                                            .settings
                                                                                            .model
                                                                                    }
                                                                                </>
                                                                            )}{' '}
                                                                        ·
                                                                        Chuyển:{' '}
                                                                        {
                                                                            account.switchCount
                                                                        }{' '}
                                                                        lần
                                                                    </div>
                                                                    <div className='account-meta'>
                                                                        Lần
                                                                        cuối:{' '}
                                                                        {formatDate(
                                                                            account.lastUsedAt,
                                                                        )}
                                                                    </div>
                                                                    {account.note && (
                                                                        <div className='account-note'>
                                                                            {
                                                                                account.note
                                                                            }
                                                                        </div>
                                                                    )}
                                                                    {renderQuotaPanel(
                                                                        account,
                                                                        true,
                                                                    )}
                                                                </div>
                                                            )}

                                                            <div className='account-actions'>
                                                                <button
                                                                    className='btn btn-ghost'
                                                                    onClick={() =>
                                                                        setLoginAccount(
                                                                            account,
                                                                        )
                                                                    }
                                                                >
                                                                    Login
                                                                </button>
                                                                <button
                                                                    className='btn btn-ghost'
                                                                    disabled={refreshingQuotaIds.has(
                                                                        account.id,
                                                                    )}
                                                                    onClick={() =>
                                                                        refreshAccountQuota(
                                                                            account,
                                                                        )
                                                                    }
                                                                    title={`Làm mới quota tài khoản ${account.name}`}
                                                                >
                                                                    {refreshingQuotaIds.has(
                                                                        account.id,
                                                                    )
                                                                        ? 'Đang tải...'
                                                                        : 'Làm mới quota'}
                                                                </button>
                                                                <button
                                                                    className='btn btn-primary'
                                                                    disabled={
                                                                        busyId ===
                                                                            account.id ||
                                                                        isActive
                                                                    }
                                                                    onClick={() =>
                                                                        handleSwitch(
                                                                            account,
                                                                        )
                                                                    }
                                                                >
                                                                    {isActive
                                                                        ? 'Đang dùng'
                                                                        : 'Chuyển sang'}
                                                                </button>
                                                                <button
                                                                    className='btn btn-secondary'
                                                                    onClick={() =>
                                                                        openEditDialog(
                                                                            account,
                                                                        )
                                                                    }
                                                                >
                                                                    Sửa
                                                                </button>
                                                                <button
                                                                    className='btn btn-danger'
                                                                    disabled={
                                                                        busyId ===
                                                                        account.id
                                                                    }
                                                                    onClick={() =>
                                                                        handleDelete(
                                                                            account,
                                                                        )
                                                                    }
                                                                >
                                                                    Xóa
                                                                </button>
                                                            </div>
                                                        </article>
                                                    );
                                                },
                                            )}
                                        </div>
                                    )}
                                </div>
                            </section>

                            {usageLogVisible && (
                                <section className='panel'>
                                    <div className='panel-header'>
                                        <h3>
                                            Nhật ký —{' '}
                                            {providerLabel(selectedProviderId)}
                                        </h3>
                                    </div>
                                    <div className='panel-body'>
                                        {!providerUsageLog.length ? (
                                            <div className='empty-state'>
                                                Chưa có hoạt động cho provider
                                                này.
                                            </div>
                                        ) : (
                                            <div className='usage-list'>
                                                {providerUsageLog.map(
                                                    (event) => (
                                                        <div
                                                            key={event.id}
                                                            className='usage-item'
                                                        >
                                                            <strong>
                                                                {
                                                                    event.accountName
                                                                }{' '}
                                                                · {event.action}
                                                            </strong>
                                                            <span>
                                                                {formatDate(
                                                                    event.timestamp,
                                                                )}{' '}
                                                                ·{' '}
                                                                {event.success
                                                                    ? 'OK'
                                                                    : 'Lỗi'}
                                                                {event.message
                                                                    ? ` · ${event.message}`
                                                                    : ''}
                                                            </span>
                                                        </div>
                                                    ),
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </section>
                            )}
                        </div>
                    </>
                )}
            </main>

            {dialogOpen && selectedProviderId === 'codex-freemodel' && (
                <AccountDialog
                    account={
                        editingAccount?.provider === 'codex-freemodel'
                            ? editingAccount
                            : null
                    }
                    onClose={() => {
                        setDialogOpen(false);
                        setEditingAccount(null);
                    }}
                    onSubmit={handleFreeModelSubmit}
                />
            )}

            {dialogOpen && selectedProviderId === 'codex-chatgpt' && (
                <ChatGptAccountDialog
                    account={
                        editingAccount?.provider === 'codex-chatgpt'
                            ? editingAccount
                            : null
                    }
                    onClose={() => {
                        setDialogOpen(false);
                        setEditingAccount(null);
                    }}
                    onSubmit={handleChatGptSubmit}
                />
            )}

            {dialogOpen && selectedProviderId === 'antigravity' && (
                <AntigravityAccountDialog
                    account={
                        editingAccount?.provider === 'antigravity'
                            ? editingAccount
                            : null
                    }
                    onClose={() => {
                        setDialogOpen(false);
                        setEditingAccount(null);
                    }}
                    onSubmit={handleAntigravitySubmit}
                />
            )}

            {dialogOpen && selectedProviderId === 'github-copilot' && (
                <CopilotAccountDialog
                    account={
                        editingAccount?.provider === 'github-copilot'
                            ? editingAccount
                            : null
                    }
                    onClose={() => {
                        setDialogOpen(false);
                        setEditingAccount(null);
                    }}
                    onSubmit={handleCopilotSubmit}
                />
            )}

            {loginAccount?.provider === 'codex-freemodel' && (
                <FreeModelLoginDialog
                    account={loginAccount}
                    onClose={() => setLoginAccount(null)}
                    onSuccess={async () => {
                        await refresh();
                    }}
                />
            )}

            {loginAccount?.provider === 'codex-chatgpt' && (
                <ChatGptLoginDialog
                    account={loginAccount}
                    onClose={() => setLoginAccount(null)}
                    onSuccess={async () => {
                        await refresh();
                    }}
                />
            )}

            {loginAccount?.provider === 'antigravity' && (
                <AntigravityLoginDialog
                    account={loginAccount}
                    onClose={() => setLoginAccount(null)}
                    onSuccess={async () => {
                        await refresh();
                    }}
                />
            )}

            {loginAccount?.provider === 'github-copilot' && (
                <CopilotLoginDialog
                    account={loginAccount}
                    onClose={() => setLoginAccount(null)}
                    onSuccess={async () => {
                        await refresh();
                    }}
                />
            )}
        </div>
    );
}
