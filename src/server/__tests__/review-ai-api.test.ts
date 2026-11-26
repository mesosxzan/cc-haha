/**
 * Route-level regression for `POST /api/sessions/:id/review/ai-generate`.
 *
 * Throwaway git repository, temporary `CLAUDE_CONFIG_DIR`, and a loopback
 * Anthropic-format provider — no real user state, provider or network.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleSessionsApi } from '../api/sessions.js'
import { sessionService } from '../services/sessionService.js'
import { ProviderService } from '../services/providerService.js'

const BASE = 'http://127.0.0.1:3456'

let tmpDir: string
let previousConfigDir: string | undefined

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

async function createRepo(): Promise<string> {
  const repoDir = path.join(tmpDir, `repo-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(repoDir, { recursive: true })
  git(repoDir, 'init')
  git(repoDir, 'config', 'user.email', 'review-ai@example.com')
  git(repoDir, 'config', 'user.name', 'Review AI')
  git(repoDir, 'checkout', '-q', '-b', 'main')
  await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'one\ntwo\n')
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', 'initial')
  await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'one\ntwo\nthree\n')
  return repoDir
}

async function call(
  method: string,
  suffix: string,
  sessionId: string,
  body?: unknown,
): Promise<Response> {
  const target = `${BASE}/api/sessions/${sessionId}/review${suffix}`
  const url = new URL(target)
  const req = new Request(target, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  })
  const segments = url.pathname.split('/').filter(Boolean)
  return handleSessionsApi(req, url, segments)
}

type LoopbackProvider = {
  server: ReturnType<typeof Bun.serve>
  providerId: string
  requests: Array<Record<string, unknown>>
}

async function startProvider(answer: string | (() => Response)): Promise<LoopbackProvider> {
  const requests: Array<Record<string, unknown>> = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      requests.push(await req.json() as Record<string, unknown>)
      if (typeof answer === 'function') return answer()
      return Response.json({ content: [{ type: 'text', text: answer }] })
    },
  })
  const provider = await new ProviderService().addProvider({
    presetId: 'custom',
    name: 'Review AI Loopback',
    apiKey: 'test-key',
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiFormat: 'anthropic',
    models: { main: 'main-model', haiku: 'haiku-model', sonnet: 'main-model', opus: 'main-model' },
  })
  await new ProviderService().activateProvider(provider.id)
  return { server, providerId: provider.id, requests }
}

beforeEach(async () => {
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-ai-api-'))
  await fs.mkdir(path.join(tmpDir, 'projects'), { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterEach(async () => {
  if (previousConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('review ai-generate route', () => {
  it('reviews the requested source with the haiku model and sends its diff', async () => {
    const repoDir = await createRepo()
    const { sessionId } = await sessionService.createSession(repoDir)
    const provider = await startProvider('## Assessment\n\nLooks good.')
    try {
      const res = await call('POST', '/ai-generate', sessionId, {
        kind: 'review',
        source: { kind: 'unstaged' },
        providerId: provider.providerId,
        language: 'Chinese',
      })
      expect(res.status).toBe(200)
      const body = await res.json() as {
        state: string
        text: string
        includedFiles: number
        totalFiles: number
        truncated: boolean
        snapshot: string
      }
      expect(body.state).toBe('ok')
      expect(body.text).toBe('## Assessment\n\nLooks good.')
      expect(body.includedFiles).toBe(1)
      expect(body.totalFiles).toBe(1)
      expect(body.truncated).toBe(false)
      expect(body.snapshot.length).toBeGreaterThan(0)

      expect(provider.requests).toHaveLength(1)
      const sent = provider.requests[0]!
      expect(sent.model).toBe('haiku-model')
      const userText = JSON.stringify(sent.messages)
      expect(userText).toContain('+three')
      expect(userText).toContain('tracked.txt')
      expect(userText).toContain('Chinese')
      // Generation must not have staged or committed anything.
      expect(git(repoDir, 'status', '--porcelain=v1')).toContain(' M tracked.txt')
    } finally {
      provider.server.stop(true)
    }
  })

  it('generates a commit message from the staged source only', async () => {
    const repoDir = await createRepo()
    await fs.writeFile(path.join(repoDir, 'other.txt'), 'unstaged noise\n')
    git(repoDir, 'add', 'tracked.txt')
    const { sessionId } = await sessionService.createSession(repoDir)
    const provider = await startProvider('feat(review): add third line to tracked file')
    try {
      const res = await call('POST', '/ai-generate', sessionId, {
        kind: 'commit-message',
        source: { kind: 'staged' },
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { state: string; text: string; totalFiles: number }
      expect(body.state).toBe('ok')
      expect(body.text).toBe('feat(review): add third line to tracked file')
      expect(body.totalFiles).toBe(1)

      const userText = JSON.stringify(provider.requests[0]!.messages)
      expect(userText).toContain('+three')
      expect(userText).not.toContain('unstaged noise')
      expect(JSON.stringify(provider.requests[0]!.system)).toContain('Conventional')
    } finally {
      provider.server.stop(true)
    }
  })

  it('answers no_changes without calling the provider when the source is clean', async () => {
    const repoDir = await createRepo()
    git(repoDir, 'checkout', '--', 'tracked.txt')
    const { sessionId } = await sessionService.createSession(repoDir)
    const provider = await startProvider('unused')
    try {
      const res = await call('POST', '/ai-generate', sessionId, {
        kind: 'review',
        source: { kind: 'unstaged' },
      })
      expect(res.status).toBe(200)
      expect((await res.json() as { state: string }).state).toBe('no_changes')
      expect(provider.requests).toHaveLength(0)
    } finally {
      provider.server.stop(true)
    }
  })

  it('answers 409 no_provider when no provider is saved', async () => {
    const repoDir = await createRepo()
    const { sessionId } = await sessionService.createSession(repoDir)
    const res = await call('POST', '/ai-generate', sessionId, {
      kind: 'commit-message',
      source: { kind: 'staged' },
    })
    // Nothing staged and no provider: the clean-source answer wins, still no model call.
    expect(res.status).toBe(200)
    expect((await res.json() as { state: string }).state).toBe('no_changes')

    git(repoDir, 'add', 'tracked.txt')
    const withChanges = await call('POST', '/ai-generate', sessionId, {
      kind: 'commit-message',
      source: { kind: 'staged' },
    })
    expect(withChanges.status).toBe(409)
    expect((await withChanges.json() as { state: string }).state).toBe('no_provider')
  })

  it('maps an upstream auth failure to 502 provider_error', async () => {
    const repoDir = await createRepo()
    const { sessionId } = await sessionService.createSession(repoDir)
    const provider = await startProvider(() =>
      Response.json({ error: 'invalid key' }, { status: 401 }),
    )
    try {
      const res = await call('POST', '/ai-generate', sessionId, {
        kind: 'review',
        source: { kind: 'unstaged' },
      })
      expect(res.status).toBe(502)
      const body = await res.json() as { state: string; reason: string }
      expect(body.state).toBe('provider_error')
      expect(body.reason).toBe('auth')
    } finally {
      provider.server.stop(true)
    }
  })

  it('marks the prompt truncated when a diff exceeds the budget', async () => {
    const repoDir = await createRepo()
    const bigLine = 'x'.repeat(300)
    const lines = Array.from({ length: 600 }, (_, index) => `${bigLine}${index}`)
    await fs.writeFile(path.join(repoDir, 'tracked.txt'), `one\ntwo\n${lines.join('\n')}\n`)
    const { sessionId } = await sessionService.createSession(repoDir)
    const provider = await startProvider('review of a huge diff')
    try {
      const res = await call('POST', '/ai-generate', sessionId, {
        kind: 'review',
        source: { kind: 'unstaged' },
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { state: string; truncated: boolean }
      expect(body.state).toBe('ok')
      expect(body.truncated).toBe(true)
      const userText = JSON.stringify(provider.requests[0]!.messages)
      expect(userText).toContain('diff truncated')
      expect(userText.length).toBeLessThan(200_000)
    } finally {
      provider.server.stop(true)
    }
  })

  it('maps rate-limit and timeout provider failures to 429 and 504', async () => {
    const repoDir = await createRepo()
    const { sessionId } = await sessionService.createSession(repoDir)
    const limited = await startProvider(() => Response.json({ error: 'slow down' }, { status: 429 }))
    try {
      const res = await call('POST', '/ai-generate', sessionId, {
        kind: 'review', source: { kind: 'unstaged' },
      })
      expect(res.status).toBe(429)
      expect((await res.json() as { reason: string }).reason).toBe('rate-limit')
    } finally {
      limited.server.stop(true)
    }

    // Accept the request but never answer, then abort the caller's signal
    // shortly after: a caller abort must end the call as 499 `aborted`,
    // never hang.
    const stalled = await startProvider(() => new Promise<Response>(() => {}))
    try {
      const target = `${BASE}/api/sessions/${sessionId}/review/ai-generate`
      const url = new URL(target)
      const req = new Request(target, {
        method: 'POST',
        body: JSON.stringify({ kind: 'review', source: { kind: 'unstaged' } }),
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(300),
      })
      const res = await handleSessionsApi(req, url, url.pathname.split('/').filter(Boolean))
      expect(res.status).toBe(499)
      const body = await res.json() as { state: string; reason: string }
      expect(body.state).toBe('provider_error')
      expect(body.reason).toBe('aborted')
    } finally {
      stalled.server.stop(true)
    }
  })

  it('answers 500 with the git error when the workdir disappears', async () => {
    const repoDir = await createRepo()
    const { sessionId } = await sessionService.createSession(repoDir)
    const provider = await startProvider('unused')
    try {
      await fs.rm(repoDir, { recursive: true, force: true })
      const res = await call('POST', '/ai-generate', sessionId, {
        kind: 'review', source: { kind: 'unstaged' },
      })
      expect(res.status).toBe(500)
      const body = await res.json() as { state: string; error: string }
      expect(body.state).toBe('error')
      expect(body.error.length).toBeGreaterThan(0)
      expect(provider.requests).toHaveLength(0)
    } finally {
      provider.server.stop(true)
    }
  })

  it('rejects malformed bodies and field types', async () => {
    const repoDir = await createRepo()
    const { sessionId } = await sessionService.createSession(repoDir)

    const target = `${BASE}/api/sessions/${sessionId}/review/ai-generate`
    const url = new URL(target)
    const broken = new Request(target, { method: 'POST', body: '{not json' })
    expect((await handleSessionsApi(broken, url, url.pathname.split('/').filter(Boolean))).status).toBe(400)

    const arrayBody = new Request(target, {
      method: 'POST',
      body: '[]',
      headers: { 'content-type': 'application/json' },
    })
    expect((await handleSessionsApi(arrayBody, url, url.pathname.split('/').filter(Boolean))).status).toBe(400)

    expect((await call('POST', '/ai-generate', sessionId, {
      kind: 'review', source: { kind: 'unstaged' }, language: 7,
    })).status).toBe(400)
  })

  it('validates kind and source and refuses the turn source', async () => {
    const repoDir = await createRepo()
    const { sessionId } = await sessionService.createSession(repoDir)

    expect((await call('GET', '/ai-generate', sessionId)).status).toBe(405)
    expect((await call('POST', '/ai-generate', sessionId, {
      kind: 'summary', source: { kind: 'unstaged' },
    })).status).toBe(400)
    expect((await call('POST', '/ai-generate', sessionId, {
      kind: 'review', source: { kind: 'turn', turnKey: 'turn-1' },
    })).status).toBe(400)
    expect((await call('POST', '/ai-generate', sessionId, {
      kind: 'review',
    })).status).toBe(400)
    expect((await call('POST', '/ai-generate', sessionId, {
      kind: 'review', source: { kind: 'unstaged' }, providerId: 42,
    })).status).toBe(400)
  })

  it('falls back to the active provider when the requested id no longer exists', async () => {
    const repoDir = await createRepo()
    const { sessionId } = await sessionService.createSession(repoDir)
    const provider = await startProvider('fallback review')
    try {
      const res = await call('POST', '/ai-generate', sessionId, {
        kind: 'review',
        source: { kind: 'unstaged' },
        providerId: 'deleted-provider',
      })
      expect(res.status).toBe(200)
      expect((await res.json() as { state: string }).state).toBe('ok')
      expect(provider.requests).toHaveLength(1)
    } finally {
      provider.server.stop(true)
    }
  })
})