/**
 * Route-level regression for the SCM write endpoints:
 * `POST /review/commit`, `POST /review/push`, `POST /review/sync`,
 * `GET /review/sync-state`.
 *
 * Throwaway git repositories and a local bare "remote" — no network beyond
 * loopback-free file transport, no real user state.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleSessionsApi } from '../api/sessions.js'
import { sessionService } from '../services/sessionService.js'

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
  git(repoDir, 'config', 'user.email', 'review-commit@example.com')
  git(repoDir, 'config', 'user.name', 'Review Commit')
  git(repoDir, 'checkout', '-q', '-b', 'main')
  await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'one\ntwo\n')
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', 'initial')
  return repoDir
}

/** A bare repository on disk playing the remote, already wired as origin. */
async function addRemote(repoDir: string): Promise<string> {
  const remoteDir = path.join(tmpDir, `remote-${Math.random().toString(36).slice(2)}.git`)
  git(tmpDir, 'init', '--bare', remoteDir)
  git(repoDir, 'remote', 'add', 'origin', remoteDir)
  return remoteDir
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
  return handleSessionsApi(req, url, url.pathname.split('/').filter(Boolean))
}

async function snapshotOf(sessionId: string): Promise<string> {
  const res = await call('GET', '?source=uncommitted', sessionId)
  return (await res.json() as { snapshot: string }).snapshot
}

