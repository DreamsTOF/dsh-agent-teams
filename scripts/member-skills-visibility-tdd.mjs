#!/usr/bin/env node
/**
 * Integration regression: the skill catalog the model SEES must be exactly the
 * set of skill names the member-scoped `skill` tool ACCEPTS.
 *
 * Host `@deepseek-ai/dsh-tool-skill` (0.2.2-rc.1) owns `source.kind ===
 * 'skill-catalog'`. Its `agent/pre-step` listener: (a) computes
 * `toolVisible = ctx.tools.get('skill', agent) === itsOwnTool`; (b) with a
 * scoped shadow in place it observes an empty catalog and DELETES any
 * `skill-catalog` message; (c) without a shadow it publishes the full catalog
 * and REPLACES any `skill-catalog` message. [Replicated below from the host
 * source so the coupling is explicit.]
 *
 * The first implementation published its filtered catalog under
 * `kind: 'skill-catalog'`, so the host deleted it (model sees nothing) or a
 * non-shadowing registration left the full catalog while the tool rejected
 * most names (model loops on "unavailable" skills). These cases fail on that
 * implementation and pass only when the catalog and the tool share one source
 * of truth and the catalog uses a host-independent source kind.
 *
 * Run against `src/*.ts` (Node type stripping) like the other TDD scripts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  installMemberSkillFilter,
  MEMBER_SKILL_CATALOG_KIND,
  HANDOFF_SKILL_NAME,
} from '../src/member-skills.ts'

const ALL_SKILLS = [
  { name: 'plugin-write', description: 'Write plugins', invocation: { modelInvocable: true } },
  { name: 'plugin-test', description: 'Test plugins', invocation: { modelInvocable: true } },
  { name: 'code-review', description: 'Review code', invocation: { modelInvocable: true } },
  { name: 'hidden-skill', description: 'Not model invocable', invocation: { modelInvocable: false } },
  { name: 'handoff', description: 'Write a handover document', invocation: { modelInvocable: true } },
]

/** Minimal member childCtx + host `skill` tool registry. */
function fixture() {
  const originalCalls = []
  const hostTool = {
    name: 'skill',
    async execute(args) {
      originalCalls.push(args.name)
      return { name: args.name }
    },
  }
  let registered
  const tools = {
    get(name) {
      if (name !== 'skill') return undefined
      return registered ?? hostTool
    },
    register(definition) {
      registered = definition
      return () => { registered = undefined }
    },
  }
  const skills = {
    async snapshot() { return { skills: ALL_SKILLS, complete: true } },
  }
  const listeners = []
  const childCtx = {
    tools,
    skills,
    on(_event, handler) {
      listeners.push(handler)
      return () => { listeners.splice(listeners.indexOf(handler), 1) }
    },
  }
  return { childCtx, agent: { id: 'member-1' }, originalCalls, listeners, get registered() { return registered } }
}

/** Replica of the host `tool-skill` catalog listener branches (0.2.2-rc.1). */
function hostCatalogStep(decision, { toolVisible, historyPublished }) {
  const skills = toolVisible ? ALL_SKILLS : []
  const existing = decision.messages.find(message => message.source?.kind === 'skill-catalog')
  if (!historyPublished && skills.length === 0) {
    return existing === undefined
      ? decision
      : { ...decision, messages: decision.messages.filter(message => message.id !== existing.id) }
  }
  const entries = skills.map(skill => ({ name: skill.name, description: skill.description }))
  const catalog = {
    id: 'host-catalog',
    content: [{
      type: 'text',
      text: `<system-reminder>\n<available_skills>\n${entries.map(e => `- \`${e.name}\`: ${e.description}`).join('\n')}\n</available_skills>\nOnly use names in this replacement catalog.\n</system-reminder>`,
    }],
    source: { kind: 'skill-catalog', form: 'catalog', entries },
  }
  return {
    ...decision,
    messages: existing === undefined
      ? [...decision.messages, catalog]
      : decision.messages.map(message => (message.id === existing.id ? catalog : message)),
  }
}

/** Run one pre-step: our listener (registered later => produces first) then host. */
async function runStep(f, options) {
  let decision = { kind: 'proceed', messages: [] }
  decision = await f.listeners[0]({ agent: f.agent, signal: new AbortController().signal }, async () => decision)
  decision = hostCatalogStep(decision, options)
  return decision
}

/** Extract every skill name listed inside an <available_skills> frame. */
function catalogNames(messages) {
  const names = new Set()
  for (const message of messages) {
    for (const block of message.content ?? []) {
      if (block.type !== 'text') continue
      const frame = /<available_skills>([\s\S]*?)<\/available_skills>/.exec(block.text)
      if (frame === null) continue
      for (const line of frame[1].split('\n')) {
        const match = /^- `([^`]+)`:/.exec(line.trim())
        if (match !== null) names.add(match[1].toLowerCase())
      }
    }
  }
  return names
}

