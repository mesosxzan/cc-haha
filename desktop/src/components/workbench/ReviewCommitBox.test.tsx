import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const reviewApi = vi.hoisted(() => ({
  aiGenerate: vi.fn(),
  getSyncState: vi.fn(),
}))
vi.mock('../../api/review', () => ({ reviewApi }))

import { ReviewCommitBox } from './ReviewCommitBox'
import { useSettingsStore } from '../../stores/settingsStore'
import { useWorkspaceReviewStore } from '../../stores/workspaceReviewStore'
import type { ReviewFile, ReviewStatusResult } from '../../api/review'

const SESSION = 'session-a'

function file(path: string, overrides: Partial<ReviewFile> = {}): ReviewFile {
  return {
    path,
    status: 'modified',
    additions: 1,
    deletions: 0,
    binary: false,
    staged: false,
    unstaged: true,
    conflicted: false,
    ...overrides,
  }
}

function status(files: ReviewFile[], overrides: Partial<ReviewStatusResult> = {}): ReviewStatusResult {
  return {
    state: 'ok',
    source: { kind: 'uncommitted' },
    snapshot: 'snap-1',
    files,
    untracked: files.filter((candidate) => candidate.status === 'untracked').map((candidate) => candidate.path),
    totals: { additions: files.length, deletions: 0, files: files.length },
    ...overrides,
  }
}

/** Seed the store the way a loaded panel would have left it. */
function seedEntries(files: ReviewFile[]) {
  const base = {
    loading: false,
    error: null,
    stale: false,
    readOnly: false,
    diffsByPath: {},
    diffLoadingByPath: {},
    viewedPaths: [],
    viewedSnapshot: 'snap-1',
    lastBackupDir: null,
    lastDeletedPaths: [],
  }
  useWorkspaceReviewStore.setState({
    byKey: {
      [`${SESSION}::uncommitted`]: { ...base, status: status(files) },
    },
  })
}

function commitResult(overrides: Record<string, unknown> = {}) {
  return { state: 'ok', snapshot: 'snap-2', commit: 'abc1234', ...overrides }
}

let commitMock: ReturnType<typeof vi.fn>
let stageMock: ReturnType<typeof vi.fn>
let pushMock: ReturnType<typeof vi.fn>
let syncMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
  useWorkspaceReviewStore.setState({ byKey: {}, revisionBySession: {} })
  reviewApi.aiGenerate.mockReset()
  reviewApi.getSyncState.mockReset()
  reviewApi.getSyncState.mockResolvedValue({ state: 'ok', branch: 'main', upstream: null, ahead: 0, behind: 0 })
  commitMock = vi.fn().mockResolvedValue(commitResult())
  stageMock = vi.fn().mockResolvedValue({ state: 'ok', snapshot: 'snap-1b', results: [] })
  pushMock = vi.fn().mockResolvedValue({ state: 'ok' })
  syncMock = vi.fn().mockResolvedValue({ state: 'ok', pulled: 'up_to_date' })
  useWorkspaceReviewStore.setState({ commit: commitMock, stage: stageMock, push: pushMock, sync: syncMock })
  seedEntries([file('src/a.ts')])
})

afterEach(() => {
  cleanup()
})

function renderBox(props: Partial<Parameters<typeof ReviewCommitBox>[0]> = {}) {
  return render(<ReviewCommitBox sessionId={SESSION} source={{ kind: 'unstaged' }} enabled {...props} />)
}

function typeMessage(text: string) {
  fireEvent.change(screen.getByTestId('workspace-review-commit-message'), { target: { value: text } })
}

