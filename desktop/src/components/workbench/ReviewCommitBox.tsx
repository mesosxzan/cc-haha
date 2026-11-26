import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, GitCommitHorizontal, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Spinner } from '@/components/ui/Spinner'
import { TextArea } from '@/components/ui/TextArea'
import { SelectField } from '@/components/ui/SelectField'
import { useDismissable } from '@/hooks/useDismissable'
import { detectPlatform } from '@/lib/workspace/shortcuts'
import { useTranslation } from '../../i18n'
import { useWorkspaceReviewStore } from '../../stores/workspaceReviewStore'
import { reviewApi, type ReviewSyncState } from '../../api/review'
import type { WorkspaceReviewSource } from '../../lib/workspace/types'
import { useMenuKeyboard } from './menuKeyboard'

const COMMIT_MENU_ITEM = 'flex h-8 w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 text-left text-[13px] text-[var(--color-text-primary)] outline-none transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)] disabled:cursor-not-allowed disabled:opacity-50'

/** The four commit affordances, in the reference's order. */
type CommitAction = 'commit' | 'amend' | 'commit-push' | 'commit-sync'

export type ReviewCommitBoxProps = {
  sessionId: string
  /** Comparison whose refreshed status a commit should carry back. */
  source: WorkspaceReviewSource
  /** False while the panel is stale or loading; the box stays visible but inert. */
  enabled: boolean
}

/**
 * The source-control commit box: message field with an AI fill, ⌘/Ctrl+Enter
 * to commit, and a split button whose menu offers amend / commit-and-push /
 * commit-and-sync.
 *
 * A commit always acts on the index. When nothing is staged and there are
 * tracked changes, the plain commit stages them first (the reference client's
 * "commit all" behaviour); untracked files are never swept in silently.
 */
