// @vitest-environment jsdom
// ============================================================================
// R5 INFO 3: UX cancel device flow — trước fix, user bấm "Hủy chờ" (chủ động
// hủy) thì waitFor propagate 'Đã hủy đăng nhập GitHub' và dialog hiển thị
// ERROR MESSAGE. Sau fix: dialog phải IM LẶNG reset state (không message đỏ),
// và lỗi THẬT (không phải cancel) vẫn phải hiển thị.
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CopilotLoginDialog } from '../../src/components/CopilotLoginDialog'
import type { Account, CopilotDeviceLoginStart, CopilotLoginStatus } from '../../src/types'

const api = vi.hoisted(() => ({
  getCopilotLoginStatus: vi.fn(),
  startCopilotDeviceLogin: vi.fn(),
  waitForCopilotDeviceLogin: vi.fn(),
  cancelCopilotDeviceLogin: vi.fn(),
  importCopilotFromLive: vi.fn(),
  importCopilotFromFile: vi.fn(),
  pickCopilotSnapshotFile: vi.fn(),
  logoutCopilot: vi.fn()
}))

const account: Account = {
  id: 'slot-1',
  name: 'Copilot slot',
  provider: 'copilot',
  apiKey: '',
  settings: {} as Account['settings'],
  createdAt: '',
  lastUsedAt: null,
  switchCount: 0,
  copilotUsername: 'slotuser'
}

const loggedNoToken: CopilotLoginStatus = { loggedIn: true, username: 'slotuser', targets: ['vscode'], hasOwnToken: false }
const loginStart: CopilotDeviceLoginStart = {
  userCode: 'ABCD-1234',
  verificationUri: 'https://github.com/login/device',
  expiresInSeconds: 900
}

