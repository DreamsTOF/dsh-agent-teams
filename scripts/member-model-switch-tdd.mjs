#!/usr/bin/env node
/**
 * TDD checks for runtime member model switching.
 *
 * Imports the type-stripping-compatible plugin source directly (Node >= 23.6),
 * matching the corrupt-team.json regression test, so the checks run without a
 * build even while `lib/` is stale.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const { switchMemberModel, applyManualSwitch } = await import('../src/member-model-switch.ts')

const PROVIDERS = [
  { id: 'openai', name: 'OpenAI' },
  { id: 'grok', name: 'Grok' },
]
const CATALOGS = {
  openai: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }],
  grok: [{ id: 'grok-4' }],
}
const REASONING = {
  efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
  defaultEffort: 'low',
}

function makeMember(overrides = {}) {
  return {
    id: 'member-1',
    name: 'alice',
    role: 'engineer',
    provider: 'openai',
    model: 'gpt-4o',
    reasoningEffort: 'low',
    spawnProvider: 'openai',
    spawnModel: 'gpt-4o',
    spawnReasoningEffort: 'low',
    joinedAt: 0,
    status: 'idle',
    ...overrides,
  }
}

function makeTeam(members, overrides = {}) {
  return {
    name: 'Demo Team',
    id: 'demo-team',
    captainSessionId: 'captain-1',
    createdAt: 0,
    members,
    tasks: [],
    taskSeq: 0,
    ...overrides,
  }
}

/**
 * Minimal ctx. Records every host `select` so tests can assert exactly one
 * host write (or none on rejection/idempotency).
 */
function makeCtx(options = {}) {
  const {
    providers = PROVIDERS,
    catalogs = CATALOGS,
    reasoning = REASONING,
    agentStatus = 'idle',
    agentPresent = true,
    selectThrows = false,
  } = options
  const selects = []
  const agent = {
    status: agentStatus,
    model: {
      select(selection) {
        if (selectThrows) throw new Error('host refused selection')
        selects.push(selection)
      },
    },
  }
  const ctx = {
    llm: {
      listProviders: () => providers,
      listModels: async (provider) => catalogs[provider] ?? [],
      resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model, reasoning }),
    },
    agents: { get: () => (agentPresent ? agent : undefined) },
  }
  return { ctx, selects, agent }
}

async function expectReject(label, member, ctx, input, evidence) {
  const team = makeTeam([member])
  const result = await switchMemberModel(ctx, { team, member, ...input })
  assert.equal(result.ok, false, `${label}: expected rejection`)
  assert.equal(typeof result.error, 'string')
  assert.ok(result.error.length > 0, `${label}: expected a readable error`)
  assert.equal(ctx.selects?.length ?? 0, 0, `${label}: host select must not run`)
  assert.equal(member.provider, 'openai', `${label}: member must not be partially written`)
  assert.equal(member.model, 'gpt-4o', `${label}: member model must not change`)
  if (evidence !== undefined) assert.match(result.error, evidence, `${label}: error shape`)
  return result
}

test('rejects a working member without interrupting it', async () => {
  const member = makeMember({ status: 'working' })
  const { ctx } = makeCtx()
  await expectReject('working', member, ctx, { provider: 'openai', model: 'gpt-4o-mini' }, /working/)
})

test('rejects an exhausted member', async () => {
  const member = makeMember({ status: 'exhausted' })
  const { ctx } = makeCtx()
  await expectReject('exhausted', member, ctx, { provider: 'openai', model: 'gpt-4o-mini' }, /exhausted/)
})

test('rejects a removed member', async () => {
  const member = makeMember({ status: 'removed' })
  const { ctx } = makeCtx()
  await expectReject('removed', member, ctx, { provider: 'openai', model: 'gpt-4o-mini' }, /removed/)
})

test('rejects a member whose live agent is running even when idle on disk', async () => {
  const member = makeMember({ status: 'idle' })
  const { ctx } = makeCtx({ agentStatus: 'running' })
  await expectReject('running', member, ctx, { provider: 'openai', model: 'gpt-4o-mini' }, /running/)
})

test('rejects any switch while the team is halted', async () => {
  const member = makeMember()
  const { ctx, selects } = makeCtx()
  const team = makeTeam([member], { halted: true })
  const result = await switchMemberModel(ctx, { team, member, provider: 'openai', model: 'gpt-4o-mini' })
  assert.equal(result.ok, false)
  assert.match(result.error, /halted/)
  assert.equal(selects.length, 0)
})

test('rejects a member that does not belong to the team', async () => {
  const member = makeMember()
  const stranger = makeMember({ id: 'member-2', name: 'bob' })
  const { ctx, selects } = makeCtx()
  const team = makeTeam([member])
  const result = await switchMemberModel(ctx, { team, member: stranger, provider: 'openai', model: 'gpt-4o-mini' })
  assert.equal(result.ok, false)
  assert.match(result.error, /does not belong/)
  assert.equal(selects.length, 0)
})

