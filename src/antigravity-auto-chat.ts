import type { Account, AccountQuota, ModelQuotaWindow } from './types';

export const DEFAULT_AUTO_TEST_CHAT_COOLDOWN_MS = 30 * 60 * 1000; // 30 phút cooldown tránh gửi lặp lại
export const DEFAULT_AUTO_TEST_CHAT_ERROR_COOLDOWN_MS = 2 * 60 * 1000; // 2 phút cooldown thử lại khi gặp lỗi
export const DEFAULT_AUTO_TEST_CHAT_INTERVAL_MS = 15 * 60 * 1000; // 15 phút kiểm tra ngầm định kỳ
export const DEFAULT_AUTO_TEST_CHAT_PENDING_RESET_INTERVAL_MS = 30 * 1000; // 30 giây kiểm tra lại khi tài khoản đã đến hạn reset nhưng quota chưa về 100%
export const DEFAULT_AUTO_TEST_CHAT_ERROR_RETRY_MS = 30 * 1000; // 30 giây thử lại khi gặp lỗi mạng/API
export const DEFAULT_AUTO_TEST_CHAT_UNSTARTED_TTL_MS = 24 * 60 * 60 * 1000; // 24 giờ TTL cho chu kỳ chưa kích hoạt (tránh chặn vĩnh viễn)
export const AUTO_TEST_CHAT_STORAGE_KEY =
    'ai-switcher:antigravity-auto-test-chat';
export const AUTO_TEST_CHAT_LAST_TRIGGERED_KEY =
    'ai-switcher:antigravity-auto-chat-last-triggered';
export const AUTO_TEST_CHAT_INITIAL_TRIGGERED_KEY =
    'ai-switcher:antigravity-auto-chat-initial-triggered';

/**
 * Kiểm tra xem một cửa sổ quota có phải là cửa sổ tuần (weekly / 7 ngày) hay không.
 */
export function isWeeklyWindow(
    window: Partial<
        Pick<ModelQuotaWindow, 'windowId' | 'windowLabel' | 'windowSeconds'>
    >,
): boolean {
    if (window.windowId === 'weekly') return true;
    if (
        typeof window.windowSeconds === 'number' &&
        window.windowSeconds >= 604800
    )
        return true;
    const label = (window.windowLabel ?? '').toLowerCase();
    const id = (window.windowId ?? '').toLowerCase();
    return (
        /week|tuần|7\s*ngày|7\s*days/i.test(label) ||
        /week|tuần|7\s*ngày|7\s*days/i.test(id)
    );
}

/**
 * Kiểm tra xem một cửa sổ quota có đang đạt 100% hay không (100% còn lại hoặc 0% đã dùng).
 */
export function isWindow100Percent(window: ModelQuotaWindow): boolean {
    if (window.disabled) return false;
    return (
        (typeof window.remainingPercent === 'number' &&
            window.remainingPercent >= 100) ||
        (typeof window.usedPercent === 'number' && window.usedPercent === 0)
    );
}

/**
 * Lấy mốc thời gian reset tuần (resetsAt tính bằng giây) của nhóm Gemini hoặc Claude & GPT cho một tài khoản.
 * Trả về null nếu nhóm chưa kích hoạt chu kỳ tuần hoặc không có mốc reset hợp lệ.
 */
export function getWeeklyResetTimestamp(
    quota: AccountQuota | undefined | null,
    family: 'gemini' | 'claude',
): number | null {
    if (!quota?.models?.length) {
        return null;
    }

    const isGemini = family === 'gemini';
    const matcher = isGemini ? /gemini/i : /(claude|gpt|3p)/i;

    const matchingModels = quota.models.filter(
        (m) => matcher.test(m.label) || matcher.test(m.modelId),
    );

    if (!matchingModels.length) {
        return null;
    }

    const candidates: number[] = [];

    for (const model of matchingModels) {
        const weeklyWindows = (model.windows ?? []).filter(
            (w) =>
                !w.disabled &&
                isWeeklyWindow(w) &&
                typeof w.resetsAt === 'number' &&
                Number.isFinite(w.resetsAt) &&
                w.resetsAt > 0,
        );

        if (weeklyWindows.length > 0) {
            for (const w of weeklyWindows) {
                candidates.push(w.resetsAt!);
            }
        } else if (!model.windows || model.windows.length === 0) {
            const isWeekly =
                (model.windowLabel &&
                    isWeeklyWindow({
                        windowId: model.modelId,
                        windowLabel: model.windowLabel,
                        windowSeconds: model.windowSeconds,
                    })) ||
                (typeof model.windowSeconds === 'number' &&
                    model.windowSeconds >= 604800);

            if (
                isWeekly &&
                typeof model.resetsAt === 'number' &&
                Number.isFinite(model.resetsAt) &&
                model.resetsAt > 0
            ) {
                candidates.push(model.resetsAt);
            }
        }
    }

    if (!candidates.length) {
        return null;
    }

    return Math.min(...candidates);
}