beforeEach(async () => {
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-commit-api-'))
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

describe('review commit route', () => {
  it('commits exactly the staged content and returns the refreshed status', async () => {
    const repoDir = await createRepo()
    await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'one\ntwo\nthree\n')
    await fs.writeFile(path.join(repoDir, 'other.txt'), 'stays unstaged\n')
    git(repoDir, 'add', 'tracked.txt')
    const { sessionId } = await sessionService.createSession(repoDir)
    const snapshot = await snapshotOf(sessionId)

    const res = await call('POST', '/commit', sessionId, {
      message: 'feat(review): add third line',
      snapshot,
      source: { kind: 'uncommitted' },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { state: string; commit?: string; status?: { files: Array<{ path: string }> } }
    expect(body.state).toBe('ok')
    expect(body.commit).toBe(git(repoDir, 'rev-parse', 'HEAD').trim())
    expect(git(repoDir, 'log', '-1', '--format=%s').trim()).toBe('feat(review): add third line')
    // Only the staged file was committed; the unstaged one is still a change.
    expect(git(repoDir, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('tracked.txt')
    expect(body.status?.files.map((file) => file.path)).toEqual(['other.txt'])
  })

  it('reports nothing_to_commit without creating a commit when the index is empty', async () => {
    const repoDir = await createRepo()
    await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'one\ntwo\nedit\n')
    const { sessionId } = await sessionService.createSession(repoDir)
    const before = git(repoDir, 'rev-parse', 'HEAD')

    const res = await call('POST', '/commit', sessionId, {
      message: 'should not land',
      snapshot: await snapshotOf(sessionId),
    })
    expect(res.status).toBe(200)
    expect((await res.json() as { outcome: string }).outcome).toBe('nothing_to_commit')
    expect(git(repoDir, 'rev-parse', 'HEAD')).toBe(before)
  })

  it('amends HEAD with the staged content and the new message', async () => {
    const repoDir = await createRepo()
    await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'one\ntwo\nthree\n')
    git(repoDir, 'add', 'tracked.txt')
    const { sessionId } = await sessionService.createSession(repoDir)

    const res = await call('POST', '/commit', sessionId, {
      message: 'initial (amended)',
      amend: true,
      snapshot: await snapshotOf(sessionId),
    })
    expect(res.status).toBe(200)
    expect((await res.json() as { state: string }).state).toBe('ok')
    expect(git(repoDir, 'log', '-1', '--format=%s').trim()).toBe('initial (amended)')
    expect(git(repoDir, 'rev-list', '--count', 'HEAD').trim()).toBe('1')
    expect(git(repoDir, 'status', '--porcelain=v1').trim()).toBe('')
  })

  it('refuses a write against a stale snapshot without committing', async () => {
    const repoDir = await createRepo()
    await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'one\ntwo\nthree\n')
    git(repoDir, 'add', 'tracked.txt')
    const { sessionId } = await sessionService.createSession(repoDir)
    const stale = await snapshotOf(sessionId)
    // The working tree moves after the panel read it.
    await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'one\ntwo\nthree\nfour\n')

    const res = await call('POST', '/commit', sessionId, { message: 'nope', snapshot: stale })
    expect((await res.json() as { state: string }).state).toBe('stale')
    expect(git(repoDir, 'log', '-1', '--format=%s').trim()).toBe('initial')
  })

  it('kills the git commit when the caller aborts a slow hook and reports the cancellation', async () => {
    const repoDir = await createRepo()
    // A pre-commit hook that sleeps simulates slow hooks: the abort must kill
    // the git process instead of letting the commit land unobserved.
    const hookPath = path.join(repoDir, '.git', 'hooks', 'pre-commit')
    await fs.writeFile(hookPath, '#!/bin/sh\nsleep 5\n', { mode: 0o755 })
    await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'one\ntwo\nthree\n')
    git(repoDir, 'add', 'tracked.txt')
    const { sessionId } = await sessionService.createSession(repoDir)
    const snapshot = await snapshotOf(sessionId)

    const controller = new AbortController()
    const target = `${BASE}/api/sessions/${sessionId}/review/commit`
    const url = new URL(target)
    const pending = handleSessionsApi(new Request(target, {
      method: 'POST',
      body: JSON.stringify({ message: 'should be cancelled', snapshot }),
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
    }), url, url.pathname.split('/').filter(Boolean))
    // Abort once the request is in flight (the hook holds git for 5s).
    setTimeout(() => controller.abort(), 300)
    const res = await pending
    const body = await res.json() as { state: string; error?: string }
    expect(body.state).toBe('error')
    expect(body.error).toBe('Commit cancelled')
    // The kill landed while the hook was still sleeping: nothing committed.
    expect(git(repoDir, 'log', '-1', '--format=%s').trim()).toBe('initial')
    // The index is intact, so the user can retry the commit.
    expect(git(repoDir, 'diff', '--cached', '--name-only').trim()).toBe('tracked.txt')
  }, 15_000)

  it('refuses to commit unmerged paths', async () => {
    const repoDir = await createRepo()
    git(repoDir, 'checkout', '-q', '-b', 'side')
    await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'side content\n')
    git(repoDir, 'commit', '-am', 'side change')
    git(repoDir, 'checkout', '-q', 'main')
    await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'main content\n')
    git(repoDir, 'commit', '-am', 'main change')
    try {
      git(repoDir, 'merge', 'side')
    } catch {
      // Expected: the merge conflicts and leaves unmerged paths behind.
    }
    const { sessionId } = await sessionService.createSession(repoDir)

    const res = await call('POST', '/commit', sessionId, {
      message: 'should not land',
      snapshot: await snapshotOf(sessionId),
    })
    const body = await res.json() as { state: string; outcome: string }
    expect(body.state).toBe('error')
    expect(body.outcome).toBe('conflicted')
  })

  it('validates the body: message, snapshot, amend and read-only sources', async () => {
    const repoDir = await createRepo()
    const { sessionId } = await sessionService.createSession(repoDir)
    const snapshot = await snapshotOf(sessionId)

    expect((await call('GET', '/commit', sessionId)).status).toBe(405)
    expect((await call('POST', '/commit', sessionId, { snapshot })).status).toBe(400)
    expect((await call('POST', '/commit', sessionId, { message: '  ', snapshot })).status).toBe(400)
    expect((await call('POST', '/commit', sessionId, { message: 'x' })).status).toBe(400)
    expect((await call('POST', '/commit', sessionId, { message: 'x', snapshot, amend: 'yes' })).status).toBe(400)
    expect((await call('POST', '/commit', sessionId, {
      message: 'x', snapshot, source: { kind: 'branch', baseRef: 'main' },
    })).status).toBe(400)
  })
})

