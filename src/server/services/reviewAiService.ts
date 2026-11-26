/**
 * AI generation for the Git review panel: code review findings and commit
 * messages, both computed from the same explicit review source the panel is
 * showing (unstaged / staged / uncommitted / branch / commit).
 *
 * Diff collection reuses `ReviewService.getStatus` + `getFileDiff` so path
 * containment, untracked synthesis and the per-file diff caps behave exactly
 * as they do in the panel. The model call goes through `providerTextCompletion`
 * with the same provider resolution session titles use (haiku-class model of
 * the requested or active provider), so OAuth, account-grant and proxied
 * OpenAI-format providers all work without extra wiring.
 *
 * This service only generates text. It never stages, commits or otherwise
 * writes to the repository.
 */

import { ProviderService } from './providerService.js'
import { loadNetworkSettings } from './networkSettings.js'
import { isOpenAIOfficialProviderId } from './openaiOfficialProvider.js'
import { isDeepSeekAccountProviderId } from './deepseekAccountProvider.js'
import {
  providerTextCompletion,
  type ProviderTextCompletionFailureReason,
} from './providerTextCompletion.js'
import type { ReviewService, ReviewSource, ResolvedReviewSource } from './reviewService.js'

export type ReviewAiKind = 'review' | 'commit-message'

/** Everything `ReviewService` serves except the transcript-backed turn source. */
export type ReviewAiSource = Exclude<ReviewSource, { kind: 'turn' }>

export type ReviewAiRequest = {
  sessionId: string
  kind: ReviewAiKind
  source: ReviewAiSource
  /** Saved provider to use; falls back to the active provider when omitted. */
  providerId?: string | null
  /** Response language, e.g. "Chinese". English when omitted; applies to both kinds. */
  language?: string
  signal?: AbortSignal
}

export type ReviewAiResult =
  | {
    state: 'ok'
    kind: ReviewAiKind
    source: ResolvedReviewSource
    snapshot: string
    text: string
    /** Files whose diff text was sent to the model, out of `totalFiles`. */
    includedFiles: number
    totalFiles: number
    /** Some diff text was cut to fit the prompt budget. */
    truncated: boolean
  }
  | { state: 'no_changes'; kind: ReviewAiKind; source: ResolvedReviewSource; snapshot: string }
  | { state: 'no_provider'; kind: ReviewAiKind; error: string }
  | {
    state: 'provider_error'
    kind: ReviewAiKind
    reason: ProviderTextCompletionFailureReason
    message: string
  }
  | { state: 'error'; kind: ReviewAiKind; error: string }

/**
 * Prompt budget in characters. Review diffs are read, not applied, so cutting
 * mid-hunk is safe here (unlike the staging path); every cut is marked inline
 * and reported through `truncated` so the answer can be trusted accordingly.
 */
const REVIEW_AI_TOTAL_DIFF_CHARS = 120_000
const REVIEW_AI_PER_FILE_DIFF_CHARS = 20_000
const TRUNCATION_MARKER = '\n... [diff truncated to fit the prompt budget]\n'

const REVIEW_MAX_OUTPUT_TOKENS = 4096
const COMMIT_MESSAGE_MAX_OUTPUT_TOKENS = 2048
/** Whole-call limits; a large diff legitimately takes longer than a title. */
const REVIEW_AI_TIMEOUT_MS = 90_000
const REVIEW_AI_ATTEMPT_TIMEOUT_MS = 60_000

const REVIEW_SYSTEM_PROMPT = [
  'You are a senior code reviewer. You are given the file list and unified diffs of one explicit Git comparison.',
  'Review the changes for correctness bugs, security issues, data loss risks, broken edge cases and maintainability problems introduced by the diff itself.',
  'Report only findings you can ground in the shown diff; do not speculate about code you cannot see.',
  'Output GitHub-flavored Markdown:',
  '- Start with a one-paragraph overall assessment.',
  '- Then list findings ordered by severity (high / medium / low). For each: severity, `path` (and line numbers when the hunk headers make them clear), what is wrong, and a concrete suggestion.',
  '- If a file was truncated or omitted from the prompt, say so instead of reviewing it blind.',
  '- If there are no substantive issues, say the change looks good and stop; do not invent nitpicks.',
  'Keep the whole answer focused and concise. Do not restate the diff.',
].join('\n')

const COMMIT_MESSAGE_SYSTEM_PROMPT = [
  'You write Git commit messages for the exact set of changes shown in the unified diffs.',
  'Follow the Conventional Commits format: `type(scope): subject` where type is one of feat, fix, refactor, perf, docs, test, build, ci, chore, style, revert.',
  'Rules:',
  '- Subject in the language the user prompt asks for (English by default), imperative mood, no trailing period, at most 72 characters.',
  '- Choose the scope from the dominant area of the change; omit it when the change is cross-cutting.',
  '- When the change is non-trivial, add a blank line and a short body of `- ` bullets explaining why the change was made, wrapped at 72 columns.',
  '- Describe only what the diffs actually show; never invent motivation.',
  '- Output only the commit message text. No code fences, no commentary, no quotes around it.',
].join('\n')

