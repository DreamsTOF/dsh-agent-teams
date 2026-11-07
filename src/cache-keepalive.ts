/**
 * Minimal provider prompt-cache keep-alive for team sessions.
 *
 * A member or captain that still has future work may sit idle while it waits
 * for teammates, so it makes no model requests and the provider's prompt cache
 * can expire — the next real turn then re-bills the whole prefix. This mirrors
 * the approach used by `dsh-model-fusion`: capture each tracked agent's most
 * recent agent-loop request, and every interval replay it with a tiny
 * "Reply OK" follow-up and `maxTokens: 1`, draining the stream so the prefix is
 * re-read from cache and its TTL refreshed. Output is never persisted or
 * executed. Finished/removed members are not renewed.
 * @module dsh-agent-teams/cache-keepalive
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'

/** Follow-up text that makes the model answer briefly without calling tools. */
export const CACHE_KEEPALIVE_PROMPT = 'Reply OK'

/** Who a keep-alive series belongs to. */
export interface KeepaliveTarget {
  readonly kind: 'captain' | 'member'
  readonly workspace: string
  readonly teamId: string
  readonly memberName?: string
}

/** Injectable clock so tests can drive intervals deterministically. */
export interface KeepaliveClock {
  now(): number
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

/** Options for {@link CacheKeepalive}. */
export interface CacheKeepaliveOptions {
  /** Ping interval in milliseconds; `<= 0` disables keep-alive entirely. */
  readonly intervalMs: number
  /** Whether a target still needs its cache kept warm right now (may be async). */
  readonly shouldRenew: (target: KeepaliveTarget) => boolean | Promise<boolean>
  /** Optional clock override (tests). */
  readonly clock?: KeepaliveClock
}

interface AgentLike {
  readonly id: string
}

interface Series {
  readonly agent: AgentLike
  target: KeepaliveTarget
  input?: Record<string, unknown>
  timer?: unknown
  stopped: boolean
}

interface KeepaliveCtx {
  readonly agents?: { get(id: string): unknown }
  readonly llm?: { stream(options: unknown): AsyncIterable<{ type?: string; reason?: { kind?: string } }> }
  on?(event: string, handler: (request: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>): () => void
}

const defaultClock: KeepaliveClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs)
    try { (timer as unknown as { unref?: () => void }).unref?.() } catch { /* not fatal */ }
    return timer
  },
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export class CacheKeepalive {
  readonly #ctx: KeepaliveCtx
  readonly #clock: KeepaliveClock
  readonly #intervalMs: number
  readonly #shouldRenew: (target: KeepaliveTarget) => boolean | Promise<boolean>
  readonly #series = new Map<string, Series>()
  #disposed = false
  #disposeListener?: () => void

  constructor(ctx: Context, options: CacheKeepaliveOptions) {
    this.#ctx = ctx as unknown as KeepaliveCtx
    this.#intervalMs = options.intervalMs
    this.#shouldRenew = options.shouldRenew
    this.#clock = options.clock ?? defaultClock
  }

  /** Whether keep-alive is active (interval > 0 and not disposed). */
  get enabled(): boolean {
    return this.#intervalMs > 0 && !this.#disposed
  }

  /** Install the `llm/stream` capture listener; returns its disposer. */
  install(): () => void {
    if (!this.enabled || typeof this.#ctx.on !== 'function') return () => undefined
    const dispose = this.#ctx.on('llm/stream', (request, next) => {
      try { this.#capture(request) } catch { /* never break a real request */ }
      return next()
    })
    this.#disposeListener = typeof dispose === 'function' ? dispose : undefined
    return () => { this.#disposeListener?.(); this.#disposeListener = undefined }
  }

  /** Start (or refresh) keep-alive for one agent. No-op when disabled. */
  track(agent: AgentLike, target: KeepaliveTarget): void {
    if (!this.enabled) return
    const existing = this.#series.get(agent.id)
    if (existing !== undefined) { existing.target = target; return }
    this.#series.set(agent.id, { agent, target, stopped: false })
  }

  /** Stop keep-alive for one agent. */
  untrack(agentId: string): void {
    const series = this.#series.get(agentId)
    if (series === undefined) return
    this.#stop(series)
    this.#series.delete(agentId)
  }

  /** Stop everything and remove the listener. */
  dispose(): void {
    this.#disposed = true
    for (const series of this.#series.values()) this.#stop(series)
    this.#series.clear()
    this.#disposeListener?.()
    this.#disposeListener = undefined
  }

  #stop(series: Series): void {
    series.stopped = true
    if (series.timer !== undefined) {
      this.#clock.clearTimeout(series.timer)
      series.timer = undefined
    }
  }

  #capture(request: unknown): void {
    if (!this.enabled || typeof request !== 'object' || request === null) return
    const record = request as Record<string, unknown>
    if (record['purpose'] !== undefined) return
    if (!isAgentLoopRequest(request as never)) return
    const sessionId = record['sessionId']
    if (typeof sessionId !== 'string' || sessionId === '') return
    const agent = this.#ctx.agents?.get(sessionId) as AgentLike | undefined
    if (agent === undefined || agent === null) return
    const series = this.#series.get(agent.id)
    if (series === undefined || series.stopped) return
    const { signal, ...rest } = record
    void signal
    let snapshot: Record<string, unknown>
    try { snapshot = structuredClone(rest) as Record<string, unknown> } catch { snapshot = rest }
    series.input = snapshot
    this.#arm(series)
  }

  #arm(series: Series): void {
    if (series.timer !== undefined) this.#clock.clearTimeout(series.timer)
    series.timer = this.#clock.setTimeout(() => {
      series.timer = undefined
      void this.#ping(series)
    }, this.#intervalMs)
  }

  async #ping(series: Series): Promise<void> {
    try {
      if (this.#disposed || series.stopped) return
      const renew = await this.#shouldRenew(series.target)
      if (!renew || this.#series.get(series.agent.id) !== series) { this.untrack(series.agent.id); return }
      const input = series.input
      const stream = this.#ctx.llm?.stream
      if (input === undefined || typeof stream !== 'function') return
      const messages = Array.isArray(input['messages']) ? input['messages'] : []
      const replay = {
        ...structuredClone(input),
        maxTokens: 1,
        messages: [
          ...structuredClone(messages),
          createUserMessage({ content: [{ type: 'text', text: CACHE_KEEPALIVE_PROMPT }], source: { kind: 'user' } }),
        ],
      }
      let ok = false
      for await (const chunk of this.#ctx.llm!.stream(replay)) {
        if (chunk?.type === 'finish') ok = ['stop', 'max-tokens', 'tool-calls'].includes(chunk.reason?.kind ?? '')
      }
      if (this.#disposed || series.stopped) return
      if (!ok) { this.untrack(series.agent.id); return }
      this.#arm(series)
    } catch {
      this.untrack(series.agent.id)
    }
  }
}
