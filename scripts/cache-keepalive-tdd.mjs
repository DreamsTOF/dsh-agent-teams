import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { CacheKeepalive, CACHE_KEEPALIVE_PROMPT } from '../src/cache-keepalive.ts'

const flush = () => new Promise(resolve => setImmediate(resolve))

function fakeClock() {
  let seq = 0
  const timers = new Map()
  return {
    now: () => 0,
    setTimeout(callback, delayMs) { const id = ++seq; timers.set(id, { callback, delayMs }); return id },
    clearTimeout(handle) { timers.delete(handle) },
    pending() { return timers.size },
    fire() { const due = [...timers.entries()]; timers.clear(); for (const [, timer] of due) timer.callback() },
  }
}

function harness(request, options = {}) {
  const agents = new Map()
  const listeners = new Map()
  const sent = []
  const ctx = {
    agents: { get: id => agents.get(id) },
    llm: { async *stream(req) { sent.push(req); yield { type: 'finish', reason: { kind: 'stop' } } } },
    on(event, handler) { listeners.set(event, handler); return () => listeners.delete(event) },
  }
  const clock = fakeClock()
  const manager = new CacheKeepalive(ctx, {
    intervalMs: options.intervalMs ?? 1000,
    shouldRenew: options.shouldRenew ?? (() => true),
    clock,
  })
  const dispose = manager.install()
  const agent = { id: 'sess-1' }
  agents.set('sess-1', agent)
  const capture = () => {
    const listener = listeners.get('llm/stream')
    if (listener === undefined) return
    listener(request, () => (async function* empty() {})())
  }
  return { manager, dispose, clock, sent, agent, capture }
}

function loopRequest() {
  const request = {
    provider: 'p',
    model: 'm',
    sessionId: 'sess-1',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  }
  markAgentLoopRequest(request)
  return request
}

test('interval <= 0 disables keep-alive entirely', async () => {
  const h = harness(loopRequest(), { intervalMs: 0 })
  h.manager.track(h.agent, { kind: 'member', workspace: '/w', teamId: 't', memberName: 'm' })
  h.capture()
  h.clock.fire(); await flush()
  assert.equal(h.sent.length, 0)
})

test('replays the last request with maxTokens 1 and a Reply OK follow-up', async () => {
  const h = harness(loopRequest())
  h.manager.track(h.agent, { kind: 'member', workspace: '/w', teamId: 't', memberName: 'm' })
  h.capture()
  h.clock.fire(); await flush()
  assert.equal(h.sent.length, 1)
  const sent = h.sent[0]
  assert.equal(sent.maxTokens, 1)
  assert.equal(sent.messages.length, 2)
  assert.equal(sent.messages.at(-1).content[0].text, CACHE_KEEPALIVE_PROMPT)
  assert.equal(sent.provider, 'p')
  assert.equal(sent.model, 'm')
  assert.equal(h.clock.pending(), 1, 're-arms after a successful ping')
})

test('ignores requests that are not agent-loop requests', async () => {
  const request = { provider: 'p', model: 'm', sessionId: 'sess-1', messages: [] } // not marked
  const h = harness(request)
  h.manager.track(h.agent, { kind: 'member', workspace: '/w', teamId: 't', memberName: 'm' })
  h.capture()
  h.clock.fire(); await flush()
  assert.equal(h.sent.length, 0)
})

test('stops renewing when the target no longer needs it (completed member)', async () => {
  let renew = true
  const h = harness(loopRequest(), { shouldRenew: () => renew })
  h.manager.track(h.agent, { kind: 'member', workspace: '/w', teamId: 't', memberName: 'm' })
  h.capture()
  renew = false
  h.clock.fire(); await flush()
  assert.equal(h.sent.length, 0, 'no ping once the member is done')
  assert.equal(h.clock.pending(), 0, 'timer cleared')
  h.capture(); h.clock.fire(); await flush()
  assert.equal(h.sent.length, 0, 'untracked target is not captured again')
})

test('untrack and dispose stop pings', async () => {
  const h = harness(loopRequest())
  h.manager.track(h.agent, { kind: 'captain', workspace: '/w', teamId: 't' })
  h.capture()
  h.manager.untrack('sess-1')
  h.clock.fire(); await flush()
  assert.equal(h.sent.length, 0)

  const h2 = harness(loopRequest())
  h2.manager.track(h2.agent, { kind: 'captain', workspace: '/w', teamId: 't' })
  h2.capture()
  h2.manager.dispose()
  h2.clock.fire(); await flush()
  h2.capture(); h2.clock.fire(); await flush()
  assert.equal(h2.sent.length, 0)
})