export async function generateReviewAi(
  reviewService: ReviewService,
  request: ReviewAiRequest,
): Promise<ReviewAiResult> {
  const { sessionId, kind, source } = request

  const status = await reviewService.getStatus(sessionId, source)
  if (status.state !== 'ok') {
    return { state: 'error', kind, error: status.error ?? `Review state: ${status.state}` }
  }
  if (status.files.length === 0) {
    return { state: 'no_changes', kind, source: status.source, snapshot: status.snapshot }
  }

  const provider = await resolveProvider(request.providerId)
  if (!provider) {
    return { state: 'no_provider', kind, error: 'No saved provider is available for AI generation' }
  }

  const collected = await collectDiffs(reviewService, sessionId, source, status.files)
  const user = buildUserPrompt(kind, status.source, collected, request.language)

  const result = await providerTextCompletion({
    provider,
    modelId: provider.models.haiku || provider.models.main,
    system: kind === 'review' ? REVIEW_SYSTEM_PROMPT : COMMIT_MESSAGE_SYSTEM_PROMPT,
    user,
    maxTokens: kind === 'review' ? REVIEW_MAX_OUTPUT_TOKENS : COMMIT_MESSAGE_MAX_OUTPUT_TOKENS,
    sessionId,
    signal: request.signal,
    timeoutMs: REVIEW_AI_TIMEOUT_MS,
    attemptTimeoutMs: REVIEW_AI_ATTEMPT_TIMEOUT_MS,
    networkSettings: await loadNetworkSettings(),
  })

  if (!result.ok) {
    return { state: 'provider_error', kind, reason: result.reason, message: result.message }
  }
  const text = result.text.trim()
  if (!text) {
    return {
      state: 'provider_error',
      kind,
      reason: 'upstream',
      message: 'The model returned an empty answer',
    }
  }

  return {
    state: 'ok',
    kind,
    source: status.source,
    snapshot: status.snapshot,
    text,
    includedFiles: collected.includedFiles,
    totalFiles: status.files.length,
    truncated: collected.truncated,
  }
}

async function resolveProvider(providerId?: string | null) {
  const providerService = new ProviderService()
  if (providerId) {
    try {
      return await providerService.getProvider(providerId)
    } catch {
      // A stale provider id from the renderer falls back to the active one.
    }
  }
  const { activeId, providers } = await providerService.listProviders()
  if (!activeId) return null
  if (isOpenAIOfficialProviderId(activeId) || isDeepSeekAccountProviderId(activeId)) {
    try {
      return await providerService.getProvider(activeId)
    } catch {
      return null
    }
  }
  return providers.find((provider) => provider.id === activeId) ?? null
}

type CollectedDiffs = {
  /** Per-file diff sections already wrapped for the prompt. */
  sections: string[]
  /** Every changed path with its status, including files left out of the diff text. */
  fileSummary: string[]
  includedFiles: number
  truncated: boolean
}

async function collectDiffs(
  reviewService: ReviewService,
  sessionId: string,
  source: ReviewAiSource,
  files: Array<{ path: string; oldPath?: string; status: string; binary: boolean }>,
): Promise<CollectedDiffs> {
  const sections: string[] = []
  const fileSummary: string[] = []
  let budget = REVIEW_AI_TOTAL_DIFF_CHARS
  let includedFiles = 0
  let truncated = false

  for (const file of files) {
    const label = file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path
    if (file.binary) {
      fileSummary.push(`- ${label} (${file.status}, binary; diff omitted)`)
      truncated = true
      continue
    }
    if (budget <= 0) {
      fileSummary.push(`- ${label} (${file.status}; diff omitted, prompt budget reached)`)
      truncated = true
      continue
    }

    const diff = await reviewService.getFileDiff(sessionId, {
      source,
      path: file.path,
      oldPath: file.oldPath,
    })
    if (diff.state !== 'ok' || !diff.diff) {
      fileSummary.push(`- ${label} (${file.status}; diff unavailable${diff.error ? `: ${diff.error}` : ''})`)
      continue
    }
    if (diff.binary) {
      fileSummary.push(`- ${label} (${file.status}, binary; diff omitted)`)
      truncated = true
      continue
    }

    let text = diff.diff
    let cut = Boolean(diff.truncated)
    if (text.length > REVIEW_AI_PER_FILE_DIFF_CHARS) {
      text = text.slice(0, REVIEW_AI_PER_FILE_DIFF_CHARS)
      cut = true
    }
    if (text.length > budget) {
      text = text.slice(0, budget)
      cut = true
    }
    budget -= text.length
    if (cut) {
      text += TRUNCATION_MARKER
      truncated = true
    }
    includedFiles += 1
    fileSummary.push(`- ${label} (${file.status}${cut ? ', diff truncated' : ''})`)
    sections.push(`### ${label}\n\n\`\`\`diff\n${text}\n\`\`\``)
  }

  return { sections, fileSummary, includedFiles, truncated }
}

function buildUserPrompt(
  kind: ReviewAiKind,
  source: ResolvedReviewSource,
  collected: CollectedDiffs,
  language?: string,
): string {
  const sourceLine = source.kind === 'branch'
    ? `branch comparison against ${source.baseRef}`
    : source.kind === 'commit'
      ? `commit ${source.commit}`
      : `${source.kind} changes`
  const languageLine = kind === 'review'
    ? `Write the review in ${sanitizeLanguage(language) ?? 'English'}. Keep code identifiers, paths and commit types in their original form.`
    : `Write the commit message in ${sanitizeLanguage(language) ?? 'English'}. Keep the Conventional Commits type and scope in English regardless of the message language.`

  const task = kind === 'review'
    ? 'Review the following changes.'
    : 'Write the commit message for the following changes.'

  return [
    task,
    `Comparison: ${sourceLine}.`,
    languageLine,
    '',
    'Changed files:',
    ...collected.fileSummary,
    '',
    collected.sections.length > 0 ? collected.sections.join('\n\n') : '(no diff text could be collected)',
  ].join('\n')
}

function sanitizeLanguage(language?: string): string | null {
  const clean = language?.replace(/\s+/g, ' ').trim()
  if (!clean) return null
  return clean.slice(0, 40)
}