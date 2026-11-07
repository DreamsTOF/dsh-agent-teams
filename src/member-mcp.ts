/**
 * Member-scoped MCP server-instruction visibility (AgentTeams 0.2.0, §4.6).
 *
 * Each mounted MCP server publishes its `instructions` as a GLOBAL
 * `systemPrompt` section named `mcp:<server>` (`mcp-client`'s
 * `registerServerContext`). `tools.restrict` / the tool filter only governs
 * which tool schemas a member sees — it cannot remove prompt sections. So a
 * member whose definition selects only server A would still read server B's
 * `### MCP server: B` instructions while being unable to call B's tools.
 *
 * This module strips the section of every non-selected server at assembly
 * time, scoped to the member agent, so "only A selected" really shows only
 * A's instructions. Server-level resource tools remain governed by the tool
 * filter; this module only touches the instruction text.
 * @module dsh-agent-teams/member-mcp
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'

/** Section-name prefix `mcp-client` uses for one server's instructions. */
export const MCP_SECTION_PREFIX = 'mcp:'

/** Minimal structural view of one assembled prompt section. */
interface AssembledSectionLike {
  readonly name: string
}

/** Minimal structural view of one prompt presentation. */
interface PromptPresentationLike {
  readonly sections?: readonly AssembledSectionLike[]
}

/** Structural view of just the `on` verb we use, kept off the host event typing. */
interface ChildCtxOnLike {
  on(
    event: string,
    listener: (assembly: PromptPresentationLike, context: unknown, next: () => Promise<PromptPresentationLike>) => Promise<PromptPresentationLike>,
  ): () => void
}

/**
 * Install a member-scoped `system-prompt/assemble` filter that removes the
 * `mcp:<server>` instruction section of every server NOT in `allowedServers`.
 * A section is kept when its name does not start with `mcp:` or its server is
 * allowed (case-insensitive).
 * @param childCtx - the member's child context (scope of the listener).
 * @param agent - the member agent the filter belongs to.
 * @param allowedServers - the resolved MCP server allowlist (non-empty).
 * @returns a disposer that removes the listener.
 */
export function installMemberMcpInstructionsFilter(
  childCtx: Context,
  agent: Agent,
  allowedServers: readonly string[],
): () => void {
  const allowed = new Set(allowedServers.map(name => name.trim().toLowerCase()).filter(name => name !== ''))
  const on = (childCtx as unknown as ChildCtxOnLike).on
  void agent
  return on.call(childCtx, 'system-prompt/assemble', async (_assembly, _context, next) => {
    const result = await next()
    const sections = result.sections
    if (!Array.isArray(sections)) return result
    const kept = sections.filter((section) => {
      const name = section?.name
      if (typeof name !== 'string' || !name.startsWith(MCP_SECTION_PREFIX)) return true
      return allowed.has(name.slice(MCP_SECTION_PREFIX.length).toLowerCase())
    })
    return kept.length === sections.length ? result : { ...result, sections: kept }
  })
}
