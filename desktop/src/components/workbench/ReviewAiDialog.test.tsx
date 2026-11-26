import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const reviewApi = vi.hoisted(() => ({ aiGenerate: vi.fn() }))
vi.mock('../../api/review', () => ({ reviewApi }))

/** Markdown rendering has its own suite; here only the text is the signal. */
vi.mock('@/components/markdown/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}))

import { ReviewAiDialog } from './ReviewAiDialog'
import { useSettingsStore } from '../../stores/settingsStore'
import type { ReviewAiResult } from '../../api/review'

function okResult(overrides: Partial<Extract<ReviewAiResult, { state: 'ok' }>> = {}): ReviewAiResult {
  return {
    state: 'ok',
    kind: 'review',
    source: { kind: 'unstaged' },
    snapshot: 'snap-1',
    text: '## Assessment\n\nLooks good.',
    includedFiles: 2,
    totalFiles: 3,
    truncated: false,
    ...overrides,
  }
}

function renderDialog(props: Partial<Parameters<typeof ReviewAiDialog>[0]> = {}) {
  return render(
    <ReviewAiDialog
      open
      kind="review"
      sessionId="session-a"
      source={{ kind: 'unstaged' }}
      onClose={() => {}}
      {...props}
    />,
  )
}

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
  reviewApi.aiGenerate.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('ReviewAiDialog', () => {
  it('names the dialog and shows a loading state while generating', async () => {
    let resolveAnswer!: (value: ReviewAiResult) => void
    reviewApi.aiGenerate.mockImplementation(() => new Promise<ReviewAiResult>(resolve => { resolveAnswer = resolve }))
    renderDialog()
    expect(screen.getByRole('dialog', { name: 'AI code review' })).toBeInTheDocument()
    expect(screen.getByTestId('review-ai-loading')).toHaveTextContent('Generating…')
    resolveAnswer(okResult())
    await waitFor(() => expect(screen.getByTestId('review-ai-result')).toBeInTheDocument())
  })

  it('requests the review in the UI language and renders coverage with the answer', async () => {
    useSettingsStore.setState({ locale: 'zh' })
    reviewApi.aiGenerate.mockResolvedValue(okResult({ truncated: true }))
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('review-ai-result')).toBeInTheDocument())
    expect(reviewApi.aiGenerate).toHaveBeenCalledWith(
      'session-a',
      { kind: 'review', source: { kind: 'unstaged' }, language: 'Chinese' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(screen.getByTestId('markdown')).toHaveTextContent('Looks good.')
    expect(screen.getByTestId('review-ai-result')).toHaveTextContent('2/3')
    expect(screen.getByTestId('review-ai-result')).toHaveTextContent('截断')
    expect(screen.getByRole('button', { name: '复制审查结果' })).toBeInTheDocument()
  })

  it('shows a commit message as copyable plain text, without a language request', async () => {
    reviewApi.aiGenerate.mockResolvedValue(okResult({
      kind: 'commit-message',
      text: 'feat(review): add AI generation',
      includedFiles: 1,
      totalFiles: 1,
    }))
    renderDialog({ kind: 'commit-message', source: { kind: 'staged' } })
    expect(await screen.findByText('feat(review): add AI generation')).toBeInTheDocument()
    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeInTheDocument()
    expect(reviewApi.aiGenerate).toHaveBeenCalledWith(
      'session-a',
      { kind: 'commit-message', source: { kind: 'staged' } },
      expect.anything(),
    )
  })

  it('renders the no-provider state with its own guidance and a retry', async () => {
    reviewApi.aiGenerate.mockResolvedValue({ state: 'no_provider', kind: 'review', error: 'No saved provider is available for AI generation' })
    renderDialog()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('No model provider is configured')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(reviewApi.aiGenerate).toHaveBeenCalledTimes(2))
  })

  it('surfaces the provider error message and retries on demand', async () => {
    reviewApi.aiGenerate.mockResolvedValueOnce({ state: 'provider_error', kind: 'review', reason: 'auth', message: 'Provider rejected the API key' })
    reviewApi.aiGenerate.mockResolvedValueOnce(okResult())
    renderDialog()
    expect(await screen.findByRole('alert')).toHaveTextContent('Provider rejected the API key')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByTestId('review-ai-result')).toBeInTheDocument())
  })

  it('shows the clean-comparison answer without a copy affordance', async () => {
    reviewApi.aiGenerate.mockResolvedValue({ state: 'no_changes', kind: 'review', source: { kind: 'unstaged' }, snapshot: 'snap-1' })
    renderDialog()
    expect(await screen.findByText('No changes in this comparison')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy review' })).not.toBeInTheDocument()
  })

  it('reports a transport failure as an alert', async () => {
    reviewApi.aiGenerate.mockRejectedValue(new Error('Request timed out after 120s'))
    renderDialog()
    expect(await screen.findByRole('alert')).toHaveTextContent('Request timed out after 120s')
  })

  it('aborts the in-flight request when closed', async () => {
    let capturedSignal: AbortSignal | undefined
    reviewApi.aiGenerate.mockImplementation((_session: string, _request: unknown, options: { signal: AbortSignal }) => {
      capturedSignal = options.signal
      return new Promise<ReviewAiResult>(() => {})
    })
    const onClose = vi.fn()
    const view = renderDialog({ onClose })
    await waitFor(() => expect(capturedSignal).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
    view.rerender(
      <ReviewAiDialog open={false} kind="review" sessionId="session-a" source={{ kind: 'unstaged' }} onClose={onClose} />,
    )
    expect(capturedSignal!.aborted).toBe(true)
  })
})