import { FormEvent, useEffect, useMemo, useState } from 'react';
import type {
    Account,
    AccountQuota,
    AntigravityLoginStatus,
    CodexSettings,
    ProviderOptions,
} from '../types';
import { AntigravityLoginDialog } from './AntigravityLoginDialog';
import { QuotaPanel } from './QuotaPanel';

interface AntigravityAccountDialogProps {
    account: Account | null;
    onClose: () => void;
    onSubmit: (input: {
        name: string;
        note?: string;
        settings?: Partial<CodexSettings>;
    }) => Promise<void>;
}

export function AntigravityAccountDialog({
    account,
    onClose,
    onSubmit,
}: AntigravityAccountDialogProps) {
    const [name, setName] = useState(account?.name ?? '');
    const [note, setNote] = useState(account?.note ?? '');
    const [geminiModel, setGeminiModel] = useState(
        account?.settings?.geminiModel ?? '',
    );
    const [claudeModel, setClaudeModel] = useState(
        account?.settings?.claudeModel ?? '',
    );
    const [options, setOptions] = useState<ProviderOptions | null>(null);
    const [loadingOptions, setLoadingOptions] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [quota, setQuota] = useState<AccountQuota | null>(null);
    const [quotaLoading, setQuotaLoading] = useState(false);
    const [loginStatus, setLoginStatus] =
        useState<AntigravityLoginStatus | null>(null);
    const [loginOpen, setLoginOpen] = useState(false);
    const [message, setMessage] = useState<{
        type: 'success' | 'error';
        text: string;
    } | null>(null);

    useEffect(() => {
        let cancelled = false;

        async function loadOptions(): Promise<void> {
            setLoadingOptions(true);
            try {
                const next = await window.api.getProviderOptions(
                    'antigravity',
                    undefined,
                    account?.id,
                );
                if (!cancelled) {
                    setOptions(next);
                }
            } catch {
                // ignore
            } finally {
                if (!cancelled) {
                    setLoadingOptions(false);
                }
            }
        }

        void loadOptions();

        return () => {
            cancelled = true;
        };
    }, [account?.id]);

    const geminiOptions = useMemo(() => {
        return (options?.models ?? []).filter((m) => /gemini/i.test(m.id));
    }, [options?.models]);

    const claudeOptions = useMemo(() => {
        return (options?.models ?? []).filter((m) =>
            /(claude|gpt|3p)/i.test(m.id),
        );
    }, [options?.models]);

    useEffect(() => {
        let cancelled = false;

        async function loadQuota(): Promise<void> {
            if (!account?.id) {
                setQuota(null);
                setLoginStatus(null);
                return;
            }

            setQuotaLoading(true);
            try {
                const [nextQuota, nextLogin] = await Promise.all([
                    window.api.getAccountQuota('antigravity', account.id),
                    window.api.getAntigravityLoginStatus(account.id),
                ]);
                if (!cancelled) {
                    setQuota(nextQuota);
                    setLoginStatus(nextLogin);
                }
            } catch {
                if (!cancelled) {
                    setQuota(null);
                }
            } finally {
                if (!cancelled) {
                    setQuotaLoading(false);
                }
            }
        }

        void loadQuota();

        return () => {
            cancelled = true;
        };
    }, [account?.id]);

    async function reloadQuota(): Promise<void> {
        if (!account?.id) return;
        const [nextQuota, nextLogin, nextOptions] = await Promise.all([
            window.api.getAccountQuota('antigravity', account.id),
            window.api.getAntigravityLoginStatus(account.id),
            window.api.getProviderOptions('antigravity', undefined, account.id),
        ]);
        setQuota(nextQuota);
        setLoginStatus(nextLogin);
        setOptions(nextOptions);
    }

    async function handleSubmit(event: FormEvent): Promise<void> {
        event.preventDefault();
        setSubmitting(true);
        setMessage(null);

        try {
            await onSubmit({
                name: name.trim(),
                note: note.trim() || undefined,
                settings: {
                    ...account?.settings,
                    geminiModel: geminiModel || undefined,
                    claudeModel: claudeModel || undefined,
                    model:
                        claudeModel ||
                        geminiModel ||
                        account?.settings?.model ||
                        'claude',
                },
            });
        } catch (error) {
            setMessage({
                type: 'error',
                text:
                    error instanceof Error
                        ? error.message
                        : 'Không thể lưu tài khoản',
            });
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div className='dialog-backdrop' onClick={onClose}>
            <div
                className='dialog'
                onClick={(event) => event.stopPropagation()}
            >
                <h3>
                    {account ? 'Sửa tài khoản' : 'Thêm tài khoản Antigravity'}
                </h3>

                <form className='form-grid' onSubmit={handleSubmit}>
                    <div className='field'>
                        <label htmlFor='ag-name'>Tên tài khoản</label>
                        <input
                            id='ag-name'
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder='Ví dụ: Google cá nhân'
                            required
                        />
                    </div>

                    <div className='field'>
                        <label htmlFor='ag-gemini-model'>
                            Model Gemini (Auto kích hoạt / Test chat)
                        </label>
                        <select
                            id='ag-gemini-model'
                            value={geminiModel}
                            onChange={(event) =>
                                setGeminiModel(event.target.value)
                            }
                            disabled={loadingOptions}
                        >
                            <option value=''>
                                Tự động (Lấy model tối ưu nhất từ Google API)
                            </option>
                            {geminiOptions.map((opt) => (
                                <option key={opt.id} value={opt.id}>
                                    {opt.label || opt.id}
                                </option>
                            ))}
                        </select>
                        <small className='field-hint'>
                            {loadingOptions
                                ? 'Đang tải danh sách model động từ Google API...'
                                : 'Để "Tự động" để app tự động chọn model nhẹ nhất từ Google API khi reset tuần.'}
                        </small>
                    </div>

                    <div className='field'>
                        <label htmlFor='ag-claude-model'>
                            Model Claude &amp; GPT (Auto kích hoạt / Test chat)
                        </label>
                        <select
                            id='ag-claude-model'
                            value={claudeModel}
                            onChange={(event) =>
                                setClaudeModel(event.target.value)
                            }
                            disabled={loadingOptions}
                        >
                            <option value=''>
                                Tự động (Lấy model tối ưu nhất từ Google API)
                            </option>
                            {claudeOptions.map((opt) => (
                                <option key={opt.id} value={opt.id}>
                                    {opt.label || opt.id}
                                </option>
                            ))}
                        </select>
                        <small className='field-hint'>
                            {loadingOptions
                                ? 'Đang tải danh sách model động từ Google API...'
                                : 'Để "Tự động" để app tự động chọn model nhẹ nhất từ Google API khi reset tuần.'}
                        </small>
                    </div>

                    <div className='field'>
                        <label htmlFor='ag-note'>Ghi chú</label>
                        <textarea
                            id='ag-note'
                            value={note}
                            onChange={(event) => setNote(event.target.value)}
                            placeholder='Ví dụ: tài khoản chính, dùng Claude/Gemini qua Antigravity'
                        />
                    </div>

                    <QuotaPanel
                        quota={quota}
                        loading={quotaLoading}
                        loginStatus={
                            loginStatus?.loggedIn
                                ? { loggedIn: true, email: loginStatus.email }
                                : loginStatus
                        }
                        loginPrompt='Đăng nhập Antigravity để xem quota'
                        onLogin={account ? () => setLoginOpen(true) : undefined}
                    />
                    {!account && (
                        <div className='quota-note'>
                            Lưu tài khoản trước, sau đó đăng nhập Google OAuth
                            để xem quota.
                        </div>
                    )}

                    <div className='dialog-actions'>
                        {account && (
                            <button
                                type='button'
                                className='btn btn-ghost'
                                onClick={() => setLoginOpen(true)}
                            >
                                {loginStatus?.loggedIn
                                    ? 'Quản lý login'
                                    : 'Đăng nhập Antigravity'}
                            </button>
                        )}
                        <button
                            type='button'
                            className='btn btn-secondary'
                            onClick={onClose}
                        >
                            Hủy
                        </button>
                        <button
                            type='submit'
                            className='btn btn-primary'
                            disabled={submitting}
                        >
                            {submitting
                                ? 'Đang lưu...'
                                : account
                                  ? 'Cập nhật'
                                  : 'Thêm tài khoản'}
                        </button>
                    </div>

                    {message && (
                        <div className={`inline-message ${message.type}`}>
                            {message.text}
                        </div>
                    )}
                </form>

                {account && loginOpen && (
                    <AntigravityLoginDialog
                        account={account}
                        onClose={() => setLoginOpen(false)}
                        onSuccess={async () => {
                            await reloadQuota();
                        }}
                    />
                )}
            </div>
        </div>
    );
}
