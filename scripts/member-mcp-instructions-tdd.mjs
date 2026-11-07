#!/usr/bin/env node
/**
 * Member-scoped MCP instruction visibility (§4.6).
 *
 * A member that selects only server A must read only A's `mcp:<server>`
 * instruction section — the host publishes every mounted server's instructions
 * as a global system-prompt section, which `tools.restrict` cannot remove.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { installMemberMcpInstructionsFilter, MCP_SECTION_PREFIX } from '../src/member-mcp.ts'

function fixture() {
  const listeners = []
  const childCtx = { on(_event, handler) { listeners.push(handler); return () => { listeners.splice(listeners.indexOf(handler), 1) } } }
  return { childCtx, agent: { id: 'member-1' }, listeners }
}

function presentation() {
  return {
    sections: [
      { name: 'harness', order: -1000, text: 'identity' },
      { name: 'mcp:codegraph', order: 700, text: '### MCP server: codegraph\nuse codegraph' },
      { name: 'mcp:anysearch', order: 700, text: '### MCP server: anysearch\nuse anysearch' },
    ],
    contexts: [],
    variables: {},
  }
}

async function run(f, input = presentation()) {
  return f.listeners[0](input, {}, async () => input)
}

test('only the selected server instructions survive; other sections are untouched', async () => {
  const f = fixture()
  installMemberMcpInstructionsFilter(f.childCtx, f.agent, ['codegraph'])
  const out = await run(f)
  assert.deepEqual(out.sections.map(section => section.name), ['harness', 'mcp:codegraph'])
})

test('server match is case-insensitive', async () => {
  const f = fixture()
  installMemberMcpInstructionsFilter(f.childCtx, f.agent, ['CodeGraph'])
  const out = await run(f)
  assert.deepEqual(out.sections.map(section => section.name), ['harness', 'mcp:codegraph'])
})

test('selecting every server keeps every mcp section', async () => {
  const f = fixture()
  installMemberMcpInstructionsFilter(f.childCtx, f.agent, ['codegraph', 'anysearch'])
  const out = await run(f)
  assert.equal(out.sections.length, 3)
})

test('an assemble result with no sections is returned unchanged', async () => {
  const f = fixture()
  installMemberMcpInstructionsFilter(f.childCtx, f.agent, ['codegraph'])
  const empty = { contexts: [], variables: {} }
  const out = await run(f, empty)
  assert.equal(out, empty)
})

test('the disposer removes the listener', () => {
  const f = fixture()
  const dispose = installMemberMcpInstructionsFilter(f.childCtx, f.agent, ['codegraph'])
  assert.equal(f.listeners.length, 1)
  dispose()
  assert.equal(f.listeners.length, 0)
  assert.equal(MCP_SECTION_PREFIX, 'mcp:')
})