export function ReviewCommitBox({ sessionId, source, enabled }: ReviewCommitBoxProps) {
  const t = useTranslation()
  const [message, setMessage] = useState('')
  const [action, setAction] = useState<CommitAction>('commit')
  const [menuOpen, setMenuOpen] = useState(false)
  const [busy, setBusy] = useState<'commit' | 'ai' | 'sync' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [syncState, setSyncState] = useState<ReviewSyncState | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuTriggerRef = useRef<HTMLButtonElement>(null)
  const commitAbortRef = useRef<AbortController | null>(null)
  const aiAbortRef = useRef<AbortController | null>(null)
  // English by default: commit messages are read by tooling and teammates
  // beyond the author's locale. The choice is per-box, not persisted.
  const [aiLanguage, setAiLanguage] = useState<'en' | 'zh'>('en')
  const revision = useWorkspaceReviewStore((state) => state.revisionBySession[sessionId] ?? 0)
  const shortcutLabel = detectPlatform() === 'mac' ? '⌘↵' : 'Ctrl+↵'

  const refreshSyncState = useCallback(async () => {
    try {
      setSyncState(await reviewApi.getSyncState(sessionId))
    } catch {
      // The counts are an affordance, not a gate; a failed probe just hides them.
      setSyncState(null)
    }
  }, [sessionId])

  useEffect(() => {
    void refreshSyncState()
  }, [refreshSyncState, revision])

  const closeMenu = useCallback(() => setMenuOpen(false), [])
  useDismissable({ open: menuOpen, refs: [menuRef, menuTriggerRef], onDismiss: closeMenu })
  const handleMenuKeyDown = useMenuKeyboard({
    open: menuOpen,
    menuRef,
    triggerRef: menuTriggerRef,
    onClose: closeMenu,
  })

  const runRemote = async (operation: 'push' | 'sync') => {
    const result = await useWorkspaceReviewStore.getState()[operation](sessionId)
    if (result.state !== 'ok') setError(result.error ?? t('workspace.review.remoteFailed'))
    await refreshSyncState()
    return result.state === 'ok'
  }

  /**
   * Cancelling aborts the request; the server kills the git process, but the
   * kill can land after git finished. The catch path therefore refreshes the
   * comparison instead of asserting nothing was committed.
   */
  const cancelCommit = () => {
    commitAbortRef.current?.abort()
  }

  const runCommit = async (chosen: CommitAction) => {
    if (busy === 'commit') {
      cancelCommit()
      return
    }
    if (busy || !enabled) return
    const text = message.trim()
    if (!text) {
      setError(t('workspace.review.commitMessageRequired'))
      return
    }
    setBusy('commit')
    setError(null)
    const abort = new AbortController()
    commitAbortRef.current = abort
    try {
      const store = useWorkspaceReviewStore.getState()
      const guard = store.getEntry(sessionId, { kind: 'uncommitted' })
      const files = guard.status?.files ?? []
      const untracked = new Set(guard.status?.untracked ?? [])
      const hasStaged = files.some((file) => file.staged)
      const trackedPaths = files.filter((file) => !untracked.has(file.path)).map((file) => file.path)

      // "Commit all" only for the plain commit: the explicit menu actions keep
      // acting on exactly what the user staged.
      if (chosen === 'commit' && !hasStaged && trackedPaths.length > 0) {
        const staged = await store.stage(sessionId, { kind: 'uncommitted' }, trackedPaths)
        if (staged.state === 'stale' || staged.state === 'refused') {
          setError(t(staged.state === 'stale' ? 'workspace.review.stale' : 'workspace.review.refusedNoSnapshot'))
          return
        }
        if (staged.state !== 'ok' && staged.state !== 'partial') {
          setError(staged.error ?? t('workspace.review.remoteFailed'))
          return
        }
      }

      const result = await useWorkspaceReviewStore.getState().commit(
        sessionId,
        { message: text, ...(chosen === 'amend' ? { amend: true } : {}) },
        source,
        { signal: abort.signal },
      )
      if (result.state === 'refused') {
        setError(t(result.refusal === 'no_snapshot' ? 'workspace.review.refusedNoSnapshot' : 'workspace.review.readOnlySource'))
        return
      }
      if (result.state === 'stale') {
        setError(t('workspace.review.stale'))
        return
      }
      if (result.state !== 'ok') {
        setError(result.error ?? t('workspace.review.remoteFailed'))
        return
      }
      if (result.outcome === 'nothing_to_commit') {
        setError(t('workspace.review.nothingToCommit'))
        return
      }
      setMessage('')
      if (chosen === 'commit-push') await runRemote('push')
      if (chosen === 'commit-sync') await runRemote('sync')
      await refreshSyncState()
    } catch (caught) {
      if (abort.signal.aborted) {
        // The commit may still have landed between the click and the kill;
        // re-read instead of trusting either outcome.
        setError(t('workspace.review.commitCancelled'))
        await useWorkspaceReviewStore.getState().load(sessionId, source, { force: true }).catch(() => {})
        await refreshSyncState()
      } else {
        setError(caught instanceof Error ? caught.message : t('workspace.review.remoteFailed'))
      }
    } finally {
      commitAbortRef.current = null
      setBusy(null)
    }
  }

  const fillWithAi = async () => {
    if (busy === 'ai') {
      aiAbortRef.current?.abort()
      return
    }
    if (busy) return
    setBusy('ai')
    setError(null)
    const abort = new AbortController()
    aiAbortRef.current = abort
    try {
      const stagedSource = useWorkspaceReviewStore.getState().getEntry(sessionId, { kind: 'staged' })
      const target = stagedSource.status?.files.length
        ? { kind: 'staged' } as const
        : { kind: 'uncommitted' } as const
      const result = await reviewApi.aiGenerate(
        sessionId,
        { kind: 'commit-message', source: target, language: aiLanguage === 'zh' ? 'Chinese' : 'English' },
        { signal: abort.signal },
      )
      if (result.state === 'ok') setMessage(result.text)
      else if (result.state === 'no_changes') setError(t('workspace.review.empty'))
      else if (result.state === 'no_provider') setError(t('workspace.review.aiNoProvider'))
      else setError('message' in result ? result.message : result.error)
    } catch (caught) {
      // A user cancel is not a failure: keep whatever message was there.
      if (!abort.signal.aborted) {
        setError(caught instanceof Error ? caught.message : t('workspace.review.remoteFailed'))
      }
    } finally {
      aiAbortRef.current = null
      setBusy(null)
    }
  }

  const runSyncNow = async () => {
    if (busy) return
    setBusy('sync')
    setError(null)
    try {
      await runRemote('sync')
    } finally {
      setBusy(null)
    }
  }

  const amend = action === 'amend'
  const primaryLabel = t(
    action === 'commit' ? 'workspace.review.commit'
      : action === 'amend' ? 'workspace.review.commitAmend'
        : action === 'commit-push' ? 'workspace.review.commitPush'
          : 'workspace.review.commitSync',
  )
  const canSync = Boolean(syncState?.upstream)
  const menuItems: Array<{ action: CommitAction; label: string; disabled?: boolean }> = [
    { action: 'commit', label: t('workspace.review.commit') },
    { action: 'amend', label: t('workspace.review.commitAmend') },
    { action: 'commit-push', label: t('workspace.review.commitPush') },
    { action: 'commit-sync', label: t('workspace.review.commitSync'), disabled: !canSync },
  ]

  return (
    <div data-testid="workspace-review-commit-box" className="shrink-0 border-b border-[var(--color-border)] px-3 py-2.5">
      <div className="relative">
        <TextArea
          rows={2}
          value={message}
          disabled={busy === 'commit'}
          error={error ?? undefined}
          aria-label={t('workspace.review.commitMessageLabel')}
          placeholder={t('workspace.review.commitPlaceholder', { shortcut: shortcutLabel })}
          containerClassName="gap-0"
          className="min-h-[52px] resize-y pr-9 text-[13px] leading-5"
          data-testid="workspace-review-commit-message"
          onChange={(event) => { setMessage(event.target.value); setError(null) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void runCommit(action)
            }
          }}
        />
        <span className="absolute right-1.5 top-1.5">
          {/* While generating, the same button cancels the request. */}
          <IconButton
            icon={busy === 'ai'
              ? <X size={14} strokeWidth={1.75} />
              : <GitCommitHorizontal size={14} strokeWidth={1.75} />}
            label={t(busy === 'ai' ? 'workspace.review.aiCancel' : 'workspace.review.aiCommitMessage')}
            size="sm"
            tone="muted"
            aria-busy={busy === 'ai' || undefined}
            data-testid={busy === 'ai' ? 'workspace-review-commit-ai-loading' : 'workspace-review-commit-ai'}
            disabled={busy !== null && busy !== 'ai'}
            onClick={() => { void fillWithAi() }}
          />
        </span>
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        <span className="relative flex min-w-0 flex-1 items-stretch">
          {/* The wrapper clips the split-button corners: overriding the
              Button's radius via className would leave two rounded-* classes
              fighting over stylesheet order (components/AGENTS.md §3.6). */}
          <span className="flex min-w-0 flex-1 overflow-hidden rounded-[var(--radius-md)]">
          {/* While committing, the same button becomes the cancel affordance:
              `loading` would disable it, so the spinner is rendered by hand. */}
          <Button
            variant="primary"
            size="base"
            block
            icon={busy === 'commit'
              ? <X size={14} strokeWidth={1.75} aria-hidden="true" />
              : amend ? undefined : <Check size={14} strokeWidth={1.75} aria-hidden="true" />}
            aria-busy={busy === 'commit' || undefined}
            disabled={busy === 'commit' ? false : !enabled || busy !== null}
            data-testid="workspace-review-commit-primary"
            onClick={() => { void runCommit(action) }}
          >
            {busy === 'commit' ? (
              <>
                <Spinner size={13} label={t('workspace.review.commitCancel')} />
                <span className="truncate">{t('workspace.review.commitCancel')}</span>
              </>
            ) : (
              <>
                <span className="truncate">{primaryLabel}</span>
                <span aria-hidden="true" className="ml-1 text-[11px] opacity-70">{shortcutLabel}</span>
              </>
            )}
          </Button>
          <button
            ref={menuTriggerRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={t('workspace.review.commitOptions')}
            disabled={busy === 'commit'}
            data-testid="workspace-review-commit-menu"
            onClick={() => setMenuOpen((open) => !open)}
            className="flex w-7 shrink-0 items-center justify-center border-l border-[var(--color-btn-primary-fg)] bg-[var(--color-btn-primary-bg)] text-[var(--color-btn-primary-fg)] transition-colors hover:bg-[var(--color-btn-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ChevronDown size={12} strokeWidth={2} aria-hidden="true" />
          </button>
          </span>
          {menuOpen ? (
            <div
              ref={menuRef}
              role="menu"
              aria-label={t('workspace.review.commitOptions')}
              onKeyDown={handleMenuKeyDown}
              className="absolute left-0 top-9 z-[var(--z-dropdown)] min-w-[220px] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-1 shadow-[var(--shadow-dropdown)]"
            >
              {menuItems.map((item) => (
                <button
                  key={item.action}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  data-testid={`workspace-review-commit-option-${item.action}`}
                  onClick={() => {
                    setMenuOpen(false)
                    setAction(item.action)
                    void runCommit(item.action)
                  }}
                  className={COMMIT_MENU_ITEM}
                >
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {action === item.action ? <Check size={14} strokeWidth={2} aria-hidden="true" className="shrink-0 text-[var(--color-brand)]" /> : null}
                </button>
              ))}
            </div>
          ) : null}
        </span>
        <SelectField<'en' | 'zh'>
          label={t('workspace.review.aiLanguage')}
          labelHidden
          size="sm"
          value={aiLanguage}
          disabled={busy !== null}
          data-testid="workspace-review-commit-ai-language"
          options={[
            { value: 'en', label: t('workspace.review.aiLanguageEnglish') },
            { value: 'zh', label: t('workspace.review.aiLanguageChinese') },
          ]}
          onChange={setAiLanguage}
        />
        {syncState?.upstream && (syncState.ahead > 0 || syncState.behind > 0) ? (
          <Button
            variant="secondary"
            size="base"
            loading={busy === 'sync'}
            disabled={busy !== null}
            icon={<RefreshCw size={13} strokeWidth={1.75} aria-hidden="true" />}
            data-testid="workspace-review-sync-now"
            onClick={() => { void runSyncNow() }}
          >
            <span className="font-mono tabular-nums">{`↓${syncState.behind} ↑${syncState.ahead}`}</span>
            <span className="sr-only">{t('workspace.review.syncNow')}</span>
          </Button>
        ) : null}
      </div>
    </div>
  )
}