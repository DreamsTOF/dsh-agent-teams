/**
 * Member quota and handover helpers for the 0.2.0 team runtime.
 *
 * These are deliberately small pure functions: the tool layer (task claim /
 * reassign / completion) owns persistence and mailbox side effects, while this
 * module only answers "has this member reached a quota?" and produces the
 * fixed handover document/prompt. Keeping the arithmetic and formatting here
 * makes the quota policy unit-testable without a live harness session.
 *
 * @module dsh-agent-teams/member-quota
 */
import type { TeamMember, TeamState } from './types.ts';
/** The four disjoint token buckets a member session accumulates. */
export interface TokenBucketUsage {
    uncachedInputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}
/** Minimal shape of `ctx.sessionProjections` needed to read a session's usage. */
export interface SessionTokenUsageSource {
    sessionProjections?: {
        snapshot(session: unknown): {
            values?: {
                tokenUsage?: TokenBucketUsage | null;
            };
        };
    };
}
/** Which quota independently triggered exhaustion. */
export type QuotaTrigger = 'maxTasks' | 'maxContextTokens';
/** Structured evidence behind a quota verdict. */
export interface QuotaEvaluationDetails {
    /** Completed tasks attributed to the member (failed/cancelled excluded). */
    completedTasks: number;
    /** Completed-task limit, or `null` when unlimited. */
    maxTasks: number | null;
    /** Cumulative token usage supplied to the evaluation. */
    tokens: number;
    /** Token budget, or `null` when unlimited. */
    maxContextTokens: number | null;
    /** Every quota that has been reached, in stable order. */
    triggers: QuotaTrigger[];
}
/** Result of evaluating one member against its quotas. */
export interface QuotaEvaluation {
    exhausted: boolean;
    /** Human-readable reason when exhausted, otherwise omitted. */
    reason?: string;
    details: QuotaEvaluationDetails;
}
/**
 * Count the tasks a member actually completed.
 *
 * Only `assignee === name && status === 'completed'` counts; failed, cancelled,
 * claimed, in-progress and other members' tasks never consume the quota.
 */
export declare function completedTaskCount(team: TeamState, name: string): number;
/**
 * Sum a member session's cumulative provider usage across the four buckets.
 *
 * Reads `ctx.sessionProjections.snapshot(session).values.tokenUsage`, the
 * durable log-derived projection (not the current context-window occupancy).
 * A missing projection or bucket reads as zero so legacy or unspawned members
 * are never counted as over budget.
 */
export declare function memberTokenUsage(ctx: SessionTokenUsageSource, session: unknown): number;
/**
 * Evaluate a member against `maxTasks` and `maxContextTokens`.
 *
 * Both quotas are independent and either one reaching its limit exhausts the
 * member. `0` (or an absent field, as in old `team.json` records) means that
 * particular quota is unlimited. A member is exhausted as soon as the
 * completed-task count or the cumulative token usage reaches its limit.
 */
export declare function evaluateQuota(member: Pick<TeamMember, 'name' | 'maxTasks' | 'maxContextTokens'>, team: TeamState, tokens: number): QuotaEvaluation;
/** Absolute path of the member's handover document inside the team directory. */
export declare function handoverPath(workspace: string, stateDir: string, teamId: string, member: string): string;
/** Fixed-section handover document skeleton for one member. */
export declare function handoverTemplate(member: string): string;
/** Optional context for {@link buildHandoverPrompt}. */
export interface HandoverPromptContext {
    /** Member name written into the title and default path. */
    member?: string;
    /** Exact output path; defaults to a placeholder handover path. */
    path?: string;
}
/**
 * Build the message a quota-exhausted member receives: load the `handoff`
 * skill, write the fixed-section document to the exact path, then report the
 * path and a short summary to the captain.
 */
export declare function buildHandoverPrompt(context?: HandoverPromptContext): string;
