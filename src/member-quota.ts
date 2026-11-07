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

import { join } from 'node:path'
import type { TeamMember, TeamState } from './types.ts'

/** The four disjoint token buckets a member session accumulates. */
export interface TokenBucketUsage {
  uncachedInputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** Minimal shape of `ctx.sessionProjections` needed to read a session's usage. */
export interface SessionTokenUsageSource {
  sessionProjections?: {
    snapshot(session: unknown): {
      values?: { tokenUsage?: TokenBucketUsage | null }
    }
  }
}

/** Which quota independently triggered exhaustion. */
export type QuotaTrigger = 'maxTasks' | 'maxContextTokens'

/** Structured evidence behind a quota verdict. */
export interface QuotaEvaluationDetails {
  /** Completed tasks attributed to the member (failed/cancelled excluded). */
  completedTasks: number
  /** Completed-task limit, or `null` when unlimited. */
  maxTasks: number | null
  /** Cumulative token usage supplied to the evaluation. */
  tokens: number
  /** Token budget, or `null` when unlimited. */
  maxContextTokens: number | null
  /** Every quota that has been reached, in stable order. */
  triggers: QuotaTrigger[]
}

/** Result of evaluating one member against its quotas. */
export interface QuotaEvaluation {
  exhausted: boolean
  /** Human-readable reason when exhausted, otherwise omitted. */
  reason?: string
  details: QuotaEvaluationDetails
}

/**
 * Count the tasks a member actually completed.
 *
 * Only `assignee === name && status === 'completed'` counts; failed, cancelled,
 * claimed, in-progress and other members' tasks never consume the quota.
 */
export function completedTaskCount(team: TeamState, name: string): number {
  return (team.tasks ?? []).filter(task => task.assignee === name && task.status === 'completed').length
}

/**
 * Sum a member session's cumulative provider usage across the four buckets.
 *
 * Reads `ctx.sessionProjections.snapshot(session).values.tokenUsage`, the
 * durable log-derived projection (not the current context-window occupancy).
 * A missing projection or bucket reads as zero so legacy or unspawned members
 * are never counted as over budget.
 */
export function memberTokenUsage(ctx: SessionTokenUsageSource, session: unknown): number {
  const usage = ctx.sessionProjections?.snapshot(session)?.values?.tokenUsage
  if (usage === undefined || usage === null) return 0
  return (usage.uncachedInputTokens ?? 0)
    + (usage.outputTokens ?? 0)
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0)
}

/** Normalize a configured quota: absent, non-finite, or `0` means unlimited. */
function quotaLimit(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Evaluate a member against `maxTasks` and `maxContextTokens`.
 *
 * Both quotas are independent and either one reaching its limit exhausts the
 * member. `0` (or an absent field, as in old `team.json` records) means that
 * particular quota is unlimited. A member is exhausted as soon as the
 * completed-task count or the cumulative token usage reaches its limit.
 */
export function evaluateQuota(
  member: Pick<TeamMember, 'name' | 'maxTasks' | 'maxContextTokens'>,
  team: TeamState,
  tokens: number,
): QuotaEvaluation {
  const completedTasks = completedTaskCount(team, member.name)
  const maxTasks = quotaLimit(member.maxTasks)
  const maxContextTokens = quotaLimit(member.maxContextTokens)
  const triggers: QuotaTrigger[] = []
  if (maxTasks !== null && completedTasks >= maxTasks) triggers.push('maxTasks')
  if (maxContextTokens !== null && tokens >= maxContextTokens) triggers.push('maxContextTokens')
  const exhausted = triggers.length > 0
  const reason = exhausted
    ? triggers.map((trigger) => (trigger === 'maxTasks'
      ? `completed ${completedTasks} task(s) reached maxTasks ${maxTasks}`
      : `used ${tokens} token(s) reached maxContextTokens ${maxContextTokens}`)).join('; ')
    : undefined
  return { exhausted, reason, details: { completedTasks, maxTasks, tokens, maxContextTokens, triggers } }
}

/** Absolute path of the member's handover document inside the team directory. */
export function handoverPath(workspace: string, stateDir: string, teamId: string, member: string): string {
  return join(workspace, stateDir, teamId, 'handover', `${member}.md`)
}

/** Fixed-section handover document skeleton for one member. */
export function handoverTemplate(member: string): string {
  return [
    `# Handover: ${member}`,
    '',
    '## 当前任务与状态',
    '',
    '## 已完成工作',
    '',
    '## 改动文件',
    '',
    '## 未完成项与风险',
    '',
    '## 建议接手步骤',
    '',
    '## 关键命令与验证结果',
    '',
  ].join('\n')
}

/** Optional context for {@link buildHandoverPrompt}. */
export interface HandoverPromptContext {
  /** Member name written into the title and default path. */
  member?: string
  /** Exact output path; defaults to a placeholder handover path. */
  path?: string
}

/**
 * Build the message a quota-exhausted member receives: load the `handoff`
 * skill, write the fixed-section document to the exact path, then report the
 * path and a short summary to the captain.
 */
export function buildHandoverPrompt(context: HandoverPromptContext = {}): string {
  const member = context.member ?? '<member>'
  const path = context.path ?? handoverPath('<workspace>', '<stateDir>', '<teamId>', member)
  return [
    'Your member quota is exhausted, so you will not receive new tasks.',
    'Write a handover document so another member can continue your work.',
    '',
    '1. Load the `handoff` skill (it is always available to members).',
    `2. Write the document to this exact path: ${path}`,
    '3. Use this fixed structure:',
    '',
    handoverTemplate(member),
    '',
    'When the file is written, send the captain a message with the path and a 3-line summary.',
  ].join('\n')
}
