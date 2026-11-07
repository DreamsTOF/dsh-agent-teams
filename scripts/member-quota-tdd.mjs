/**
 * TDD for the member quota / handover helper module.
 *
 * Covers the quota arithmetic (`maxTasks`, `maxContextTokens`, `0` = unlimited,
 * legacy records with no fields), the four-bucket token sum, and the fixed
 * handover path/template/prompt. The helpers are pure, so no live harness
 * session is needed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'

const {
  completedTaskCount,
  memberTokenUsage,
  evaluateQuota,
  handoverPath,
  handoverTemplate,
  buildHandoverPrompt,
  quotaWarningReason,
  markHandoverWritten,
} = await import('../src/member-quota.ts')

const member = (overrides = {}) => ({ name: 'alice', ...overrides })
const task = (overrides = {}) => ({ id: 't1', subject: 'work', status: 'pending', dependencies: [], ...overrides })
const team = (tasks = [], overrides = {}) => ({
  id: 'team',
  name: 'Team',
  captainSessionId: 'captain',
  createdAt: 0,
  taskSeq: 0,
  members: [member()],
  tasks,
  ...overrides,
})

test('completedTaskCount counts only this member\'s completed tasks', () => {
  const tasks = [
    task({ id: 't1', assignee: 'alice', status: 'completed' }),
    task({ id: 't2', assignee: 'alice', status: 'completed' }),
    task({ id: 't3', assignee: 'alice', status: 'failed' }),
    task({ id: 't4', assignee: 'alice', status: 'cancelled' }),
    task({ id: 't5', assignee: 'alice', status: 'in_progress' }),
    task({ id: 't6', assignee: 'bob', status: 'completed' }),
    task({ id: 't7', status: 'completed' }),
  ]
  assert.equal(completedTaskCount(team(tasks), 'alice'), 2)
  assert.equal(completedTaskCount(team(tasks), 'bob'), 1)
  assert.equal(completedTaskCount(team(tasks), 'carol'), 0)
})

test('memberTokenUsage sums the four cumulative buckets', () => {
  const ctx = {
    sessionProjections: {
      snapshot: () => ({
        values: {
          tokenUsage: { uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: 7, cacheWriteTokens: 3 },
        },
      }),
    },
  }
  assert.equal(memberTokenUsage(ctx, {}), 130)
})

test('memberTokenUsage is zero without a usable token projection', () => {
  assert.equal(memberTokenUsage({}, {}), 0)
  assert.equal(memberTokenUsage({ sessionProjections: { snapshot: () => ({ values: {} }) } }, {}), 0)
  assert.equal(memberTokenUsage({ sessionProjections: { snapshot: () => ({ values: { tokenUsage: null } }) } }, {}), 0)
})

test('a zero configured quota means unlimited', () => {
  const completedFive = team([1, 2, 3, 4, 5].map((n) => task({ id: `t${n}`, assignee: 'alice', status: 'completed' })))
  const result = evaluateQuota(member({ maxTasks: 0, maxContextTokens: 0 }), completedFive, 10_000_000_000)
  assert.equal(result.exhausted, false)
  assert.equal(result.reason, undefined)
  assert.equal(result.details.maxTasks, null)
  assert.equal(result.details.maxContextTokens, null)
  assert.deepEqual(result.details.triggers, [])
})

test('maxTasks exhaustion triggers when the completed-task limit is reached', () => {
  const tasks = [1, 2, 3, 4, 5].map((n) => task({ id: `t${n}`, assignee: 'alice', status: 'completed' }))
  const result = evaluateQuota(member({ maxTasks: 5 }), team(tasks), 0)
  assert.equal(result.exhausted, true)
  assert.equal(result.details.completedTasks, 5)
  assert.equal(result.details.maxTasks, 5)
  assert.deepEqual(result.details.triggers, ['maxTasks'])
  assert.match(result.reason, /maxTasks/)
})

test('maxTasks stays below the limit and ignores failed/cancelled work', () => {
  const tasks = [
    task({ id: 't1', assignee: 'alice', status: 'completed' }),
    task({ id: 't2', assignee: 'alice', status: 'failed' }),
    task({ id: 't3', assignee: 'alice', status: 'cancelled' }),
  ]
  const result = evaluateQuota(member({ maxTasks: 5 }), team(tasks), 0)
  assert.equal(result.exhausted, false)
  assert.equal(result.details.completedTasks, 1)
})

test('maxContextTokens exhaustion triggers on the cumulative token budget', () => {
  const result = evaluateQuota(member({ maxContextTokens: 200_000_000 }), team([]), 200_000_000)
  assert.equal(result.exhausted, true)
  assert.deepEqual(result.details.triggers, ['maxContextTokens'])
  assert.match(result.reason, /maxContextTokens/)
})

test('either quota independently exhausts the member', () => {
  const completedOnce = team([task({ assignee: 'alice', status: 'completed' })])
  const both = evaluateQuota(member({ maxTasks: 1, maxContextTokens: 10 }), completedOnce, 10)
  assert.equal(both.exhausted, true)
  assert.deepEqual(both.details.triggers, ['maxTasks', 'maxContextTokens'])
  const tasksOnly = evaluateQuota(member({ maxTasks: 1, maxContextTokens: 10 }), completedOnce, 9)
  assert.deepEqual(tasksOnly.details.triggers, ['maxTasks'])
  const tokensOnly = evaluateQuota(member({ maxTasks: 5, maxContextTokens: 10 }), team([]), 10)
  assert.deepEqual(tokensOnly.details.triggers, ['maxContextTokens'])
})

test('legacy members without quota fields are unlimited', () => {
  const tasks = [1, 2, 3, 4, 5, 6, 7].map((n) => task({ id: `t${n}`, assignee: 'alice', status: 'completed' }))
  const result = evaluateQuota(member(), team(tasks), 999_999_999_999)
  assert.equal(result.exhausted, false)
  assert.equal(result.details.maxTasks, null)
  assert.equal(result.details.maxContextTokens, null)
})

test('handoverPath points at <stateDir>/<teamId>/handover/<member>.md', () => {
  const path = handoverPath('D:/ws', '.agent-teams', 'team-1', 'alice')
  assert.equal(path, join('D:/ws', '.agent-teams', 'team-1', 'handover', 'alice.md'))
  assert.ok(path.endsWith(join('handover', 'alice.md')))
})

test('handoverTemplate has every fixed section', () => {
  const template = handoverTemplate('alice')
  assert.match(template, /^# Handover: alice/m)
  for (const heading of ['当前任务与状态', '已完成工作', '改动文件', '未完成项与风险', '建议接手步骤', '关键命令与验证结果']) {
    assert.ok(template.includes(`## ${heading}`), `missing section ${heading}`)
  }
})

test('buildHandoverPrompt carries the exact path and fixed sections', () => {
  const path = handoverPath('D:/ws', '.agent-teams', 'team-1', 'alice')
  const prompt = buildHandoverPrompt({ member: 'alice', path })
  assert.ok(prompt.includes(path))
  assert.match(prompt, /handoff/)
  for (const heading of ['当前任务与状态', '已完成工作', '改动文件', '未完成项与风险', '建议接手步骤', '关键命令与验证结果']) {
    assert.ok(prompt.includes(`## ${heading}`), `missing section ${heading}`)
  }
  assert.match(buildHandoverPrompt(), /<workspace>/)
})

test('mid-task token warning fires exactly once and never when the task quota already closes the member', () => {
  const baseTeam = { id: 't', name: 'T', captainSessionId: 'c', createdAt: 0, members: [], tasks: [], taskSeq: 0, memberMaxContextTokens: 1000 }
  const working = { name: 'alice', status: 'working', maxContextTokens: 1000, quotaWarnedAt: undefined }
  assert.ok(quotaWarningReason(working, baseTeam, 1000), 'fires at the budget')
  assert.ok(quotaWarningReason(working, baseTeam, 1500), 'fires above the budget')
  assert.equal(quotaWarningReason({ ...working, quotaWarnedAt: 123 }, baseTeam, 1500), undefined, 'deduped after the first warning')
  assert.equal(quotaWarningReason(working, baseTeam, 999), undefined, 'silent below the budget')

  const exhaustedTeam = {
    ...baseTeam,
    memberMaxTasks: 1,
    tasks: [{ id: 't1', subject: 'done', status: 'completed', assignee: 'alice', dependencies: [], createdAt: 0, updatedAt: 0 }],
  }
  assert.equal(
    quotaWarningReason({ name: 'alice', maxTasks: 1, quotaWarnedAt: undefined }, exhaustedTeam, 999999),
    undefined,
    'a member already at its completed-task quota is handed off on completion instead of pre-warned',
  )
})

test('markHandoverWritten clears the pending flag and records completion without mutating the input', () => {
  const member = { id: 'm', name: 'alice', joinedAt: 0, status: 'exhausted', handoverPending: true }
  const written = markHandoverWritten(member, 123)
  assert.equal(written.handoverPending, undefined, 'pending flag is cleared')
  assert.equal(written.handoverWrittenAt, 123, 'completion timestamp is recorded')
  assert.equal(member.handoverPending, true, 'input record is not mutated')
})
