#!/usr/bin/env node
/**
 * Member-scoped tool-guidance visibility (§4.4). `tool:<name>` guidance
 * sections are static for most tools (`pwsh`, `bash`, `edit`, `write`, …), so
 * a member whose tool filter removes the tool must not keep reading its
 * instructions.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  installMemberToolGuidanceFilter,
  compileSectionWhitelist,
  matchesSectionWhitelist,
  TOOL_SECTION_PREFIX,
} from '../src/member-prompt.ts'

function fixture(visible) {
  const listeners = []
  const childCtx = {
    tools: { get(name) { return visible.includes(name) ? { name } : undefined } },
    on(_event, handler) { listeners.push(handler); return () => { listeners.splice(listeners.indexOf(handler), 1) } },
  }
  return { childCtx, agent: { id: 'member-1' }, listeners }
}

function presentation() {
  return {
    sections: [
      { name: 'harness', text: 'identity' },
      { name: 'tool:read', text: 'use read' },
      { name: 'tool:pwsh', text: 'use pwsh' },
      { name: 'mcp:codegraph', text: 'mcp' },
    ],
    contexts: [],
    variables: {},
  }
}

async function run(f, input = presentation()) {
  return f.listeners[0](input, {}, async () => input)
}

test('drops tool guidance for tools the member cannot see, keeps the rest', async () => {
  const f = fixture(['read'])
  installMemberToolGuidanceFilter(f.childCtx, f.agent)
  const out = await run(f)
  assert.deepEqual(out.sections.map(section => section.name), ['harness', 'tool:read', 'mcp:codegraph'])
})

test('keeps a tool guidance section when its tool is visible', async () => {
  const f = fixture(['read', 'pwsh'])
  installMemberToolGuidanceFilter(f.childCtx, f.agent)
  const out = await run(f)
  assert.ok(out.sections.some(section => section.name === 'tool:pwsh'))
})

test('exposes the prefix and a working disposer', () => {
  const f = fixture(['read'])
  const dispose = installMemberToolGuidanceFilter(f.childCtx, f.agent)
  assert.equal(f.listeners.length, 1)
  dispose()
  assert.equal(f.listeners.length, 0)
  assert.equal(TOOL_SECTION_PREFIX, 'tool:')
})

test('a child context without a tools service installs nothing', () => {
  const listeners = []
  const childCtx = { on(_event, handler) { listeners.push(handler); return () => {} } }
  const dispose = installMemberToolGuidanceFilter(childCtx, { id: 'm' })
  assert.equal(listeners.length, 0)
  dispose()
})

test('compileSectionWhitelist turns * into a prefix wildcard', () => {
  const whitelist = compileSectionWhitelist(['browser-use:*'])
  assert.equal(matchesSectionWhitelist('browser-use:stagehand-native', whitelist), true)
  assert.equal(matchesSectionWhitelist('browser-use', whitelist), false)
  assert.equal(matchesSectionWhitelist('computer-use:cua', whitelist), false)
})

test('an invalid whitelist pattern is skipped, not fatal', () => {
  const whitelist = compileSectionWhitelist(['[unterminated'])
  assert.equal(whitelist.length, 0)
})

test('a whitelisted tool guidance section is kept even when the tool is hidden', async () => {
  const f = fixture(['read'])
  installMemberToolGuidanceFilter(f.childCtx, f.agent, compileSectionWhitelist(['tool:pwsh']))
  const out = await run(f)
  assert.ok(out.sections.some(section => section.name === 'tool:pwsh'))
  assert.ok(out.sections.some(section => section.name === 'tool:read'))
})