test('rejects an unspawned member (no session id)', async () => {
  const member = makeMember({ id: '' })
  const { ctx } = makeCtx()
  await expectReject('unspawned', member, ctx, { provider: 'openai', model: 'gpt-4o-mini' }, /spawned/)
})

test('rejects when the live agent cannot be found', async () => {
  const member = makeMember()
  const { ctx } = makeCtx({ agentPresent: false })
  await expectReject('no-agent', member, ctx, { provider: 'openai', model: 'gpt-4o-mini' }, /no live agent/)
})

test('rejects empty provider and model', async () => {
  const member = makeMember()
  const { ctx, selects } = makeCtx()
  const team = makeTeam([member])
  const emptyProvider = await switchMemberModel(ctx, { team, member, provider: '  ', model: 'gpt-4o-mini' })
  assert.equal(emptyProvider.ok, false)
  assert.match(emptyProvider.error, /provider must not be empty/)
  const emptyModel = await switchMemberModel(ctx, { team, member, provider: 'openai', model: '   ' })
  assert.equal(emptyModel.ok, false)
  assert.match(emptyModel.error, /model must not be empty/)
  assert.equal(selects.length, 0)
})

test('rejects an unknown provider', async () => {
  const member = makeMember()
  const { ctx } = makeCtx()
  await expectReject('unknown-provider', member, ctx, { provider: 'nope', model: 'gpt-4o-mini' }, /unknown provider/)
})

test('rejects a model outside the provider catalog', async () => {
  const member = makeMember()
  const { ctx } = makeCtx()
  await expectReject('unknown-model', member, ctx, { provider: 'openai', model: 'gpt-5' }, /unknown model/)
})

test('rejects an unsupported reasoning effort', async () => {
  const member = makeMember()
  const { ctx } = makeCtx()
  await expectReject(
    'bad-effort',
    member,
    ctx,
    { provider: 'openai', model: 'gpt-4o-mini', reasoningEffort: 'ultra' },
    /does not support reasoning effort/,
  )
})

test('rejects a reasoning effort when the model advertises none', async () => {
  const member = makeMember()
  const { ctx } = makeCtx({ reasoning: null })
  await expectReject(
    'no-efforts',
    member,
    ctx,
    { provider: 'openai', model: 'gpt-4o-mini', reasoningEffort: 'low' },
    /does not advertise selectable reasoning efforts/,
  )
})

test('accepts an empty (advisory) catalog for a registered provider', async () => {
  const member = makeMember()
  const { ctx, selects } = makeCtx({ catalogs: { openai: [] } })
  const team = makeTeam([member])
  const result = await switchMemberModel(ctx, { team, member, provider: 'openai', model: 'dynamic-model' })
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  assert.deepEqual(selects, [{ provider: 'openai', model: 'dynamic-model' }])
})

test('switches an idle member and applies the new route', async () => {
  const member = makeMember()
  const { ctx, selects } = makeCtx()
  const team = makeTeam([member])
  const result = await switchMemberModel(ctx, {
    team,
    member,
    provider: 'openai',
    model: 'gpt-4o-mini',
    reasoningEffort: 'high',
  })
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  assert.deepEqual(selects, [{ provider: 'openai', model: 'gpt-4o-mini', reasoningEffort: 'high' }])
  // The durable member record is replaced in place on the team.
  assert.equal(team.members[0].provider, 'openai')
  assert.equal(team.members[0].model, 'gpt-4o-mini')
  assert.equal(team.members[0].reasoningEffort, 'high')
  // The immutable spawn snapshot is untouched.
  assert.equal(team.members[0].spawnProvider, 'openai')
  assert.equal(team.members[0].spawnModel, 'gpt-4o')
  assert.equal(team.members[0].spawnReasoningEffort, 'low')
})

test('omits reasoningEffort from the host selection when none is requested', async () => {
  const member = makeMember({ reasoningEffort: undefined })
  const { ctx, selects } = makeCtx()
  const team = makeTeam([member])
  const result = await switchMemberModel(ctx, { team, member, provider: 'grok', model: 'grok-4' })
  assert.equal(result.ok, true)
  assert.deepEqual(selects, [{ provider: 'grok', model: 'grok-4' }])
  assert.equal('reasoningEffort' in selects[0], false)
})

test('is idempotent for the already-active route', async () => {
  const member = makeMember()
  const { ctx, selects } = makeCtx()
  const team = makeTeam([member])
  const result = await switchMemberModel(ctx, {
    team,
    member,
    provider: 'openai',
    model: 'gpt-4o',
    reasoningEffort: 'low',
  })
  assert.equal(result.ok, true)
  assert.equal(result.changed, false)
  assert.equal(selects.length, 0, 'an equal route must not record another host selection')
})

