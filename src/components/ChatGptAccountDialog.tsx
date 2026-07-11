import { FormEvent, useEffect, useMemo, useState } from 'react'
import type { Account, AccountQuota, ChatGptLoginStatus, ProviderModelOption, ProviderOptions } from '../types'
import { ChatGptLoginDialog } from './ChatGptLoginDialog'
import { QuotaPanel } from './QuotaPanel'

interface ChatGptAccountDialogProps {
  account: Account | null
  onClose: () => void
  onSubmit: (input: {
    name: string
    model: string
    modelReasoningEffort: Account['settings']['modelReasoningEffort']
    note?: string
  }) => Promise<void>
}

export function ChatGptAccountDialog({ account, onClose, onSubmit }: ChatGptAccountDialogProps) {
  const [name, setName] = useState(account?.name ?? '')
  const [model, setModel] = useState(account?.settings.model ?? '')
  const [modelReasoningEffort, setModelReasoningEffort] = useState(
    account?.settings.modelReasoningEffort ?? 'xhigh'
  )
  const [note, setNote] = useState(account?.note ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [loadingOptions, setLoadingOptions] = useState(true)
  const [options, setOptions] = useState<ProviderOptions | null>(null)
  const [quota, setQuota] = useState<AccountQuota | null>(null)
  const [quotaLoading, setQuotaLoading] = useState(false)
  const [loginStatus, setLoginStatus] = useState<ChatGptLoginStatus | null>(null)
  const [loginOpen, setLoginOpen] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const modelOptions = useMemo(() => {
    const fromApi = options?.models ?? []
    const currentModel = account?.settings.model
    const hasCurrent = currentModel && fromApi.some((item) => item.id === currentModel)

    if (currentModel && !hasCurrent) {
      return [{ id: currentModel, ownedBy: 'saved' }, ...fromApi]
    }

    return fromApi
  }, [account?.settings.model, options?.models])

  useEffect(() => {
    let cancelled = false

    async function loadOptions(): Promise<void> {
      setLoadingOptions(true)
      try {
        const next = await window.api.getProviderOptions('codex-chatgpt')
        if (cancelled) return

        setOptions(next)

        if (!model && next.models.length > 0) {
          setModel(next.models[0].id)
        }

        if (
          next.reasoningEfforts.length > 0 &&
          !next.reasoningEfforts.some((item) => item.value === modelReasoningEffort)
        ) {
          setModelReasoningEffort(next.reasoningEfforts[next.reasoningEfforts.length - 1].value)
        }
      } catch (error) {
        if (!cancelled) {
          setMessage({
            type: 'error',
            text: error instanceof Error ? error.message : 'Không thể tải danh sách model'
          })
        }
      } finally {
        if (!cancelled) {
          setLoadingOptions(false)
        }
      }
    }

    void loadOptions()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadQuota(): Promise<void> {
      if (!account?.id) {
        setQuota(null)
        setLoginStatus(null)
        return
      }

      setQuotaLoading(true)
      try {
        const [nextQuota, nextLogin] = await Promise.all([
          window.api.getAccountQuota('codex-chatgpt', account.id),
          window.api.getChatGptLoginStatus(account.id)
        ])
        if (!cancelled) {
          setQuota(nextQuota)
          setLoginStatus(nextLogin)
        }
      } catch {
        if (!cancelled) {
          setQuota(null)
        }
      } finally {
        if (!cancelled) {
          setQuotaLoading(false)
        }
      }
    }

    void loadQuota()

    return () => {
      cancelled = true
    }
  }, [account?.id])

  async function reloadQuota(): Promise<void> {
    if (!account?.id) return
    const [nextQuota, nextLogin] = await Promise.all([
      window.api.getAccountQuota('codex-chatgpt', account.id),
      window.api.getChatGptLoginStatus(account.id)
    ])
    setQuota(nextQuota)
    setLoginStatus(nextLogin)
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setSubmitting(true)
    setMessage(null)

    try {
      await onSubmit({
        name: name.trim(),
        model,
        modelReasoningEffort,
        note: note.trim() || undefined
      })
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Không thể lưu tài khoản'
      })
    } finally {
      setSubmitting(false)
    }
  }

  function renderModelLabel(option: ProviderModelOption): string {
    return option.ownedBy ? `${option.id} (${option.ownedBy})` : option.id
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <h3>{account ? 'Sửa tài khoản' : 'Thêm tài khoản Codex + ChatGPT'}</h3>

        <form className="form-grid" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="cg-name">Tên tài khoản</label>
            <input
              id="cg-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Ví dụ: ChatGPT Plus cá nhân"
              required
            />
          </div>

          <div className="field">
            <label htmlFor="cg-model">Model Codex</label>
            <select
              id="cg-model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              disabled={loadingOptions || modelOptions.length === 0}
              required
            >
              {loadingOptions ? (
                <option value="">Đang tải model...</option>
              ) : modelOptions.length === 0 ? (
                <option value="">Không có model</option>
              ) : (
                modelOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {renderModelLabel(option)}
                  </option>
                ))
              )}
            </select>
          </div>

          <div className="field">
            <label htmlFor="cg-effort">Reasoning effort</label>
            <select
              id="cg-effort"
              value={modelReasoningEffort}
              onChange={(event) =>
                setModelReasoningEffort(event.target.value as Account['settings']['modelReasoningEffort'])
              }
              disabled={loadingOptions || !options?.reasoningEfforts.length}
            >
              {(options?.reasoningEfforts ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="cg-note">Ghi chú</label>
            <textarea
              id="cg-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Ví dụ: tài khoản Plus, dùng cho dự án B"
            />
          </div>

          <QuotaPanel
            quota={quota}
            loading={quotaLoading}
            loginStatus={loginStatus?.loggedIn ? { loggedIn: true, email: loginStatus.email } : loginStatus}
            loginPrompt="Đăng nhập ChatGPT để xem quota"
            hourlyTitle="Quota cửa sổ chính"
            weeklyTitle="Quota cửa sổ phụ"
            onLogin={account ? () => setLoginOpen(true) : undefined}
            compact
          />
          {!account && (
            <div className="quota-note">Lưu tài khoản trước, sau đó đăng nhập ChatGPT để xem quota.</div>
          )}

          <div className="dialog-actions">
            {account && (
              <button type="button" className="btn btn-ghost" onClick={() => setLoginOpen(true)}>
                {loginStatus?.loggedIn ? 'Quản lý login' : 'Đăng nhập ChatGPT'}
              </button>
            )}
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Hủy
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={submitting || loadingOptions || !model}
            >
              {submitting ? 'Đang lưu...' : account ? 'Cập nhật' : 'Thêm tài khoản'}
            </button>
          </div>

          {message && <div className={`inline-message ${message.type}`}>{message.text}</div>}
        </form>

        {account && loginOpen && (
          <ChatGptLoginDialog
            account={account}
            onClose={() => setLoginOpen(false)}
            onSuccess={async () => {
              await reloadQuota()
            }}
          />
        )}
      </div>
    </div>
  )
}
