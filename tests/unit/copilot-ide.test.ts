import { describe, expect, it } from 'vitest'
import { filterEntriesForApply } from '../../electron/main/copilot-ide'

const AUTH_KEY = 'secret://{"extensionId":"vscode.github-authentication","key":"github.auth"}'

describe('filterEntriesForApply (Copilot key filtering)', () => {
  it('giữ auth secret + ghi đè username key, loại key lạ', () => {
    const filtered = filterEntriesForApply(
      {
        [AUTH_KEY]: 'tok',
        'github.copilot-github': 'stale-user',
        'github-otheruser': 'x',
        'github-testuser-usages': 'u',
        'random-key': 'v'
      },
      'testuser'
    )

    expect(Object.keys(filtered).sort()).toEqual(
      [AUTH_KEY, 'github.copilot-github', 'github-testuser-usages'].sort()
    )
    expect(filtered['github.copilot-github']).toBe('testuser')
    expect(filtered['github-otheruser']).toBeUndefined()
    expect(filtered['random-key']).toBeUndefined()
  })

  it('-usages key khớp username (case-insensitive) được giữ', () => {
    const filtered = filterEntriesForApply(
      { 'github-TestUser-usages': 'keep-me' },
      'testuser'
    )
    expect(filtered['github-TestUser-usages']).toBe('keep-me')
  })

  it('usages key của user khác bị loại', () => {
    const filtered = filterEntriesForApply(
      { 'github-other-usages': 'drop-me' },
      'testuser'
    )
    expect(filtered['github-other-usages']).toBeUndefined()
  })

  it('defaultAccount.cachedPolicyData + extensionsAssignmentFilterProvider giữ nguyên', () => {
    const filtered = filterEntriesForApply(
      {
        'defaultAccount.cachedPolicyData': 'policy',
        'extensionsAssignmentFilterProvider.copilot.foo': 'bar'
      },
      'testuser'
    )
    expect(filtered['defaultAccount.cachedPolicyData']).toBe('policy')
    expect(filtered['extensionsAssignmentFilterProvider.copilot.foo']).toBe('bar')
  })
})
