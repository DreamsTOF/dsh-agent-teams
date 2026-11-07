#!/usr/bin/env node
/**
 * Member tool-allow resolution (§4.4 tools + §4.6 mcpServers, orthogonal).
 *
 * `tools` gates explicit (non-MCP) tools; `mcpServers` opens EVERY tool of the
 * named servers. A definition with 3 tools plus one 10-tool MCP server must
 * grant 13 tools — MCP tools are never intersected with the `tools` list.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mcpServerOfToolName, resolveDefinition, resolveMemberToolAllow } from '../src/member-definitions.ts'

const codegraphTools = Array.from({ length: 10 }, (_, i) => `mcp__codegraph__t${i + 1}`)
const VISIBLE = ['read', 'edit', 'write', 'pwsh', ...codegraphTools, 'mcp__anysearch__search']

/** Build a ResolvedAllowlist fixture. */
function res(requested, resolved, inherits = false) {
  return { requested, resolved, unmatched: [], inherits, fallback: false }
}

const sorted = list => [...list].sort()

test('tools allowlist + one MCP server opens all server tools (3 + 10 = 13)', () => {
  const { allow, restricted } = resolveMemberToolAllow({
    tools: res(['read', 'edit', 'write'], ['read', 'edit', 'write']),
    mcpServers: res(['codegraph'], ['codegraph']),
    captainVisibleTools: VISIBLE,
  })
  assert.equal(restricted, true)
  assert.equal(allow.length, 13)
  assert.deepEqual(sorted(allow), sorted(['read', 'edit', 'write', ...codegraphTools]))
  assert.ok(!allow.includes('pwsh'), 'explicit tools list still excludes other non-MCP tools')
  assert.ok(!allow.includes('mcp__anysearch__search'), 'only the selected server opens')
})

test('tools allowlist without mcpServers still inherits every mounted MCP tool', () => {
  const { allow } = resolveMemberToolAllow({
    tools: res(['read'], ['read']),
    mcpServers: res(undefined, [], true), // mcpServers absent => inherit all mounted
    captainVisibleTools: VISIBLE,
  })
  assert.deepEqual(sorted(allow), sorted(['read', ...codegraphTools, 'mcp__anysearch__search']))
})

test('mcpServers only keeps every mounted MCP tool of that server plus all non-MCP tools', () => {
  const { allow } = resolveMemberToolAllow({
    tools: res(undefined, [], true), // tools absent => inherit all non-MCP
    mcpServers: res(['codegraph'], ['codegraph']),
    captainVisibleTools: VISIBLE,
  })
  assert.deepEqual(sorted(allow), sorted(['read', 'edit', 'write', 'pwsh', ...codegraphTools]))
  assert.ok(!allow.includes('mcp__anysearch__search'))
})

test('an all-unmatched mcpServers request falls back to inheriting every mounted server', () => {
  const { allow } = resolveMemberToolAllow({
    tools: res(['read'], ['read']),
    mcpServers: res(['nope'], [], true), // requested but unresolved => inherits all
    captainVisibleTools: VISIBLE,
  })
  assert.deepEqual(sorted(allow), sorted(['read', ...codegraphTools, 'mcp__anysearch__search']))
})

test('nothing restricts => no filter is installed (inherit all)', () => {
  const { allow, restricted } = resolveMemberToolAllow({
    tools: res(undefined, [], true),
    mcpServers: res(undefined, [], true),
    captainVisibleTools: VISIBLE,
  })
  assert.equal(restricted, false)
  assert.equal(allow, undefined)
})

test('a tool_policy base allow is unioned with the selected server tools', () => {
  const { allow } = resolveMemberToolAllow({
    tools: res(undefined, [], true),
    mcpServers: res(['codegraph'], ['codegraph']),
    captainVisibleTools: VISIBLE,
    baseAllow: ['read', 'edit'],
  })
  assert.deepEqual(sorted(allow), sorted(['read', 'edit', ...codegraphTools]))
})

test('mcp tool-name parsing extracts the server segment', () => {
  assert.equal(mcpServerOfToolName('mcp__codegraph__query'), 'codegraph')
  assert.equal(mcpServerOfToolName('mcp__a__b__c'), 'a')
  assert.equal(mcpServerOfToolName('read'), undefined)
  assert.equal(mcpServerOfToolName('mcp__noseparator'), undefined)
})

/** Minimal parsed definition; only the fields resolveDefinition reads are set. */
const DEF = {
  name: 'd', description: '', model: 'inherit', maxTasks: 5, maxContextTokens: 1,
  enabled: true, persona: '', source: 'workspace', path: '/x.md', contentHash: 'h', diagnostics: [],
}

test('an MCP server the host does not have is ignored like an unknown skill', () => {
  const visible = ['read', 'mcp__codegraph__a', 'mcp__codegraph__b']
  const resolved = resolveDefinition(
    { ...DEF, tools: ['read'], mcpServers: ['codegraph', 'ghost'] },
    visible,
    { mountedMcpServers: ['codegraph'] },
  )
  assert.deepEqual(resolved.mcpServers.resolved, ['codegraph'], 'the mounted server resolves')
  assert.deepEqual(resolved.mcpServers.unmatched, ['ghost'], 'the phantom server is ignored')
  assert.equal(resolved.mcpServers.inherits, false)
  assert.ok(resolved.diagnostics.some(d => d.code === 'mcp-unknown'), 'a diagnostic is recorded, not a fatal error')
})

test('a wholly unknown mcpServers list falls back like an all-unknown skill list', () => {
  const visible = ['read', 'mcp__codegraph__a']
  const resolved = resolveDefinition(
    { ...DEF, mcpServers: ['ghost'] },
    visible,
    { mountedMcpServers: ['codegraph'] },
  )
  assert.equal(resolved.mcpServers.inherits, true, 'all-unknown falls back to inherit-all like skills')
  assert.deepEqual(resolved.mcpServers.unmatched, ['ghost'])
  assert.ok(resolved.diagnostics.some(d => d.code === 'mcp-fallback'))
})
