import { useEffect, useRef, useState } from 'react'
import { CircleAlert, CircleCheck, GitCommitHorizontal, ScanSearch } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/CopyButton'
import { SelectField } from '@/components/ui/SelectField'
import { Spinner } from '@/components/ui/Spinner'
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer'
import { useTranslation } from '../../i18n'
import { useSettingsStore } from '../../stores/settingsStore'
import { reviewApi, type GitReviewSource, type ReviewAiKind, type ReviewAiResult } from '../../api/review'

const COPY_BUTTON = 'inline-flex h-7 shrink-0 items-center rounded-[var(--radius-sm)] border border-[var(--color-border)] px-2.5 text-[12px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]'

/** Map the renderer's locale to the language the review should be written in. */
function reviewLanguageForLocale(locale: string): string {
  switch (locale) {
    case 'zh':
    case 'zh-TW':
      return 'Chinese'
    case 'jp':
      return 'Japanese'
    case 'kr':
      return 'Korean'
    default:
      return 'English'
  }
}

/**
 * AI generation for the review panel: code-review findings (Markdown) or a
 * Conventional Commit message (plain text, copyable). Generation only — the
 * dialog never stages or commits; the user copies the message and commits
 * where they normally do.
 *
 * Single caller (`WorkspaceReviewTab`), so it lives in this feature directory
 * rather than `ui/` or `composite/`.
 */
export function ReviewAiDialog({
  open,
  kind,
  sessionId,
  source,
  onClose,
}: {
  open: boolean
  kind: ReviewAiKind
  sessionId: string
  source: GitReviewSource
  onClose: () => void
}) {
  const t = useTranslation()
  const locale = useSettingsStore((state) => state.locale)
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<ReviewAiResult | null>(null)
  const [transportError, setTransportError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  // Commit messages default to English regardless of UI locale; the user can
  // switch to Chinese. Changing it regenerates through the attempt counter.
  const [messageLanguage, setMessageLanguage] = useState<'en' | 'zh'>('en')
  const controllerRef = useRef<AbortController | null>(null)

  const sourceKey = JSON.stringify(source)

  // One request per open; closing aborts it. A retry bumps `attempt` instead
  // of re-opening, so a failed generation can be repeated without losing the
  // dialog's context.
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    controllerRef.current = controller
    setPending(true)
    setResult(null)
    setTransportError(null)
    void reviewApi.aiGenerate(sessionId, {
      kind,
      source: JSON.parse(sourceKey) as GitReviewSource,
      ...(kind === 'review'
        ? { language: reviewLanguageForLocale(locale) }
        : { language: messageLanguage === 'zh' ? 'Chinese' : 'English' }),
    }, { signal: controller.signal }).then(
      (answer) => {
        if (controller.signal.aborted) return
        setResult(answer)
        setPending(false)
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setTransportError(error instanceof Error ? error.message : String(error))
        setPending(false)
      },
    )
    return () => controller.abort()
    // `locale` is read at request time only; switching language mid-dialog
    // must not silently regenerate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind, sessionId, sourceKey, attempt, messageLanguage])

  const title = t(kind === 'review' ? 'workspace.review.aiReviewTitle' : 'workspace.review.aiCommitTitle')
  const close = () => {
    controllerRef.current?.abort()
    onClose()
  }
  const retry = () => setAttempt((current) => current + 1)

  const failure = transportError
    ?? (result && result.state === 'provider_error' ? result.message : null)
    ?? (result && (result.state === 'no_provider' || result.state === 'error') ? result.error : null)

  return (
    <Modal
      open={open}
      onClose={close}
      title={title}
      width={kind === 'review' ? 720 : 560}
      footer={(
        <>
          {kind === 'commit-message' ? (
            <SelectField<'en' | 'zh'>
              label={t('workspace.review.aiLanguage')}
              labelHidden
              size="sm"
              containerClassName="mr-auto"
              value={messageLanguage}
              data-testid="review-ai-language"
              options={[
                { value: 'en', label: t('workspace.review.aiLanguageEnglish') },
                { value: 'zh', label: t('workspace.review.aiLanguageChinese') },
              ]}
              onChange={setMessageLanguage}
            />
          ) : null}
          {result?.state === 'ok' ? (
            <CopyButton
              text={result.text}
              label={t(kind === 'review' ? 'workspace.review.aiCopyReview' : 'workspace.review.aiCopyMessage')}
              copiedLabel={t('common.copied')}
              className={`${COPY_BUTTON} mr-auto`}
            />
          ) : null}
          {failure ? (
            <Button variant="secondary" size="sm" onClick={retry}>{t('common.retry')}</Button>
          ) : null}
          <Button variant="secondary" size="sm" onClick={close}>{t('common.close')}</Button>
        </>
      )}
    >
      {pending ? (
        <div data-testid="review-ai-loading" className="flex items-center justify-center gap-2 py-10 text-[13px] text-[var(--color-text-secondary)]">
          <Spinner size={16} />
          {t('workspace.review.aiGenerating')}
        </div>
      ) : failure ? (
        <p
          role="alert"
          data-testid="review-ai-error"
          className="rounded-[var(--radius-md)] bg-[var(--color-error-container)] px-3 py-2.5 text-[13px] text-[var(--color-on-error-container)]"
        >
          <CircleAlert size={14} strokeWidth={1.75} aria-hidden="true" className="mr-1.5 inline-block align-[-2px]" />
          {result?.state === 'no_provider' ? t('workspace.review.aiNoProvider') : failure}
        </p>
      ) : result?.state === 'no_changes' ? (
        <p className="flex items-center gap-2 py-6 text-[13px] text-[var(--color-text-secondary)]">
          <CircleCheck size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-success)]" />
          {t('workspace.review.empty')}
        </p>
      ) : result?.state === 'ok' ? (
        <div data-testid="review-ai-result" className="flex flex-col gap-2">
          <p className="flex items-center gap-1.5 text-[12px] text-[var(--color-text-tertiary)]">
            {kind === 'review'
              ? <ScanSearch size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
              : <GitCommitHorizontal size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />}
            <span>
              {t('workspace.review.aiCoverage', { included: result.includedFiles, total: result.totalFiles })}
              {result.truncated ? ` · ${t('workspace.review.aiTruncated')}` : ''}
            </span>
          </p>
          {kind === 'review' ? (
            <MarkdownRenderer content={result.text} variant="compact" />
          ) : (
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container)] p-3 font-mono text-[12px] leading-5 text-[var(--color-text-primary)]">
              {result.text}
            </pre>
          )}
        </div>
      ) : null}
    </Modal>
  )
}