#!/usr/bin/env node
/**
 * Member-scoped MCP derived-surface visibility (§4.6): the server's
 * `mcp:<server>` instruction section, the `mcp-resource-servers` list, and the
 * shared resource tools' `server` argument must all follow the selected
 * servers. The host publishes instructions and the resource list as global
 * system-prompt sections that `tools.restrict` cannot reach.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  installMemberMcpInstructionsFilter,
  installMemberMcpResourceToolGuard,
  trimResourceServersText,
  MCP_SECTION_PREFIX,
  MCP_RESOURCE_SECTION,
} from '../src/member-mcp.ts'
import { compileSectionWhitelist } from '../src/member-prompt.ts'

const RESOURCE_TOOLS = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']

function promptFixture() {
  const listeners = []
  const childCtx = { on(_event, handler) { listeners.push(handler); return () => { listeners.splice(listeners.indexOf(handler), 1) } } }
  return { childCtx, agent: { id: 'member-1' }, listeners }
}

function toolsFixture() {
  const calls = []
  const defs = {}
  for (const name of RESOURCE_TOOLS) {
    defs[name] = { name, async execute(args) { calls.push([name, args.server]); return { ok: args.server } } }
  }
  const registered = {}
  const tools = {
    get(name) { return registered[name] ?? defs[name] },
    register(definition) { registered[definition.name] = definition; return () => { delete registered[definition.name] } },
  }
  return { childCtx: { tools, on() { return () => {} } }, agent: { id: 'member-1' }, calls, defs, registered }
}

function presentation() {
  return {
    sections: [
      { name: 'harness', order: -1000, text: 'identity' },
      { name: 'mcp:codegraph', order: 700, text: '### MCP server: codegraph\nuse codegraph' },
      { name: 'mcp:anysearch', order: 700, text: '### MCP server: anysearch\nuse anysearch' },
      { name: MCP_RESOURCE_SECTION, order: 700, text: '## MCP resource servers\n\nUse list_mcp_resources with one of these names as the server argument: ["codegraph","anysearch"].' },
    ],
    contexts: [],
    variables: {},
  }
}

async function run(filter, input = presentation()) {
  return filter.listeners[0](input, {}, async () => input)
}

test('only the selected server instructions survive; other sections are untouched', async () => {
  const f = promptFixture()
  installMemberMcpInstructionsFilter(f.childCtx, f.agent, ['codegraph'])
  const out = await run(f)
  assert.deepEqual(out.sections.map(section => section.name), ['harness', 'mcp:codegraph', MCP_RESOURCE_SECTION])
})

test('the resource-server list is trimmed to the selected servers', async () => {
  const f = promptFixture()
  installMemberMcpInstructionsFilter(f.childCtx, f.agent, ['codegraph'])
  const out = await run(f)
  const resource = out.sections.find(section => section.name === MCP_RESOURCE_SECTION)
  assert.ok(resource.text.includes('["codegraph"]'), 'only the selected server remains')
  assert.ok(!resource.text.includes('anysearch'))
})

test('server match is case-insensitive', async () => {
  const f = promptFixture()
  installMemberMcpInstructionsFilter(f.childCtx, f.agent, ['CodeGraph'])
  const out = await run(f)
  assert.ok(out.sections.some(section => section.name === 'mcp:codegraph'))
  assert.ok(!out.sections.some(section => section.name === 'mcp:anysearch'))
})

test('selecting every server keeps every section', async () => {
  const f = promptFixture()
  installMemberMcpInstructionsFilter(f.childCtx, f.agent, ['codegraph', 'anysearch'])
  const out = await run(f)
  assert.equal(out.sections.length, 4)
})

test('trimResourceServersText drops non-allowed names and empties when none remain', () => {
  const text = 'names as the server argument: ["codegraph","anysearch"].'
  assert.equal(trimResourceServersText(text, new Set(['codegraph'])), 'names as the server argument: ["codegraph"].')
  assert.equal(trimResourceServersText(text, new Set(['nope'])), '')
  assert.equal(trimResourceServersText('no list here', new Set(['codegraph'])), 'no list here')
})

test('resource tools accept only the selected server argument', async () => {
  const f = toolsFixture()
  const dispose = installMemberMcpResourceToolGuard(f.childCtx, f.agent, ['codegraph'])
  try {
    assert.deepEqual(Object.keys(f.registered).sort(), [...RESOURCE_TOOLS].sort(), 'all present resource tools shadowed')
    await f.registered.read_mcp_resource.execute({ server: 'codegraph', uri: 'x' }, {})
    assert.deepEqual(f.calls, [['read_mcp_resource', 'codegraph']], 'allowed server delegates to the host tool')
    await assert.rejects(
      () => f.registered.list_mcp_resources.execute({ server: 'anysearch' }, {}),
      /Available servers: codegraph/,
    )
    assert.equal(f.calls.length, 1, 'a rejected server never reaches the host tool')
  } finally {
    dispose()
  }
})

test('a resource tool absent from the registry is skipped', () => {
  const childCtx = {
    tools: { get() { return undefined }, register() { return () => {} } },
    on() { return () => {} },
  }
  const dispose = installMemberMcpResourceToolGuard(childCtx, { id: 'm' }, ['codegraph'])
  dispose()
})

test('exposes the section-name constants', () => {
  assert.equal(MCP_SECTION_PREFIX, 'mcp:')
  assert.equal(MCP_RESOURCE_SECTION, 'mcp-resource-servers')
})

test('a whitelisted mcp section is kept even when the server is not selected', async () => {
  const f = promptFixture()
  installMemberMcpInstructionsFilter(f.childCtx, f.agent, ['codegraph'], compileSectionWhitelist(['mcp:anysearch']))
  const out = await run(f)
  assert.ok(out.sections.some(section => section.name === 'mcp:anysearch'), 'whitelisted section survives')
  assert.ok(out.sections.some(section => section.name === 'mcp:codegraph'))
})
