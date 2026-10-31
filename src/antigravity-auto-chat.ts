import type { Account, AccountQuota, ModelQuotaWindow } from './types';

export const DEFAULT_AUTO_TEST_CHAT_COOLDOWN_MS = 30 * 60 * 1000; // 30 phút cooldown tránh gửi lặp lại
export const DEFAULT_AUTO_TEST_CHAT_ERROR_COOLDOWN_MS = 2 * 60 * 1000; // 2 phút cooldown thử lại khi gặp lỗi
export const DEFAULT_AUTO_TEST_CHAT_INTERVAL_MS = 15 * 60 * 1000; // 15 phút kiểm tra ngầm định kỳ
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
            (w) => !isWeeklyWindow(w),
        );
        if (shortWindows.length > 0) {
            const allExhausted = shortWindows.every(
                (w) =>
                    w.disabled ||
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
 * Kiểm tra xem quota tuần của nhóm Gemini hoặc Claude & GPT của một tài khoản đã đến lúc reset (cần gửi chat thử nghiệm) hay chưa.
 *
 * Quy tắc dựa vào thời gian reset tuần:
 * 1. Kiểm tra an toàn: Nếu cửa sổ ngắn hạn (5h) đang cạn kiệt (0%), không kích hoạt để tránh lỗi 429.
 * 2. Nếu nhóm ĐÃ CÓ thời gian reset tuần (resetsAt):
 *    - nowSeconds >= resetsAt: Đã đến hoặc qua thời gian reset tuần -> cần gửi chat thử nghiệm để kích hoạt chu kỳ mới.
 *    - nowSeconds < resetsAt: Chưa đến thời gian reset tuần (chu kỳ hiện tại vẫn đang đếm ngược) -> KHÔNG gửi lại.
 * 3. Nếu nhóm CHƯA CÓ thời gian reset tuần (resetsAt === null / undefined):
 *    - Kiểm tra nếu quota tuần đang ở mức 100% (chưa kích hoạt chu kỳ lần nào) -> cần gửi chat thử nghiệm để kích hoạt chu kỳ 7 ngày.
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

    const isGemini = family === 'gemini';
    const matcher = isGemini ? /gemini/i : /(claude|gpt|3p)/i;

    const matchingModels = quota.models.filter(
        (m) => matcher.test(m.label) || matcher.test(m.modelId),
    );

    if (!matchingModels.length) {
        return false;
    }

    const weeklyResetAt = getWeeklyResetTimestamp(quota, family);

    // 2. Đã có thời gian reset tuần: căn cứ trực tiếp vào mốc thời gian reset tuần
    if (typeof weeklyResetAt === 'number') {
        return nowSeconds >= weeklyResetAt;
    }

    // 3. Chưa có thời gian reset tuần: căn cứ vào mức quota 100% (chưa kích hoạt chu kỳ)
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
    } = {},
): number {
    const {
        nowSeconds = Math.floor(Date.now() / 1000),
        bufferSeconds = 5,
        maxIntervalMs = DEFAULT_AUTO_TEST_CHAT_INTERVAL_MS,
        minDelayMs = 5000,
    } = options;

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

            const weeklyResetAt = getWeeklyResetTimestamp(quota, family);

            // Nếu nhóm chưa có mốc resetsAt và đã từng được kích hoạt chu kỳ ban đầu, bỏ qua để tránh lặp vô hạn
            if (weeklyResetAt === null && initialTriggeredSet.has(key)) {
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

                    if (weeklyResetAt === null) {
                        initialTriggeredSet.add(key);
                    } else {
                        initialTriggeredSet.delete(key);
                    }
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