beforeEach(() => {
  vi.stubGlobal('window', window)
  Object.defineProperty(window, 'api', { value: api, writable: true, configurable: true })
  Object.defineProperty(window, 'open', { value: vi.fn(), writable: true, configurable: true })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  api.getCopilotLoginStatus.mockReset().mockResolvedValue(loggedNoToken)
  api.startCopilotDeviceLogin.mockReset().mockResolvedValue(loginStart)
  api.waitForCopilotDeviceLogin.mockReset()
  api.cancelCopilotDeviceLogin.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function openDeviceLoginAndWait(): Promise<void> {
  render(<CopilotLoginDialog account={account} onClose={() => undefined} onSuccess={() => undefined} />)
  const button = await screen.findByText('Đăng nhập GitHub cho slot này')
  fireEvent.click(button)
  await screen.findByText('ABCD-1234')
}

describe('CopilotLoginDialog — cancel device flow im lặng (R5 INFO 3)', () => {
  it('bấm "Hủy chờ" → waitFor reject ' + "'Đã hủy đăng nhập GitHub'" + ' → KHÔNG hiện error, không gọi onSuccess', async () => {
    let rejectWait!: (error: Error) => void
    api.waitForCopilotDeviceLogin.mockImplementation(
      () => new Promise((_resolve, reject) => { rejectWait = reject })
    )
    const onSuccess = vi.fn()
    render(<CopilotLoginDialog account={account} onClose={() => undefined} onSuccess={onSuccess} />)
    const button = await screen.findByText('Đăng nhập GitHub cho slot này')
    fireEvent.click(button)
    await screen.findByText('ABCD-1234')

    const cancel = await screen.findByText(/Hủy chờ/)
    fireEvent.click(cancel)
    await waitFor(() => expect(api.cancelCopilotDeviceLogin).toHaveBeenCalledWith('slot-1'))

    // Main process propagate lỗi hủy qua waitFor — dialog phải nuốt im lặng
    await act(async () => {
      rejectWait(new Error('Đã hủy đăng nhập GitHub'))
      await Promise.resolve()
    })

    expect(screen.queryByText(/Đã hủy đăng nhập GitHub/)).toBeNull()
    expect(document.querySelector('.inline-message.error')).toBeNull()
    expect(onSuccess).not.toHaveBeenCalled()
    // UI về trạng thái chờ đăng nhập lại: box code biến mất
    expect(screen.queryByText('ABCD-1234')).toBeNull()
  })

  it('unmount giữa chừng flow (Hủy dialog) → error từ flow đang chạy cũng bị nuốt', async () => {
    let rejectWait!: (error: Error) => void
    api.waitForCopilotDeviceLogin.mockImplementation(
      () => new Promise((_resolve, reject) => { rejectWait = reject })
    )
    const { unmount } = render(
      <CopilotLoginDialog account={account} onClose={() => undefined} onSuccess={() => undefined} />
    )
    const button = await screen.findByText('Đăng nhập GitHub cho slot này')
    fireEvent.click(button)
    await screen.findByText('ABCD-1234')

    unmount()
    await waitFor(() => expect(api.cancelCopilotDeviceLogin).toHaveBeenCalledWith('slot-1'))
    // reject sau unmount: không được crash (React cảnh báo) — attempt seq cũ
    await act(async () => {
      rejectWait(new Error('Đã hủy đăng nhập GitHub'))
      await Promise.resolve()
    })
    expect(console.error).not.toHaveBeenCalled()
  })

  it('lỗi THẬT (không phải cancel) vẫn hiển thị error như cũ', async () => {
    api.waitForCopilotDeviceLogin.mockRejectedValue(new Error('Slot chưa có auth Copilot. Hãy import auth từ VS Code trước.'))
    await openDeviceLoginAndWait()
    const msg = await waitFor(() => {
      const el = document.querySelector('.inline-message.error')
      expect(el).not.toBeNull()
      return el!
    })
    expect(msg.textContent).toContain('Slot chưa có auth Copilot')
  })

  it('start lần 2 trong khi attempt 1 còn treo → attempt 1 finalize muộn không ghi đè UI attempt 2', async () => {
    let rejectWait1!: (error: Error) => void
    let resolveWait2!: (status: CopilotLoginStatus) => void
    api.waitForCopilotDeviceLogin
      .mockImplementationOnce(() => new Promise((_r, reject) => { rejectWait1 = reject }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveWait2 = resolve }))

    render(<CopilotLoginDialog account={account} onClose={() => undefined} onSuccess={() => undefined} />)
    const button = await screen.findByText('Đăng nhập GitHub cho slot này')
    fireEvent.click(button)
    await screen.findByText('ABCD-1234')

    // Attempt 2 bắt đầu trong khi attempt 1 còn treo (vd start mới bị từ
    // chối → người dùng bấm lại): đánh dấu attempt cũ đã canceled qua cancel.
    const cancel = await screen.findByText(/Hủy chờ/)
    fireEvent.click(cancel)
    await waitFor(() => expect(api.cancelCopilotDeviceLogin).toHaveBeenCalledWith('slot-1'))

    fireEvent.click(await screen.findByText('Đăng nhập GitHub cho slot này'))
    await screen.findByText('ABCD-1234')

    // attempt 1 fail muộn với message GIỐNG lỗi hủy — vẫn phải im lặng vì
    // seq bị thay thế (không được xóa UI của attempt 2)
    await act(async () => {
      rejectWait1(new Error('Slot chưa có auth Copilot'))
      await Promise.resolve()
    })
    expect(document.querySelector('.inline-message.error')).toBeNull()
    expect(screen.queryByText('ABCD-1234')).not.toBeNull() // attempt 2 còn hiển thị

    await act(async () => {
      resolveWait2({ ...loggedNoToken, hasOwnToken: true })
      await Promise.resolve()
    })
    const success = await waitFor(() => {
      const el = document.querySelector('.inline-message.success')
      expect(el).not.toBeNull()
      return el!
    })
    expect(success.textContent).toContain('Đã đăng nhập GitHub')
  })

  it('R6 L6: nút start disable NGAY khi bấm (cửa sổ network RTT không cho double-click)', async () => {
    let resolveStart!: (start: CopilotDeviceLoginStart) => void
    api.startCopilotDeviceLogin.mockImplementationOnce(
      () => new Promise((resolve) => { resolveStart = resolve })
    )
    // waitFor treo (như các test khác) — không để continuation chạy tiếp xóa UI
    api.waitForCopilotDeviceLogin.mockImplementation(() => new Promise(() => {}))
    render(<CopilotLoginDialog account={account} onClose={() => undefined} onSuccess={() => undefined} />)
    const button = (await screen.findByText('Đăng nhập GitHub cho slot này')) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)

    // Đang chờ start resolve → nút phải disable ngay (deviceStarting), không
    // đợi đến khi deviceWaiting set như bản cũ
    await waitFor(() => expect(button.disabled).toBe(true))

    // start resolve → hiển thị code; nút vẫn disable (deviceWaiting — đang chờ
    // user xác nhận trên github.com). Điều quan trọng đã chứng minh xong ở trên:
    // cửa sổ RTT không còn để double-click.
    await act(async () => {
      resolveStart(loginStart)
    })
    expect(await screen.findByText('ABCD-1234')).not.toBeNull()
    expect(button.disabled).toBe(true)
  })
})