/** Probe the shadow tool: which of ALL_SKILLS does it accept? */
async function acceptedNames(f) {
  const accepted = []
  for (const skill of ALL_SKILLS) {
    try {
      await f.registered.execute({ name: skill.name }, {})
      accepted.push(skill.name.toLowerCase())
    } catch { /* rejected */ }
  }
  return accepted.sort()
}

function install(f, allowedSkills) {
  const dispose = installMemberSkillFilter(f.childCtx, f.agent, allowedSkills)
  assert.equal(f.listeners.length, 1, 'exactly one pre-step listener installed')
  return dispose
}

test('catalog and shadowed skill tool accept exactly the same names', async () => {
  const f = fixture()
  const dispose = install(f, ['plugin-write'])
  try {
    const decision = await runStep(f, { toolVisible: false, historyPublished: false })
    const shown = catalogNames(decision.messages)
    assert.deepEqual([...shown].sort(), ['handoff', 'plugin-write'].sort(), 'catalog shows only allowlist + handoff')
    const frames = decision.messages.filter(message =>
      (message.content ?? []).some(block => block.type === 'text' && block.text.includes('<available_skills>')))
    assert.equal(frames.length, 1, 'exactly one <available_skills> frame')
    const accepted = await acceptedNames(f)
    assert.deepEqual(accepted, ['handoff', 'plugin-write'].sort(), 'tool accepts only allowlist + handoff')
    assert.deepEqual(accepted, [...shown].sort(), 'CATALOG == TOOL (the invariant)')
  } finally {
    dispose()
  }
})

test('a stale or inherited host catalog never leaks extra skill names', async () => {
  const f = fixture()
  const dispose = install(f, ['plugin-write'])
  try {
    const decision = await runStep(f, { toolVisible: false, historyPublished: true })
    const shown = catalogNames(decision.messages)
    assert.deepEqual([...shown].sort(), ['handoff', 'plugin-write'].sort())
    assert.ok(!shown.has('code-review') && !shown.has('plugin-test'), 'no filtered name leaks')
  } finally {
    dispose()
  }
})

test('a rejected name echoes the available catalog so the model can correct', async () => {
  const f = fixture()
  const dispose = install(f, ['plugin-write'])
  try {
    await runStep(f, { toolVisible: false, historyPublished: false })
    await assert.rejects(
      () => f.registered.execute({ name: 'plugin-test' }, {}),
      /Available skills: .*plugin-write/,
    )
    assert.deepEqual(f.originalCalls, [], 'a rejected name never reaches the host tool')
  } finally {
    dispose()
  }
})

test('inherit-all exposes every model-invocable skill and nothing hidden', async () => {
  const f = fixture()
  const dispose = install(f, undefined)
  try {
    const decision = await runStep(f, { toolVisible: false, historyPublished: false })
    const shown = catalogNames(decision.messages)
    const accepted = await acceptedNames(f)
    assert.deepEqual([...shown].sort(), ['code-review', 'handoff', 'plugin-test', 'plugin-write'].sort())
    assert.ok(!shown.has('hidden-skill') && !accepted.includes('hidden-skill'), 'modelInvocable:false skill stays hidden')
    assert.deepEqual(accepted, [...shown].sort())
  } finally {
    dispose()
  }
})

test('a non-shadowing registration fails closed instead of mismatching', () => {
  const hostTool = { name: 'skill', async execute() { return {} } }
  const childCtx = {
    tools: {
      get() { return hostTool }, // registration never wins: get still returns the host tool
      register() { return () => {} },
    },
    skills: { async snapshot() { return { skills: ALL_SKILLS, complete: true } } },
    on() { return () => {} },
  }
  assert.throws(
    () => installMemberSkillFilter(childCtx, { id: 'member-1' }, ['plugin-write']),
    /failed to shadow the host `skill` tool/,
  )
})

test('our catalog uses a source kind the host catalog listener ignores', () => {
  assert.notEqual(MEMBER_SKILL_CATALOG_KIND, 'skill-catalog')
  assert.equal(HANDOFF_SKILL_NAME, 'handoff')
  // The replica deletes a `skill-catalog` message when shadowed — the exact
  // failure mode the old implementation hit.
  const ownCatalog = { id: 'ours', content: [{ type: 'text', text: '<available_skills>\n- `plugin-write`: x\n</available_skills>' }], source: { kind: 'skill-catalog', entries: [{ name: 'plugin-write', description: 'x' }] } }
  const decision = hostCatalogStep({ kind: 'proceed', messages: [ownCatalog] }, { toolVisible: false, historyPublished: false })
  assert.equal(catalogNames(decision.messages).size, 0, 'a skill-catalog message is deleted when the host tool is shadowed')
})