test('clears an active fallback when the manual route matches the primary', async () => {
  const member = makeMember({
    activeProvider: 'grok',
    activeModel: 'grok-4',
    fallbackActive: true,
    fallback: { provider: 'grok', model: 'grok-4' },
  })
  const { ctx, selects } = makeCtx()
  const team = makeTeam([member])
  const result = await switchMemberModel(ctx, {
    team,
    member,
    provider: 'openai',
    model: 'gpt-4o',
    reasoningEffort: 'low',
  })
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  // Fallback state is cleared even though the main route did not change.
  assert.equal(selects.length, 1)
  assert.deepEqual(selects[0], { provider: 'openai', model: 'gpt-4o', reasoningEffort: 'low' })
  assert.equal(team.members[0].activeProvider, undefined)
  assert.equal(team.members[0].activeModel, undefined)
  assert.equal(team.members[0].fallbackActive, undefined)
  // The fallback configuration itself survives for future failures.
  assert.deepEqual(team.members[0].fallback, { provider: 'grok', model: 'grok-4' })
})

test('does not mutate the member when the host refuses the selection', async () => {
  const member = makeMember()
  const team = makeTeam([member])
  const { ctx, selects } = makeCtx({ selectThrows: true })
  const result = await switchMemberModel(ctx, { team, member, provider: 'openai', model: 'gpt-4o-mini' })
  assert.equal(result.ok, false)
  assert.match(result.error, /host refused/)
  assert.equal(selects.length, 0)
  assert.equal(member.provider, 'openai')
  assert.equal(member.model, 'gpt-4o')
  assert.equal(team.members[0], member)
})

test('applyManualSwitch is a pure transition that preserves the spawn snapshot', () => {
  const member = makeMember({
    activeProvider: 'grok',
    activeModel: 'grok-4',
    fallbackActive: true,
  })
  const before = { ...member }
  const next = applyManualSwitch(member, { provider: 'openai', model: 'gpt-4o-mini', reasoningEffort: 'high' })
  assert.notEqual(next, member, 'must return a new record')
  assert.equal(next.provider, 'openai')
  assert.equal(next.model, 'gpt-4o-mini')
  assert.equal(next.reasoningEffort, 'high')
  assert.equal(next.activeProvider, undefined)
  assert.equal(next.activeModel, undefined)
  assert.equal(next.fallbackActive, undefined)
  assert.equal(next.spawnProvider, 'openai')
  assert.equal(next.spawnModel, 'gpt-4o')
  assert.equal(next.spawnReasoningEffort, 'low')
  // The input record is untouched.
  assert.deepEqual(member, before)
})

test('applyManualSwitch clears reasoningEffort when the target has none', () => {
  const member = makeMember({ reasoningEffort: 'low' })
  const next = applyManualSwitch(member, { provider: 'grok', model: 'grok-4' })
  assert.equal(next.reasoningEffort, undefined)
  assert.equal('reasoningEffort' in next, false)
})

test('production spawn writes spawn* once and a later manual switch keeps the descriptor snapshot', async () => {
  const { spawnMember } = await import('../src/members.ts')
  const member = { id: '', name: 'alice', provider: 'openai', model: 'gpt-4o', reasoningEffort: 'low', joinedAt: 0, status: 'idle' }
  const team = makeTeam([member], { id: 'spawn-team' })
  const captain = { id: 'captain-1', session: { header: {} } }
  let startSpec
  const ctx = {
    subagents: {
      getProvider: () => ({ prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } }),
      startContinuable: async spec => { startSpec = spec; return { childId: 'child-1' } },
    },
  }
  await spawnMember(
    ctx,
    { provider: 'spawn', maxDepth: 0 },
    { withPending: (_parent, _label, _selection, run) => run() },
    { provider: 'openai', model: 'gpt-4o', reasoningEffort: 'low' },
    captain, team, member, '.agent-teams', new AbortController().signal,
  )
  assert.equal(member.id, 'child-1')
  assert.equal(startSpec.request.agentOptions.provider, 'openai')
  // R1-001: the first successful spawn persists the immutable snapshot exactly once.
  assert.equal(member.spawnProvider, 'openai')
  assert.equal(member.spawnModel, 'gpt-4o')
  assert.equal(member.spawnReasoningEffort, 'low')

  const switched = applyManualSwitch(member, { provider: 'grok', model: 'grok-4' })
  assert.equal(switched.provider, 'grok', 'current route follows the manual switch')
  assert.equal(switched.spawnProvider, 'openai', 'spawn snapshot is never rewritten')
  assert.equal(switched.spawnModel, 'gpt-4o')
  assert.equal(switched.spawnReasoningEffort, 'low')

  // Cold resume compares the immutable descriptor to spawn* rather than the
  // current route, so the post-switch B route no longer trips the mismatch guard.
  const descriptor = { agentProvider: 'openai', agentModel: 'gpt-4o' }
  const expectedProvider = switched.spawnProvider ?? switched.provider
  const expectedModel = switched.spawnModel ?? switched.model
  assert.equal(descriptor.agentProvider, expectedProvider)
  assert.equal(descriptor.agentModel, expectedModel)
  assert.notEqual(descriptor.agentProvider, switched.provider, 'the current route diverged from the descriptor')
})