describe('ReviewCommitBox', () => {
  it('names the message field and the commit split button', async () => {
    renderBox()
    expect(screen.getByLabelText('Commit message')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-review-commit-primary')).toHaveTextContent('Commit')
    expect(screen.getByRole('button', { name: 'Commit options' })).toBeInTheDocument()
    await waitFor(() => expect(reviewApi.getSyncState).toHaveBeenCalledWith(SESSION))
  })

  it('requires a message before committing', () => {
    renderBox()
    fireEvent.click(screen.getByTestId('workspace-review-commit-primary'))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a commit message first')
    expect(commitMock).not.toHaveBeenCalled()
  })

  it('stages tracked changes first when nothing is staged, then commits', async () => {
    seedEntries([file('src/a.ts'), file('src/new.ts', { status: 'untracked' })])
    renderBox()
    typeMessage('feat: work')
    fireEvent.click(screen.getByTestId('workspace-review-commit-primary'))
    await waitFor(() => expect(commitMock).toHaveBeenCalled())
    // Untracked files are never swept into the implicit stage-all.
    expect(stageMock).toHaveBeenCalledWith(SESSION, { kind: 'uncommitted' }, ['src/a.ts'])
    expect(commitMock).toHaveBeenCalledWith(SESSION, { message: 'feat: work' }, { kind: 'unstaged' }, expect.anything())
    await waitFor(() => expect(screen.getByTestId('workspace-review-commit-message')).toHaveValue(''))
  })

  it('commits the index directly when something is already staged', async () => {
    seedEntries([file('src/a.ts', { staged: true, unstaged: false }), file('src/b.ts')])
    renderBox()
    typeMessage('fix: staged work')
    fireEvent.click(screen.getByTestId('workspace-review-commit-primary'))
    await waitFor(() => expect(commitMock).toHaveBeenCalled())
    expect(stageMock).not.toHaveBeenCalled()
  })

  it('commits with Ctrl+Enter from the message field', async () => {
    renderBox()
    typeMessage('feat: shortcut')
    fireEvent.keyDown(screen.getByTestId('workspace-review-commit-message'), { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(commitMock).toHaveBeenCalledWith(
      SESSION,
      { message: 'feat: shortcut' },
      { kind: 'unstaged' },
      expect.anything(),
    ))
  })

  it('runs the chosen menu action: commit and push', async () => {
    seedEntries([file('src/a.ts', { staged: true, unstaged: false })])
    renderBox()
    typeMessage('feat: push me')
    fireEvent.click(screen.getByRole('button', { name: 'Commit options' }))
    fireEvent.click(screen.getByTestId('workspace-review-commit-option-commit-push'))
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith(SESSION))
    expect(commitMock).toHaveBeenCalledWith(SESSION, { message: 'feat: push me' }, { kind: 'unstaged' }, expect.anything())
    // The split button now offers the chosen action as its primary.
    expect(screen.getByTestId('workspace-review-commit-primary')).toHaveTextContent('Commit and Push')
  })

  it('sends amend for the amend action and disables sync without an upstream', async () => {
    seedEntries([file('src/a.ts', { staged: true, unstaged: false })])
    renderBox()
    typeMessage('fix: amended')
    fireEvent.click(screen.getByRole('button', { name: 'Commit options' }))
    expect(screen.getByTestId('workspace-review-commit-option-commit-sync')).toBeDisabled()
    fireEvent.click(screen.getByTestId('workspace-review-commit-option-amend'))
    await waitFor(() => expect(commitMock).toHaveBeenCalledWith(
      SESSION,
      { message: 'fix: amended', amend: true },
      { kind: 'unstaged' },
      expect.anything(),
    ))
  })

  it('offers a sync button with the divergence counts when an upstream exists', async () => {
    reviewApi.getSyncState.mockResolvedValue({ state: 'ok', branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1 })
    renderBox()
    const syncButton = await screen.findByTestId('workspace-review-sync-now')
    expect(syncButton).toHaveTextContent('↓1 ↑2')
    fireEvent.click(syncButton)
    await waitFor(() => expect(syncMock).toHaveBeenCalledWith(SESSION))
  })

  it('fills the message from the AI generator', async () => {
    reviewApi.aiGenerate.mockResolvedValue({
      state: 'ok', kind: 'commit-message', source: { kind: 'uncommitted' }, snapshot: 'snap-1',
      text: 'feat(review): generated message', includedFiles: 1, totalFiles: 1, truncated: false,
    })
    renderBox()
    fireEvent.click(screen.getByTestId('workspace-review-commit-ai'))
    await waitFor(() => expect(screen.getByTestId('workspace-review-commit-message')).toHaveValue('feat(review): generated message'))
    expect(reviewApi.aiGenerate).toHaveBeenCalledWith(SESSION, { kind: 'commit-message', source: { kind: 'uncommitted' }, language: 'English' }, expect.anything())
  })

  it('generates in the chosen language after switching the selector to Chinese', async () => {
    reviewApi.aiGenerate.mockResolvedValue({
      state: 'ok', kind: 'commit-message', source: { kind: 'uncommitted' }, snapshot: 'snap-1',
      text: 'feat(review): 生成中文提交信息', includedFiles: 1, totalFiles: 1, truncated: false,
    })
    renderBox()
    const select = screen.getByTestId('workspace-review-commit-ai-language')
    expect(select).toHaveValue('en')
    fireEvent.change(select, { target: { value: 'zh' } })
    fireEvent.click(screen.getByTestId('workspace-review-commit-ai'))
    await waitFor(() => expect(reviewApi.aiGenerate).toHaveBeenCalledWith(
      SESSION,
      { kind: 'commit-message', source: { kind: 'uncommitted' }, language: 'Chinese' },
      expect.anything(),
    ))
  })

  it('turns the AI button into a cancel affordance while generating, and aborts on the second click', async () => {
    let capturedSignal: AbortSignal | undefined
    let rejectGenerate!: (error: Error) => void
    reviewApi.aiGenerate.mockImplementation((_sessionId: string, _request: unknown, options?: { signal?: AbortSignal }) => {
      capturedSignal = options?.signal
      return new Promise((_resolve, reject) => { rejectGenerate = reject })
    })
    renderBox()
    typeMessage('feat: keep me')
    fireEvent.click(screen.getByTestId('workspace-review-commit-ai'))

    const cancel = await screen.findByTestId('workspace-review-commit-ai-loading')
    expect(cancel).toHaveAccessibleName('Cancel generation')
    expect(cancel).toBeEnabled()
    expect(capturedSignal!.aborted).toBe(false)

    fireEvent.click(cancel)
    expect(capturedSignal!.aborted).toBe(true)
    rejectGenerate(new DOMException('The operation was aborted', 'AbortError'))

    // A user cancel is silent: no error, message untouched, button back to generate.
    await waitFor(() => expect(screen.getByTestId('workspace-review-commit-ai')).toBeInTheDocument())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-review-commit-message')).toHaveValue('feat: keep me')
  })

  it('surfaces a stale refusal instead of pretending the commit landed', async () => {
    commitMock.mockResolvedValue({ state: 'stale', snapshot: 'snap-9' })
    seedEntries([file('src/a.ts', { staged: true, unstaged: false })])
    renderBox()
    typeMessage('feat: stale')
    fireEvent.click(screen.getByTestId('workspace-review-commit-primary'))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-review-commit-message')).toHaveValue('feat: stale')
  })

  it('reports nothing_to_commit without clearing the message', async () => {
    commitMock.mockResolvedValue({ state: 'ok', snapshot: 'snap-1', outcome: 'nothing_to_commit' })
    seedEntries([file('src/a.ts', { staged: true, unstaged: false })])
    renderBox()
    typeMessage('feat: empty index')
    fireEvent.click(screen.getByTestId('workspace-review-commit-primary'))
    expect(await screen.findByRole('alert')).toHaveTextContent('There is nothing staged to commit')
    expect(screen.getByTestId('workspace-review-commit-message')).toHaveValue('feat: empty index')
  })

  it('is inert while the panel is stale or loading', () => {
    renderBox({ enabled: false })
    expect(screen.getByTestId('workspace-review-commit-primary')).toBeDisabled()
  })

  it('turns the commit button into a cancel affordance while committing, and aborts on the second click', async () => {
    seedEntries([file('src/a.ts', { staged: true, unstaged: false })])
    let capturedSignal: AbortSignal | undefined
    let rejectCommit!: (error: Error) => void
    commitMock.mockImplementation((_sessionId: string, _request: unknown, _source: unknown, options?: { signal?: AbortSignal }) => {
      capturedSignal = options?.signal
      return new Promise((_resolve, reject) => { rejectCommit = reject })
    })
    renderBox()
    typeMessage('feat: slow hooks')
    fireEvent.click(screen.getByTestId('workspace-review-commit-primary'))

    // The primary stays clickable and names the cancel action.
    const primary = screen.getByTestId('workspace-review-commit-primary')
    await waitFor(() => expect(primary).toHaveTextContent('Cancel commit'))
    expect(primary).toBeEnabled()
    expect(capturedSignal).toBeDefined()
    expect(capturedSignal!.aborted).toBe(false)

    fireEvent.click(primary)
    expect(capturedSignal!.aborted).toBe(true)

    // The aborted request rejects; the box reports the cancellation and
    // re-reads the comparison because the commit may still have landed.
    rejectCommit(new DOMException('The operation was aborted', 'AbortError'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Commit cancelled')
    expect(commitMock).toHaveBeenCalledTimes(1)
    // Back to the commit affordance, message kept for a retry.
    await waitFor(() => expect(screen.getByTestId('workspace-review-commit-primary')).toHaveTextContent('Commit'))
    expect(screen.getByTestId('workspace-review-commit-message')).toHaveValue('feat: slow hooks')
  })

  it('surfaces a failed commit request as an error without clearing the message', async () => {
    seedEntries([file('src/a.ts', { staged: true, unstaged: false })])
    commitMock.mockRejectedValue(new Error('hook declined'))
    renderBox()
    typeMessage('feat: hooks fail')
    fireEvent.click(screen.getByTestId('workspace-review-commit-primary'))
    expect(await screen.findByRole('alert')).toHaveTextContent('hook declined')
    expect(screen.getByTestId('workspace-review-commit-message')).toHaveValue('feat: hooks fail')
  })
})