/**
 * Kiểm tra xem cửa sổ ngắn hạn (ví dụ cửa sổ 5 giờ / hourly) của nhóm model có đang bị cạn kiệt hay không.
 * Nếu cửa sổ ngắn hạn cạn kiệt (remainingPercent <= 0 hoặc usedPercent >= 100 hoặc disabled),
 * việc gửi chat thử nghiệm sẽ bị lỗi 429 Too Many Requests / Resource Exhausted, nên không nên gửi.
 */
export function isFamilyShortTermExhausted(
    quota: AccountQuota | undefined | null,
    family: 'gemini' | 'claude',
): boolean {
    if (!quota?.models?.length) {
        return false;
    }

    const isGemini = family === 'gemini';
    const matcher = isGemini ? /gemini/i : /(claude|gpt|3p)/i;

    const matchingModels = quota.models.filter(
        (m) => matcher.test(m.label) || matcher.test(m.modelId),
    );

    if (!matchingModels.length) {
        return false;
    }

    for (const model of matchingModels) {
        const shortWindows = (model.windows ?? []).filter(
            (w) => !w.disabled && !isWeeklyWindow(w),
        );
        if (shortWindows.length > 0) {
            const allExhausted = shortWindows.every(
                (w) =>
                    (typeof w.remainingPercent === 'number' &&
                        w.remainingPercent <= 0) ||
                    (typeof w.usedPercent === 'number' && w.usedPercent >= 100),
            );
            if (allExhausted) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Kiểm tra xem nhóm model (gemini | claude) có cửa sổ quota tuần đang đạt 100% hay không.
 */
export function hasWeeklyQuota100Percent(
    quota: AccountQuota | undefined | null,
    family: 'gemini' | 'claude',
): boolean {
    if (!quota?.models?.length) {
        return false;
    }

    const isGemini = family === 'gemini';
    const matcher = isGemini ? /gemini/i : /(claude|gpt|3p)/i;

    const matchingModels = quota.models.filter(
        (m) => matcher.test(m.label) || matcher.test(m.modelId),
    );

    if (!matchingModels.length) {
        return false;
    }

    for (const model of matchingModels) {
        const weeklyWindows = (model.windows ?? []).filter(
            (w) => !w.disabled && isWeeklyWindow(w),
        );

        if (weeklyWindows.length > 0) {
            const has100 = weeklyWindows.some((w) => isWindow100Percent(w));
            if (has100) return true;
        } else if (!model.windows || model.windows.length === 0) {
            const isWeekly =
                (model.windowLabel &&
                    isWeeklyWindow({
                        windowId: model.modelId,
                        windowLabel: model.windowLabel,
                        windowSeconds: model.windowSeconds,
                    })) ||
                (typeof model.windowSeconds === 'number' &&
                    model.windowSeconds >= 604800);

            if (
                isWeekly &&
                (model.remainingPercent >= 100 || model.usedPercent === 0)
            ) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Kiểm tra xem quota tuần của nhóm Gemini hoặc Claude & GPT của một tài khoản đã đến lúc reset (cần gửi chat thử nghiệm) hay chưa.
 *
 * Quy tắc:
 * 1. Kiểm tra an toàn: Nếu cửa sổ ngắn hạn (5h) đang cạn kiệt (0%), không kích hoạt để tránh lỗi 429.
 * 2. Quota tuần bắt buộc phải đang đạt 100% (chưa kích hoạt chu kỳ hoặc Google đã reset xong 100%).
 * 3. Nếu nhóm ĐÃ CÓ thời gian reset tuần (resetsAt):
 *    - nowSeconds >= resetsAt VÀ quota tuần đạt 100%: Đã đến hoặc qua thời gian reset tuần và quota đã khôi phục -> gửi chat thử nghiệm để kích hoạt chu kỳ mới.
 *    - nowSeconds < resetsAt: Chưa đến thời gian reset tuần (chu kỳ hiện tại vẫn đang đếm ngược) -> KHÔNG gửi lại.
 * 4. Nếu nhóm CHƯA CÓ thời gian reset tuần (resetsAt === null / undefined):
 *    - Do quota tuần đạt 100% (chưa kích hoạt chu kỳ lần nào) -> gửi chat thử nghiệm để kích hoạt chu kỳ 7 ngày ban đầu.
 */
export function isWeeklyQuotaDueForReset(
    quota: AccountQuota | undefined | null,
    family: 'gemini' | 'claude',
    nowSeconds: number = Math.floor(Date.now() / 1000),
    options: { checkShortTerm?: boolean } = {},
): boolean {
    const { checkShortTerm = true } = options;
    if (!quota?.models?.length) {
        return false;
    }

    // 1. Kiểm tra an toàn: Nếu cửa sổ ngắn hạn (5h) đang cạn kiệt, tạm hoãn gửi chat
    if (checkShortTerm && isFamilyShortTermExhausted(quota, family)) {
        return false;
    }

    // 2. Quota tuần bắt buộc phải đang đạt 100%
    if (!hasWeeklyQuota100Percent(quota, family)) {
        return false;
    }

    // 3. Khi quota tuần đang ở mức tối đa 100% (chưa kích hoạt chu kỳ hoặc vừa được reset về 100%),
    // luôn đủ điều kiện gửi chat thử nghiệm để kích hoạt chu kỳ 7 ngày mới (chuyển sang 99% và đếm ngược)
    return true;
}

/**
 * Alias cho isWeeklyQuotaDueForReset để giữ tương thích ngược với code cũ.
 */
export function isWeeklyQuota100Percent(
    quota: AccountQuota | undefined | null,
    family: 'gemini' | 'claude',
    nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
    return isWeeklyQuotaDueForReset(quota, family, nowSeconds);
}

/**
 * Lấy danh sách các nhóm ('gemini' | 'claude') đã đến lúc reset quota tuần.
 */
export function getFamiliesDueForWeeklyReset(
    quota: AccountQuota | undefined | null,
    nowSeconds: number = Math.floor(Date.now() / 1000),
    options: { checkShortTerm?: boolean } = {},
): Array<'gemini' | 'claude'> {
    const families: Array<'gemini' | 'claude'> = [];
    if (isWeeklyQuotaDueForReset(quota, 'gemini', nowSeconds, options)) {
        families.push('gemini');
    }
    if (isWeeklyQuotaDueForReset(quota, 'claude', nowSeconds, options)) {
        families.push('claude');
    }
    return families;
}

/**
 * Alias cho getFamiliesDueForWeeklyReset để giữ tương thích ngược.
 */
export const getFamiliesWith100PercentWeeklyQuota =
    getFamiliesDueForWeeklyReset;

/**
 * Kiểm tra xem có tài khoản nào đã đến hoặc qua mốc reset tuần nhưng quota tuần chưa về 100% hay không.
 * Nếu có, cần kiểm tra với tần suất dày hơn (mặc định 30 giây) để phát hiện thời điểm quota vừa được cập nhật 100%.
 */
export function hasAccountsPendingWeeklyReset(
    accounts: Account[],
    quotas: Record<string, AccountQuota>,
    nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
    const agAccounts = accounts.filter((acc) => acc.provider === 'antigravity');
    for (const acc of agAccounts) {
        const quota = quotas[acc.id];
        if (!quota) continue;
        for (const family of ['gemini', 'claude'] as const) {
            const resetAt = getWeeklyResetTimestamp(quota, family);
            if (
                typeof resetAt === 'number' &&
                resetAt <= nowSeconds &&
                !hasWeeklyQuota100Percent(quota, family)
            ) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Lấy mốc thời gian reset tuần gần nhất trong tương lai của các tài khoản Antigravity (tính bằng giây).
 * Trả về null nếu không có mốc reset tuần nào trong tương lai.
 */
export function getNextWeeklyResetTimestamp(
    accounts: Account[],
    quotas: Record<string, AccountQuota>,
    nowSeconds: number = Math.floor(Date.now() / 1000),
): number | null {
    const agAccounts = accounts.filter((acc) => acc.provider === 'antigravity');
    const futureTimestamps: number[] = [];

    for (const acc of agAccounts) {
        const quota = quotas[acc.id];
        if (!quota) continue;

        const geminiReset = getWeeklyResetTimestamp(quota, 'gemini');
        if (typeof geminiReset === 'number' && geminiReset > nowSeconds) {
            futureTimestamps.push(geminiReset);
        }

        const claudeReset = getWeeklyResetTimestamp(quota, 'claude');
        if (typeof claudeReset === 'number' && claudeReset > nowSeconds) {
            futureTimestamps.push(claudeReset);
        }
    }

    if (!futureTimestamps.length) return null;
    return Math.min(...futureTimestamps);
}

/**
 * Tính số mili-giây cần chờ cho lần kiểm tra reset tuần tiếp theo.
 * Buffer thêm 5 giây sau mốc reset để phía máy chủ hoàn tất xử lý reset.
 * Giới hạn tối đa là maxIntervalMs (mặc định 15 phút) để đảm bảo định kỳ kiểm tra.
 */
export function calculateNextResetDelayMs(
    accounts: Account[],
    quotas: Record<string, AccountQuota>,
    options: {
        nowSeconds?: number;
        bufferSeconds?: number;
        maxIntervalMs?: number;
        minDelayMs?: number;
        pendingResetIntervalMs?: number;
    } = {},
): number {
    const {
        nowSeconds = Math.floor(Date.now() / 1000),
        bufferSeconds = 5,
        maxIntervalMs = DEFAULT_AUTO_TEST_CHAT_INTERVAL_MS,
        minDelayMs = 5000,
        pendingResetIntervalMs = DEFAULT_AUTO_TEST_CHAT_PENDING_RESET_INTERVAL_MS,
    } = options;

    // Nếu có tài khoản đã đến mốc reset tuần nhưng quota chưa về 100%, chờ theo pendingResetIntervalMs (30s)
    if (hasAccountsPendingWeeklyReset(accounts, quotas, nowSeconds)) {
        return Math.min(
            maxIntervalMs,
            Math.max(minDelayMs, pendingResetIntervalMs),
        );
    }

    const nextReset = getNextWeeklyResetTimestamp(accounts, quotas, nowSeconds);
    if (nextReset === null) {
        return maxIntervalMs;
    }

    const secondsUntilReset = nextReset - nowSeconds + bufferSeconds;
    const delayMs = secondsUntilReset * 1000;

    return Math.min(maxIntervalMs, Math.max(minDelayMs, delayMs));
}

export interface AutoTestChatTriggerResult {
    accountId: string;
    accountName: string;
    family: 'gemini' | 'claude';
    success: boolean;
    message?: string;
}

export interface ExecuteAutoTestChatOptions {
    accounts: Account[];
    quotas: Record<string, AccountQuota>;
    testChatFn: (
        accountId: string,
        family: 'gemini' | 'claude',
    ) => Promise<{ success: boolean; message?: string }>;
    onAccountTriggered?: (result: AutoTestChatTriggerResult) => void;
    lastTriggeredMap?: Map<string, number>;
    initialTriggeredSet?: Set<string>;
    consecutiveErrorMap?: Map<string, number>;
    inFlightSet?: Set<string>;
    cooldownMs?: number;
    errorCooldownMs?: number;
    maxConsecutiveErrors?: number;
    checkShortTerm?: boolean;
    nowMs?: number;
}

/**
 * Quét toàn bộ tài khoản Antigravity và tự động gửi chat thử nghiệm ("Say ok") cho các nhóm đã đến lúc reset quota tuần.
 */
export async function executeAutoTestChatForAccounts({
    accounts,
    quotas,
    testChatFn,
    onAccountTriggered,
    lastTriggeredMap = new Map<string, number>(),
    initialTriggeredSet = new Set<string>(),
    consecutiveErrorMap = new Map<string, number>(),
    inFlightSet = new Set<string>(),
    cooldownMs = DEFAULT_AUTO_TEST_CHAT_COOLDOWN_MS,
    errorCooldownMs = DEFAULT_AUTO_TEST_CHAT_ERROR_COOLDOWN_MS,
    maxConsecutiveErrors = 3,
    checkShortTerm = true,
    nowMs = Date.now(),
}: ExecuteAutoTestChatOptions): Promise<{
    triggeredCount: number;
    results: AutoTestChatTriggerResult[];
}> {
    const antigravityAccounts = accounts.filter(
        (acc) => acc.provider === 'antigravity',
    );
    const results: AutoTestChatTriggerResult[] = [];
    const nowSeconds = Math.floor(nowMs / 1000);

    for (const account of antigravityAccounts) {
        const quota = quotas[account.id];
        if (!quota) continue;

        const familiesToTrigger = getFamiliesDueForWeeklyReset(
            quota,
            nowSeconds,
            { checkShortTerm },
        );

        for (const family of familiesToTrigger) {
            const key = `${account.id}:${family}`;

            if (inFlightSet.has(key)) {
                continue;
            }

            const lastTriggered = lastTriggeredMap.get(key);
            if (
                lastTriggered !== undefined &&
                nowMs - lastTriggered < cooldownMs
            ) {
                continue;
            }

            inFlightSet.add(key);
            try {
                const response = await testChatFn(account.id, family);

                if (response.success) {
                    lastTriggeredMap.set(key, nowMs);
                    consecutiveErrorMap.delete(key);
                    initialTriggeredSet.delete(key);
                } else {
                    const errCount = (consecutiveErrorMap.get(key) ?? 0) + 1;
                    consecutiveErrorMap.set(key, errCount);
                    const effCooldown =
                        errCount >= maxConsecutiveErrors
                            ? cooldownMs
                            : errorCooldownMs;
                    lastTriggeredMap.set(key, nowMs - cooldownMs + effCooldown);
                }

                const item: AutoTestChatTriggerResult = {
                    accountId: account.id,
                    accountName: account.name,
                    family,
                    success: response.success,
                    message: response.message,
                };
                results.push(item);
                onAccountTriggered?.(item);
            } catch (err) {
                const errCount = (consecutiveErrorMap.get(key) ?? 0) + 1;
                consecutiveErrorMap.set(key, errCount);
                const effCooldown =
                    errCount >= maxConsecutiveErrors
                        ? cooldownMs
                        : errorCooldownMs;
                lastTriggeredMap.set(key, nowMs - cooldownMs + effCooldown);

                const item: AutoTestChatTriggerResult = {
                    accountId: account.id,
                    accountName: account.name,
                    family,
                    success: false,
                    message:
                        err instanceof Error
                            ? err.message
                            : 'Lỗi gửi chat thử nghiệm',
                };
                results.push(item);
                onAccountTriggered?.(item);
            } finally {
                inFlightSet.delete(key);
            }
        }
    }

    return {
        triggeredCount: results.length,
        results,
    };
}

export interface AutoTestChatJobOptions {
    getAccounts: () => Account[];
    getQuotas: () => Record<string, AccountQuota>;
    fetchQuotas: (accountIds: string[]) => Promise<Record<string, AccountQuota>>;
    testChatFn: (
        accountId: string,
        family: 'gemini' | 'claude',
    ) => Promise<{ success: boolean; message?: string }>;
    onResults?: (results: AutoTestChatTriggerResult[]) => void;
    onSuccess?: (accountId: string, family: 'gemini' | 'claude') => void;
    lastTriggeredMap?: Map<string, number>;
    initialTriggeredSet?: Set<string>;
    consecutiveErrorMap?: Map<string, number>;
    inFlightSet?: Set<string>;
    cooldownMs?: number;
    errorCooldownMs?: number;
    maxConsecutiveErrors?: number;
    checkShortTerm?: boolean;
    errorRetryDelayMs?: number;
    pendingResetIntervalMs?: number;
    maxIntervalMs?: number;
    minDelayMs?: number;
    onStateSaved?: () => void;
    logger?: {
        info?: (...args: any[]) => void;
        error?: (...args: any[]) => void;
    };
}

/**
 * Job lặp lại định kỳ tự động kiểm tra và gửi tin nhắn chat thử nghiệm ("Say ok") cho các tài khoản Antigravity
 * khi mốc reset tuần đã đến (nowSeconds >= resetsAt) VÀ quota tuần đạt 100%, hoặc khi tài khoản chưa kích hoạt chu kỳ có quota 100%.
 */
export class AutoTestChatJob {
    private options: AutoTestChatJobOptions;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private isRunning = false;
    private isExecuting = false;

    constructor(options: AutoTestChatJobOptions) {
        this.options = options;
    }

    public start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        void this.runStep();
    }

    public stop(): void {
        this.isRunning = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    public get active(): boolean {
        return this.isRunning;
    }

    /**
     * Kích hoạt kiểm tra ngay lập tức ngoài chu kỳ định kỳ.
     */
    public async triggerNow(): Promise<void> {
        if (!this.isRunning) return;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        await this.runStep();
    }

    private async runStep(): Promise<void> {
        if (!this.isRunning || this.isExecuting) return;
        this.isExecuting = true;

        let delayMs =
            this.options.maxIntervalMs ?? DEFAULT_AUTO_TEST_CHAT_INTERVAL_MS;

        try {
            const allAccounts = this.options.getAccounts();
            const agAccounts = allAccounts.filter(
                (acc) => acc.provider === 'antigravity',
            );

            if (agAccounts.length > 0) {
                let currentQuotas = this.options.getQuotas();
                try {
                    const fetchedQuotas = await this.options.fetchQuotas(
                        agAccounts.map((a) => a.id),
                    );
                    currentQuotas = { ...currentQuotas, ...fetchedQuotas };
                } catch (fetchErr) {
                    this.options.logger?.error?.(
                        'Lỗi fetch quota trong job auto test chat:',
                        fetchErr,
                    );
                    delayMs =
                        this.options.errorRetryDelayMs ??
                        DEFAULT_AUTO_TEST_CHAT_ERROR_RETRY_MS;
                    return;
                }

                const { results } = await executeAutoTestChatForAccounts({
                    accounts: agAccounts,
                    quotas: currentQuotas,
                    testChatFn: this.options.testChatFn,
                    lastTriggeredMap: this.options.lastTriggeredMap,
                    initialTriggeredSet: this.options.initialTriggeredSet,
                    consecutiveErrorMap: this.options.consecutiveErrorMap,
                    inFlightSet: this.options.inFlightSet,
                    cooldownMs: this.options.cooldownMs,
                    errorCooldownMs: this.options.errorCooldownMs,
                    maxConsecutiveErrors: this.options.maxConsecutiveErrors,
                    checkShortTerm: this.options.checkShortTerm,
                });

                this.options.onStateSaved?.();

                if (results.length > 0) {
                    this.options.onResults?.(results);
                    for (const res of results) {
                        if (res.success) {
                            this.options.onSuccess?.(res.accountId, res.family);
                        }
                    }
                }

                delayMs = calculateNextResetDelayMs(agAccounts, currentQuotas, {
                    maxIntervalMs: this.options.maxIntervalMs,
                    minDelayMs: this.options.minDelayMs,
                    pendingResetIntervalMs: this.options.pendingResetIntervalMs,
                });
            } else {
                // Khi chưa có accounts (ví dụ lúc app vừa khởi động), thử lại sau 5s thay vì chờ hết maxIntervalMs
                delayMs = this.options.minDelayMs ?? 5000;
            }
        } catch (err) {
            this.options.logger?.error?.('Lỗi trong job auto test chat:', err);
            delayMs =
                this.options.errorRetryDelayMs ??
                DEFAULT_AUTO_TEST_CHAT_ERROR_RETRY_MS;
        } finally {
            this.isExecuting = false;
            if (this.isRunning) {
                this.timer = setTimeout(() => {
                    void this.runStep();
                }, delayMs);
            }
        }
    }
}
