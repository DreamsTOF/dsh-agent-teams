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
import { createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
/** Follow-up text that makes the model answer briefly without calling tools. */
export const CACHE_KEEPALIVE_PROMPT = 'Reply OK';
const defaultClock = {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        try {
            timer.unref?.();
        }
        catch { /* not fatal */ }
        return timer;
    },
    clearTimeout: handle => clearTimeout(handle),
};
export class CacheKeepalive {
    #ctx;
    #clock;
    #intervalMs;
    #shouldRenew;
    #series = new Map();
    #disposed = false;
    #disposeListener;
    constructor(ctx, options) {
        this.#ctx = ctx;
        this.#intervalMs = options.intervalMs;
        this.#shouldRenew = options.shouldRenew;
        this.#clock = options.clock ?? defaultClock;
    }
    /** Whether keep-alive is active (interval > 0 and not disposed). */
    get enabled() {
        return this.#intervalMs > 0 && !this.#disposed;
    }
    /** Install the `llm/stream` capture listener; returns its disposer. */
    install() {
        if (!this.enabled || typeof this.#ctx.on !== 'function')
            return () => undefined;
        const dispose = this.#ctx.on('llm/stream', (request, next) => {
            try {
                this.#capture(request);
            }
            catch { /* never break a real request */ }
            return next();
        });
        this.#disposeListener = typeof dispose === 'function' ? dispose : undefined;
        return () => { this.#disposeListener?.(); this.#disposeListener = undefined; };
    }
    /** Start (or refresh) keep-alive for one agent. No-op when disabled. */
    track(agent, target) {
        if (!this.enabled)
            return;
        const existing = this.#series.get(agent.id);
        if (existing !== undefined) {
            existing.target = target;
            return;
        }
        this.#series.set(agent.id, { agent, target, stopped: false });
    }
    /** Stop keep-alive for one agent. */
    untrack(agentId) {
        const series = this.#series.get(agentId);
        if (series === undefined)
            return;
        this.#stop(series);
        this.#series.delete(agentId);
    }
    /** Stop everything and remove the listener. */
    dispose() {
        this.#disposed = true;
        for (const series of this.#series.values())
            this.#stop(series);
        this.#series.clear();
        this.#disposeListener?.();
        this.#disposeListener = undefined;
    }
    #stop(series) {
        series.stopped = true;
        if (series.timer !== undefined) {
            this.#clock.clearTimeout(series.timer);
            series.timer = undefined;
        }
    }
    #capture(request) {
        if (!this.enabled || typeof request !== 'object' || request === null)
            return;
        const record = request;
        if (record['purpose'] !== undefined)
            return;
        if (!isAgentLoopRequest(request))
            return;
        const sessionId = record['sessionId'];
        if (typeof sessionId !== 'string' || sessionId === '')
            return;
        const agent = this.#ctx.agents?.get(sessionId);
        if (agent === undefined || agent === null)
            return;
        const series = this.#series.get(agent.id);
        if (series === undefined || series.stopped)
            return;
        const { signal, ...rest } = record;
        void signal;
        let snapshot;
        try {
            snapshot = structuredClone(rest);
        }
        catch {
            snapshot = rest;
        }
        series.input = snapshot;
        this.#arm(series);
    }
    #arm(series) {
        if (series.timer !== undefined)
            this.#clock.clearTimeout(series.timer);
        series.timer = this.#clock.setTimeout(() => {
            series.timer = undefined;
            void this.#ping(series);
        }, this.#intervalMs);
    }
    async #ping(series) {
        try {
            if (this.#disposed || series.stopped)
                return;
            const renew = await this.#shouldRenew(series.target);
            if (!renew || this.#series.get(series.agent.id) !== series) {
                this.untrack(series.agent.id);
                return;
            }
            const input = series.input;
            const stream = this.#ctx.llm?.stream;
            if (input === undefined || typeof stream !== 'function')
                return;
            const messages = Array.isArray(input['messages']) ? input['messages'] : [];
            const replay = {
                ...structuredClone(input),
                maxTokens: 1,
                messages: [
                    ...structuredClone(messages),
                    createUserMessage({ content: [{ type: 'text', text: CACHE_KEEPALIVE_PROMPT }], source: { kind: 'user' } }),
                ],
            };
            let ok = false;
            for await (const chunk of this.#ctx.llm.stream(replay)) {
                if (chunk?.type === 'finish')
                    ok = ['stop', 'max-tokens', 'tool-calls'].includes(chunk.reason?.kind ?? '');
            }
            if (this.#disposed || series.stopped)
                return;
            if (!ok) {
                this.untrack(series.agent.id);
                return;
            }
            this.#arm(series);
        }
        catch {
            this.untrack(series.agent.id);
        }
    }
}
