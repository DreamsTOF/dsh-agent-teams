/**
 * Member-scoped tool-guidance visibility (AgentTeams 0.2.0, §4.4).
 *
 * Every core tool plugin contributes a `tool:<name>` system-prompt section
 * describing how to use it. Some gate the text on the tool's own visibility
 * (`read`), but many are static (`pwsh`, `bash`, `edit`, `write`, `grep`, …).
 * `tools.restrict` removes a member's tool schema but not those static
 * guidance sections, so a restricted member would read "use the pwsh tool" for
 * a tool it cannot call. This module drops every `tool:<name>` section whose
 * tool is not actually visible to the member.
 * @module dsh-agent-teams/member-prompt
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'

/** Section-name prefix every tool-guidance section uses. */
export const TOOL_SECTION_PREFIX = 'tool:'

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

/** Structural view of the tool-registry lookup we use. */
interface ToolsLookup {
  get?(name: string, scope?: unknown): unknown
}

/**
 * Install a member-scoped `system-prompt/assemble` filter that drops every
 * `tool:<name>` guidance section whose tool is not visible to the member.
 * @param childCtx - the member's child context (scope of the listener).
 * @param agent - the member agent the filter belongs to.
 * @returns a disposer that removes the listener.
 */
export function installMemberToolGuidanceFilter(childCtx: Context, agent: Agent): () => void {
  const tools = (childCtx as unknown as { tools?: ToolsLookup }).tools
  const get = tools?.get
  const on = (childCtx as unknown as ChildCtxOnLike).on
  if (typeof get !== 'function' || typeof on !== 'function') return () => undefined
  return on.call(childCtx, 'system-prompt/assemble', async (_assembly, _context, next) => {
    const result = await next()
    const sections = result.sections
    if (!Array.isArray(sections)) return result
    const kept = sections.filter((section) => {
      const name = section?.name
      if (typeof name !== 'string' || !name.startsWith(TOOL_SECTION_PREFIX)) return true
      return get.call(tools, name.slice(TOOL_SECTION_PREFIX.length), agent) !== undefined
    })
    return kept.length === sections.length ? result : { ...result, sections: kept }
  })
}