describe('review push / sync routes', () => {
  it('publishes the branch to origin and reports the upstream afterwards', async () => {
    const repoDir = await createRepo()
    const remoteDir = await addRemote(repoDir)
    const { sessionId } = await sessionService.createSession(repoDir)

    const initial = await call('GET', '/sync-state', sessionId)
    const initialBody = await initial.json() as { state: string; branch: string; upstream: string | null }
    expect(initialBody.state).toBe('ok')
    expect(initialBody.branch).toBe('main')
    expect(initialBody.upstream).toBeNull()

    const res = await call('POST', '/push', sessionId)
    expect((await res.json() as { state: string }).state).toBe('ok')
    expect(git(remoteDir, 'rev-parse', 'HEAD').trim()).toBe(git(repoDir, 'rev-parse', 'HEAD').trim())

    const after = await call('GET', '/sync-state', sessionId)
    const afterBody = await after.json() as { upstream: string; ahead: number; behind: number }
    expect(afterBody.upstream).toBe('origin/main')
    expect(afterBody.ahead).toBe(0)
    expect(afterBody.behind).toBe(0)
  })

  it('reports ahead and behind counts from the upstream', async () => {
    const repoDir = await createRepo()
    const remoteDir = await addRemote(repoDir)
    git(repoDir, 'push', '-q', '-u', 'origin', 'main')
    const { sessionId } = await sessionService.createSession(repoDir)

    // One local commit ahead.
    await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'one\ntwo\nlocal\n')
    git(repoDir, 'commit', '-am', 'local work')
    // One remote commit behind, pushed from a second clone.
    const cloneDir = path.join(tmpDir, 'clone')
    git(tmpDir, 'clone', '-q', remoteDir, cloneDir)
    git(cloneDir, 'config', 'user.email', 'other@example.com')
    git(cloneDir, 'config', 'user.name', 'Other')
    await fs.writeFile(path.join(cloneDir, 'remote.txt'), 'remote work\n')
    git(cloneDir, 'add', '-A')
    git(cloneDir, 'commit', '-m', 'remote work')
    git(cloneDir, 'push', '-q', 'origin', 'main')
    git(repoDir, 'fetch', '-q', 'origin')

    const res = await call('GET', '/sync-state', sessionId)
    const body = await res.json() as { ahead: number; behind: number }
    expect(body.ahead).toBe(1)
    expect(body.behind).toBe(1)
  })

  it('sync pulls with rebase and pushes the local commit', async () => {
    const repoDir = await createRepo()
    const remoteDir = await addRemote(repoDir)
    git(repoDir, 'push', '-q', '-u', 'origin', 'main')
    const { sessionId } = await sessionService.createSession(repoDir)

    const cloneDir = path.join(tmpDir, 'clone')
    git(tmpDir, 'clone', '-q', remoteDir, cloneDir)
    git(cloneDir, 'config', 'user.email', 'other@example.com')
    git(cloneDir, 'config', 'user.name', 'Other')
    await fs.writeFile(path.join(cloneDir, 'remote.txt'), 'remote work\n')
    git(cloneDir, 'add', '-A')
    git(cloneDir, 'commit', '-m', 'remote work')
    git(cloneDir, 'push', '-q', 'origin', 'main')

    await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'one\ntwo\nlocal\n')
    git(repoDir, 'commit', '-am', 'local work')

    const res = await call('POST', '/sync', sessionId)
    const body = await res.json() as { state: string; pulled: string }
    expect(body.state).toBe('ok')
    expect(body.pulled).toBe('updated')
    // Rebased, not merged: linear history with both commits on the remote.
    expect(git(repoDir, 'log', '--format=%s').trim().split('\n')).toEqual(['local work', 'remote work', 'initial'])
    expect(git(remoteDir, 'rev-parse', 'HEAD').trim()).toBe(git(repoDir, 'rev-parse', 'HEAD').trim())
  })

  it('push without any remote and sync without an upstream are answerable errors', async () => {
    const repoDir = await createRepo()
    const { sessionId } = await sessionService.createSession(repoDir)

    const push = await call('POST', '/push', sessionId)
    expect(push.status).toBe(200)
    expect((await push.json() as { state: string }).state).toBe('error')

    const sync = await call('POST', '/sync', sessionId)
    expect((await sync.json() as { state: string }).state).toBe('error')

    expect((await call('GET', '/push', sessionId)).status).toBe(405)
    expect((await call('POST', '/sync-state', sessionId)).status).toBe(405)
  })

  it('answers the not-a-repo state instead of throwing', async () => {
    const plainDir = path.join(tmpDir, 'plain')
    await fs.mkdir(plainDir, { recursive: true })
    const { sessionId } = await sessionService.createSession(plainDir)

    const res = await call('GET', '/sync-state', sessionId)
    expect((await res.json() as { state: string }).state).toBe('not_git_repo')
    const push = await call('POST', '/push', sessionId)
    expect((await push.json() as { state: string }).state).toBe('error')
  })
})