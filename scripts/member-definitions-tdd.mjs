#!/usr/bin/env node
/**
 * TDD checks for the member definition engine and member skill filter.
 *
 * These exercise the pure modules directly from `src/*.ts` (Node type
 * stripping) so they run without a prior `pnpm build`. The covered contracts
 * are the requirement-two acceptance cases: directory priority, comma/array
 * parsing, CodeBuddy tool mapping, all-unmatched inheritance, skill allowlist
 * filtering with an always-visible handoff skill, and a YAML error isolated to
 * one file.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { scanMemberDefinitions, resolveDefinition } from '../src/member-definitions.ts'
import {
  filterSkillSummaries,
  mergeHandoffSkill,
  handoffSkillProvider,
  handoffSkillBody,
  HANDOFF_SKILL_SECTIONS,
  HANDOFF_SKILL_NAME,
} from '../src/member-skills.ts'

const MEMBER_TOOLS = [
  'agent_teams_claim_task',
  'agent_teams_update_task',
  'agent_teams_send_message',
  'agent_teams_status',
]

// A realistic captain-visible tool set: DSH tools, the four coordination
// tools, and captain-only tools that must never be granted to a member.
const CAPTAIN_TOOLS = [
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'pwsh',
  'skill',
  'web_search',
  'web_fetch',
  'todo_write',
  'subagent',
  ...MEMBER_TOOLS,
  'agent_teams_create',
  'agent_teams_add_member',
  'agent_teams_assign_task',
]

async function withWorkspace(run) {
  const base = await mkdtemp(join(tmpdir(), 'agent-teams-defs-'))
  try {
    await run(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

async function writeDef(filePath, content) {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, content, 'utf8')
}

const fm = lines => `---\n${lines.join('\n')}\n---\n`

test('three-directory scan: workspace overrides ~/.dsh and ~/.agents by name', async () => {
  await withWorkspace(async base => {
    const workspace = join(base, 'ws')
    const home = join(base, 'home')
    await writeDef(join(workspace, '.agents', 'agents', 'shared.md'), fm(['name: shared', 'description: from-workspace']))
    await writeDef(join(home, '.dsh', 'agents', 'shared.md'), fm(['name: shared', 'description: from-dsh']))
    await writeDef(join(home, '.agents', 'agents', 'shared.md'), fm(['name: shared', 'description: from-user']))
    await writeDef(join(workspace, '.agents', 'agents', 'only-workspace.md'), fm(['name: only-workspace']))
    await writeDef(join(home, '.dsh', 'agents', 'only-dsh.md'), fm(['name: only-dsh']))
    await writeDef(join(home, '.agents', 'agents', 'only-user.md'), fm(['name: only-user']))

    const { definitions, diagnostics } = await scanMemberDefinitions(workspace, { homeDir: home })
    const names = definitions.map(d => d.name).sort()
    assert.deepEqual(names, ['only-dsh', 'only-user', 'only-workspace', 'shared'])
    const shared = definitions.find(d => d.name === 'shared')
    assert.equal(shared.description, 'from-workspace')
    assert.equal(shared.source, 'workspace')
    const overridden = diagnostics.filter(d => d.code === 'overridden')
    assert.equal(overridden.length, 2)
    // Defaults are applied when the frontmatter omits a field.
    assert.equal(shared.model, 'inherit')
    assert.equal(shared.maxTasks, 5)
    assert.equal(shared.maxContextTokens, 200_000_000)
    assert.equal(shared.enabled, true)
  })
})

test('frontmatter parses a comma string and a YAML array, dropping duplicates', async () => {
  await withWorkspace(async base => {
    const workspace = join(base, 'ws')
    await writeDef(
      join(workspace, '.agents', 'agents', 'comma.md'),
      `${fm(['name: comma', 'tools: read, edit, glob, glob', 'skills: plugin-write, plugin-test'])}# Body\n`,
    )
    await writeDef(
      join(workspace, '.agents', 'agents', 'array.md'),
      `${fm(['name: array', 'tools:', '  - read', '  - edit', 'skills:', '  - plugin-write'])}# Body\n`,
    )
    const { definitions } = await scanMemberDefinitions(workspace, { homeDir: join(base, 'home') })
    const comma = definitions.find(d => d.name === 'comma')
    const array = definitions.find(d => d.name === 'array')
    assert.deepEqual(comma.tools, ['read', 'edit', 'glob'])
    assert.deepEqual(comma.skills, ['plugin-write', 'plugin-test'])
    assert.deepEqual(array.tools, ['read', 'edit'])
    assert.deepEqual(array.skills, ['plugin-write'])

    const resolved = resolveDefinition(comma, CAPTAIN_TOOLS, { captainVisibleSkills: ['plugin-write', 'plugin-test'] })
    assert.equal(resolved.tools.inherits, false)
    for (const name of ['read', 'edit', 'glob', ...MEMBER_TOOLS]) {
      assert.ok(resolved.tools.resolved.includes(name), `expected ${name} in ${resolved.tools.resolved}`)
    }
    // No duplicates even though "glob" was requested twice and is also present.
    assert.equal(new Set(resolved.tools.resolved.map(n => n.toLowerCase())).size, resolved.tools.resolved.length)
  })
})

test('CodeBuddy tool names map to DSH tools; captain-only and unmappable names are dropped', async () => {
  await withWorkspace(async base => {
    const workspace = join(base, 'ws')
    await writeDef(
      join(workspace, '.agents', 'agents', 'mapped.md'),
      fm([
        'name: mapped',
        'tools: list_dir, read_file, execute_command, send_message, use_skill, web_search, read_lints, agent_teams_create',
      ]),
    )
    const { definitions } = await scanMemberDefinitions(workspace, { homeDir: join(base, 'home') })
    const resolved = resolveDefinition(definitions[0], CAPTAIN_TOOLS)
    const kept = resolved.tools.resolved.map(n => n.toLowerCase())
    for (const expected of ['glob', 'read', 'pwsh', 'agent_teams_send_message', 'skill', 'web_search']) {
      assert.ok(kept.includes(expected), `expected mapped tool ${expected} in ${resolved.tools.resolved}`)
    }
    assert.ok(!kept.includes('read_lints'), 'read_lints has no equivalent and must be dropped')
    assert.ok(!kept.includes('agent_teams_create'), 'captain-only tools must never be granted to a member')
    assert.ok(resolved.tools.unmatched.includes('read_lints'))
    assert.ok(resolved.tools.unmatched.includes('agent_teams_create'))
    assert.ok(resolved.diagnostics.some(d => d.code === 'unknown-tool'))
    assert.ok(resolved.diagnostics.some(d => d.code === 'captain-only-tool'))
  })
})

test('a wholly unmatched tool list falls back to inheriting all captain-visible tools', async () => {
  await withWorkspace(async base => {
    const workspace = join(base, 'ws')
    await writeDef(join(workspace, '.agents', 'agents', 'wrong.md'), fm(['name: wrong', 'tools: bogus_one, bogus_two']))
    const { definitions } = await scanMemberDefinitions(workspace, { homeDir: join(base, 'home') })
    const resolved = resolveDefinition(definitions[0], CAPTAIN_TOOLS)
    assert.equal(resolved.tools.inherits, true)
    assert.equal(resolved.tools.fallback, true)
    assert.equal(resolved.tools.unmatched.length, 2)
    // Inherited set is the captain's tools minus captain-only, plus coordination.
    assert.ok(resolved.tools.resolved.includes('read'))
    assert.ok(resolved.tools.resolved.includes('web_search'))
    assert.ok(!resolved.tools.resolved.includes('agent_teams_create'))
    for (const name of MEMBER_TOOLS) assert.ok(resolved.tools.resolved.includes(name))
    assert.ok(resolved.diagnostics.some(d => d.code === 'tools-fallback'))
  })
})

test('skill allowlist filters the catalog; handoff is always visible', async () => {
  await withWorkspace(async base => {
    const workspace = join(base, 'ws')
    await writeDef(
      join(workspace, '.agents', 'agents', 'skills.md'),
      fm(['name: skills', 'skills: plugin-write, plugin-test, missing-skill']),
    )
    const { definitions } = await scanMemberDefinitions(workspace, { homeDir: join(base, 'home') })
    const resolved = resolveDefinition(definitions[0], CAPTAIN_TOOLS, {
      captainVisibleSkills: ['plugin-write', 'plugin-test', 'plugin-other'],
    })
    assert.deepEqual(resolved.skills.resolved, ['plugin-write', 'plugin-test'])
    assert.deepEqual(resolved.skills.unmatched, ['missing-skill'])
    assert.ok(resolved.diagnostics.some(d => d.code === 'skill-unknown'))
  })

  // Catalog filter: only allowed skills survive, handoff is forced in.
  const catalog = [
    { name: 'plugin-write', description: 'w' },
    { name: 'plugin-test', description: 't' },
    { name: 'handoff', description: 'h' },
    { name: 'hidden-skill', description: 'x' },
  ]
  const filtered = filterSkillSummaries(catalog, ['plugin-write'])
  assert.deepEqual(filtered.map(s => s.name), ['plugin-write', 'handoff'])

  // Inherit-all keeps every model-invocable skill (handoff included).
  assert.deepEqual(filterSkillSummaries(catalog, undefined).map(s => s.name), ['plugin-write', 'plugin-test', 'handoff', 'hidden-skill'])

  // Model-invisible skills are always dropped.
  const invisible = [{ name: 'x', description: 'x', invocation: { modelInvocable: false } }]
  assert.deepEqual(filterSkillSummaries(invisible, ['x']), [])

  // mergeHandoffSkill de-duplicates and appends handoff.
  assert.deepEqual(mergeHandoffSkill(['plugin-write'], 'handoff'), ['plugin-write', 'handoff'])
  assert.deepEqual(mergeHandoffSkill(['plugin-write', 'handoff'], 'handoff'), ['plugin-write', 'handoff'])
  assert.equal(mergeHandoffSkill(undefined), undefined)
})

test('all-wrong skill list falls back to inherit-all; mcpServers resolves per mounted server', async () => {
  await withWorkspace(async base => {
    const workspace = join(base, 'ws')
    await writeDef(
      join(workspace, '.agents', 'agents', 'wrong-skills.md'),
      fm(['name: wrong-skills', 'skills: nowhere, nothing']),
    )
    await writeDef(
      join(workspace, '.agents', 'agents', 'mcp.md'),
      fm(['name: mcp', 'mcpServers: codegraph, anysearch']),
    )
    const { definitions } = await scanMemberDefinitions(workspace, { homeDir: join(base, 'home') })
    const wrong = resolveDefinition(definitions.find(d => d.name === 'wrong-skills'), CAPTAIN_TOOLS, {
      captainVisibleSkills: ['plugin-write'],
    })
    assert.equal(wrong.skills.inherits, true)
    assert.equal(wrong.skills.fallback, true)
    assert.deepEqual(wrong.skills.resolved, ['plugin-write'])

    const mcp = resolveDefinition(definitions.find(d => d.name === 'mcp'), CAPTAIN_TOOLS, {
      mountedMcpServers: ['codegraph'],
    })
    assert.deepEqual(mcp.mcpServers.resolved, ['codegraph'])
    assert.deepEqual(mcp.mcpServers.unmatched, ['anysearch'])
    assert.ok(mcp.diagnostics.some(d => d.code === 'mcp-unknown'))
  })
})

test('an invalid YAML frontmatter affects only its own file', async () => {
  await withWorkspace(async base => {
    const workspace = join(base, 'ws')
    await writeDef(join(workspace, '.agents', 'agents', 'bad.md'), '---\nname: [unterminated\ntools: read\n---\nbody\n')
    await writeDef(join(workspace, '.agents', 'agents', 'good.md'), `${fm(['name: good', 'tools: read'])}# Role\nGood.\n`)
    const { definitions, diagnostics } = await scanMemberDefinitions(workspace, { homeDir: join(base, 'home') })
    assert.deepEqual(definitions.map(d => d.name), ['good'])
    const errors = diagnostics.filter(d => d.code === 'frontmatter' && d.level === 'error')
    assert.equal(errors.length, 1)
    assert.ok(errors[0].path.endsWith('bad.md'))
    const good = definitions[0]
    assert.equal(good.persona, '# Role\nGood.')
  })
})

test('the built-in handoff provider exposes a fixed-section template', async () => {
  const provider = handoffSkillProvider()
  const candidates = await provider.list()
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].name, HANDOFF_SKILL_NAME)
  const skill = await provider.get(candidates[0])
  assert.ok(skill)
  const body = handoffSkillBody()
  for (const section of HANDOFF_SKILL_SECTIONS) {
    assert.ok(body.includes(`## ${section}`), `expected section ${section}`)
  }
  assert.equal(skill.content, body)
})
