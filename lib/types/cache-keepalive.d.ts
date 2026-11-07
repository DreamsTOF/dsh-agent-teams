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
import type { Context } from '@deepseek-ai/cordis';
/** Follow-up text that makes the model answer briefly without calling tools. */
export declare const CACHE_KEEPALIVE_PROMPT = "Reply OK";
/** Who a keep-alive series belongs to. */
export interface KeepaliveTarget {
    readonly kind: 'captain' | 'member';
    readonly workspace: string;
    readonly teamId: string;
    readonly memberName?: string;
}
/** Injectable clock so tests can drive intervals deterministically. */
export interface KeepaliveClock {
    now(): number;
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
}
/** Options for {@link CacheKeepalive}. */
export interface CacheKeepaliveOptions {
    /** Ping interval in milliseconds; `<= 0` disables keep-alive entirely. */
    readonly intervalMs: number;
    /** Whether a target still needs its cache kept warm right now (may be async). */
    readonly shouldRenew: (target: KeepaliveTarget) => boolean | Promise<boolean>;
    /** Optional clock override (tests). */
    readonly clock?: KeepaliveClock;
}
interface AgentLike {
    readonly id: string;
}
export declare class CacheKeepalive {
    #private;
    constructor(ctx: Context, options: CacheKeepaliveOptions);
    /** Whether keep-alive is active (interval > 0 and not disposed). */
    get enabled(): boolean;
    /** Install the `llm/stream` capture listener; returns its disposer. */
    install(): () => void;
    /** Start (or refresh) keep-alive for one agent. No-op when disabled. */
    track(agent: AgentLike, target: KeepaliveTarget): void;
    /** Stop keep-alive for one agent. */
    untrack(agentId: string): void;
    /** Stop everything and remove the listener. */
    dispose(): void;
}
export {};
