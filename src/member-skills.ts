/**
 * Member-scoped skill visibility (AgentTeams 0.2.0, requirement two, §4.5).
 *
 * A member's definition declares a skill allowlist, but the Harness `skill`
 * tool and its `<available_skills>` catalog are registered globally by
 * `@deepseek-ai/dsh-tool-skill`, so the plugin cannot change them in place.
 * This module therefore installs a *member-scope* overlay on the child ctx:
 *
 * 1. register a same-name `skill` tool in the member's scope; a scoped
 *    registration shadows the global one, and the host catalog stops
 *    advertising itself for that agent (it only publishes when its own exact
 *    tool registration still wins);
 * 2. re-publish a filtered `<available_skills>` catalog on `agent/pre-step`
 *    that lists only the allowed skills plus `handoff`, which is *always*
 *    visible so the quota-handover flow keeps working.
 *
 * The Handoff skill itself is contributed separately by
 * {@link handoffSkillProvider} so it exists even when the host has no
 * `handoff` skill. The built-in provider ranks below host skills, making it a
 * fallback rather than a replacement.
 * @module dsh-agent-teams/member-skills
 */

import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'skill-catalog': {
      readonly kind: 'skill-catalog'
      readonly form: 'catalog'
      readonly update?: true
      readonly incomplete?: true
      readonly entries: readonly { readonly name: string; readonly description: string }[]
    }
    'agent-teams:member-skills': {
      readonly kind: 'agent-teams:member-skills'
      readonly form: 'catalog'
      readonly entries: readonly { readonly name: string; readonly description: string }[]
    }
  }
}

/** The always-visible handover skill name. */
export const HANDOFF_SKILL_NAME = 'handoff'
/**
 * Source kind of the member skill catalog. Deliberately NOT `skill-catalog`:
 * host `tool-skill` owns that kind and deletes (or replaces) every message
 * carrying it whenever its own tool is shadowed. Reusing it meant the model
 * either saw no catalog at all or saw a full, unfiltered one while our tool
 * rejected those names. A distinct kind keeps our catalog out of the host's
 * catalog waterfall so the prompt and the tool stay in sync.
 */
export const MEMBER_SKILL_CATALOG_KIND = 'agent-teams:member-skills'
/** Routing description surfaced in the filtered catalog. */
export const HANDOFF_SKILL_DESCRIPTION =
  'Write a handover document when a member reaches its task or token quota and must stop taking new work.'
/** Ranks below host providers so a real host `handoff` skill wins; this is a fallback. */
export const HANDOFF_SKILL_RANK = 1000
/** Provider name returned by the built-in handoff skill provider. */
export const HANDOFF_SKILL_PROVIDER = 'agent-teams-handoff'

/** Fixed handover document sections, in order. */
export const HANDOFF_SKILL_SECTIONS: readonly string[] = [
  '当前任务与状态',
  '已完成工作',
  '改动文件',
  '未完成项与风险',
  '建议接手步骤',
  '关键命令与验证结果',
]

/** Minimal structural view of a skill summary (see `@deepseek-ai/dsh-skill`). */
export interface SkillSummaryLike {
  readonly name: string
  readonly description: string
  readonly invocation?: { readonly modelInvocable?: boolean; readonly userInvocable?: boolean }
  readonly source?: string
  readonly provider?: string
}

/** Minimal structural view of a skill candidate contributed by a provider. */
export interface SkillCandidateLike extends SkillSummaryLike {
  readonly rank?: number
  readonly locator?: unknown
}

/** Minimal structural view of a loaded skill definition. */
export interface SkillDefinitionLike extends SkillSummaryLike {
  readonly content: string
  readonly provider?: string
}

/** Minimal structural view of a skill provider registered on `ctx.skills`. */
export interface SkillProviderLike {
  readonly name: string
  list(options?: unknown): Promise<readonly SkillCandidateLike[]>
  get(candidate: SkillCandidateLike, options?: unknown): Promise<SkillDefinitionLike | undefined>
}

/** Build the fixed-section handover document template. */
export function handoffSkillBody(memberName = '<member>'): string {
  const lines = [
    `# Handover: ${memberName}`,
    '',
    'Use this template for the handover document. Keep every section heading and replace the placeholders with concrete facts.',
    '',
  ]
  for (const section of HANDOFF_SKILL_SECTIONS) {
    lines.push(`## ${section}`, '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * Contribute the built-in `handoff` skill through `ctx.skills.registerProvider`.
 * It is a fallback: the high rank lets a host-provided `handoff` skill win.
 */
export function handoffSkillProvider(): SkillProviderLike {
  const candidate: SkillCandidateLike = {
    name: HANDOFF_SKILL_NAME,
    description: HANDOFF_SKILL_DESCRIPTION,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'agent-teams',
    provider: HANDOFF_SKILL_PROVIDER,
    rank: HANDOFF_SKILL_RANK,
    locator: { kind: 'builtin-handoff' },
  }
  return {
    name: HANDOFF_SKILL_PROVIDER,
    async list(): Promise<readonly SkillCandidateLike[]> {
      return [candidate]
    },
    async get(requested: SkillCandidateLike): Promise<SkillDefinitionLike | undefined> {
      if (requested.name !== HANDOFF_SKILL_NAME) return undefined
      return {
        name: HANDOFF_SKILL_NAME,
        description: HANDOFF_SKILL_DESCRIPTION,
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'agent-teams',
        content: handoffSkillBody(),
        provider: HANDOFF_SKILL_PROVIDER,
      }
    },
  }
}

/**
 * Merge the always-visible `handoff` skill into an allowlist.
 * `undefined` means "inherit all" and is returned untouched (nothing to add:
 * every visible skill, including `handoff`, is shown).
 */
export function mergeHandoffSkill(
  allowedSkills: readonly string[] | undefined,
  handoffSkillName = HANDOFF_SKILL_NAME,
): string[] | undefined {
  if (allowedSkills === undefined) return undefined
  const result: string[] = []
  const seen = new Set<string>()
  const push = (value: string): void => {
    const name = value.trim()
    if (name === '') return
    const key = name.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    result.push(name)
  }
  for (const name of allowedSkills) push(name)
  push(handoffSkillName)
  return result
}

/**
 * Keep only the allowed skills plus `handoff`, and drop model-invisible ones.
 * `undefined` keeps every model-invocable skill (inherit all).
 */
export function filterSkillSummaries<T extends SkillSummaryLike>(
  summaries: readonly T[],
  allowedSkills: readonly string[] | undefined,
  handoffSkillName = HANDOFF_SKILL_NAME,
): T[] {
  const handoff = handoffSkillName.toLowerCase()
  const allowed = allowedSkills === undefined
    ? undefined
    : new Set(allowedSkills.map(name => name.trim().toLowerCase()).filter(name => name !== ''))
  return summaries.filter(skill => {
    if (skill.invocation?.modelInvocable === false) return false
    if (allowed === undefined) return true
    const name = skill.name.toLowerCase()
    return name === handoff || allowed.has(name)
  })
}

/** Structural view of the member-scope tools registry verbs we use. */
interface ToolsRegistryLike {
  get?(name: string, agent?: unknown): unknown
  register?(definition: unknown): () => void
}

/** Structural view of the member-scope skills registry verbs we use. */
interface SkillsRegistryLike {
  snapshot?(options: unknown): Promise<{ skills: readonly SkillSummaryLike[]; complete?: boolean }>
}

/** Collapse and bound a catalog description line. */
function normalizeDescription(value: string, maxLength = 500): string {
  const normalized = value.replaceAll(/\s+/g, ' ').trim()
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`
}

/** Render the model-facing `<available_skills>` frame for the filtered catalog. */
function renderCatalog(entries: readonly { name: string; description: string }[]): string {
  const lines = [
    '<system-reminder>',
    entries.length === 0
      ? 'No skills are available to this member. Do not call the `skill` tool and do not infer skill instructions.'
      : 'A skill is a reusable set of task-specific instructions. The following skills are available to this member:',
    '',
    '<available_skills>',
    ...entries.map(entry => `- \`${entry.name}\`: ${entry.description}`),
    '</available_skills>',
    '',
    'This is the only valid skill catalog for this member. Ignore any other skill catalog, names from earlier turns, or names you may infer.',
    'If the task clearly matches a skill, call the `skill` tool with the exact name from this list before acting. Never call a name outside this list.',
    '</system-reminder>',
  ]
  return lines.join('\n')
}

/** Stable digest of the catalog entries so an unchanged catalog is not republished every step. */
function digestEntries(entries: readonly { name: string; description: string }[]): string {
  const canonical = entries.map(entry => JSON.stringify([entry.name, entry.description])).join('\n')
  return createHash('sha256').update(canonical).digest('hex')
}

/** Resolve the workspace cwd for a catalog lookup when the host exposes one. */
async function resolveCwd(
  childCtx: Context,
  agent: Agent,
  signal: AbortSignal,
): Promise<string | undefined> {
  const workingDirectory = (childCtx as unknown as {
    workingDirectory?: { ensure?(agent: Agent, signal: AbortSignal): Promise<string> }
  }).workingDirectory
  if (typeof workingDirectory?.ensure !== 'function') return undefined
  try {
    return await workingDirectory.ensure(agent, signal)
  } catch {
    return undefined
  }
}

/**
 * Install the member-scope skill filter on a member child context.
 *
 * Registers a same-name `skill` tool that shadows the host tool and rejects
 * any name outside the allowed set (plus `handoff`), and re-publishes the
 * filtered `<available_skills>` catalog on each step. Returns a disposer that
 * removes both contributions.
 * @param childCtx - the member's child context (scope of the registration).
 * @param agent - the member agent the overlay belongs to.
 * @param allowedSkills - the resolved skill allowlist; `undefined` inherits all.
 * @param handoffSkillName - the always-visible handover skill name.
 */
export function installMemberSkillFilter(
  childCtx: Context,
  agent: Agent,
  allowedSkills: readonly string[] | undefined,
  handoffSkillName = HANDOFF_SKILL_NAME,
): () => void {
  const disposers: Array<() => void> = []
  const visible = mergeHandoffSkill(allowedSkills, handoffSkillName)
  const visibleSet = visible === undefined ? undefined : new Set(visible.map(name => name.toLowerCase()))
  const tools = (childCtx as unknown as { tools?: ToolsRegistryLike }).tools
  const skills = (childCtx as unknown as { skills?: SkillsRegistryLike }).skills

  // The catalog the model sees and the names the `skill` tool accepts MUST be
  // the same set. `catalogNames` becomes the authority as soon as the first
  // step has resolved the real skill registry; until then the allowlist bounds
  // both sides. Deriving them separately is what let the prompt drift.
  let catalogNames: ReadonlySet<string> | undefined
  const availableHint = (): string => {
    const names = catalogNames ?? visibleSet
    return names === undefined ? 'every skill' : [...names].sort().join(', ') || '(none)'
  }

  // 1. Shadow the host `skill` tool inside this member's scope.
  const getTool = tools?.get
  const registerTool = tools?.register
  if (getTool !== undefined && registerTool !== undefined) {
    const hostTool = getTool.call(tools, 'skill', agent) as
      | (Record<string, unknown> & { execute?: (args: unknown, exec: unknown) => Promise<unknown> })
      | undefined
    if (hostTool !== undefined) {
      const originalExecute = hostTool.execute
      const shadow: Record<string, unknown> = { ...hostTool }
      shadow.execute = async (args: unknown, exec: unknown): Promise<unknown> => {
        const requested = typeof (args as { name?: unknown } | null)?.name === 'string'
          ? ((args as { name: string }).name)
          : ''
        const names = catalogNames ?? visibleSet
        if (names !== undefined && !names.has(requested.trim().toLowerCase())) {
          // Echo the exact catalog: a bare "not available" makes the model
          // retry blind names from a stale catalog forever.
          throw new Error(`skill "${requested}" is not available to this member. Available skills: ${availableHint()}. Only use names from this member's skill catalog.`)
        }
        if (originalExecute === undefined) throw new Error('skill tool is unavailable')
        return originalExecute.call(hostTool, args, exec)
      }
      const disposeShadow = registerTool.call(tools, shadow)
      // Fail closed at the real boundary: if the scoped registration did not
      // actually shadow the host tool, the host keeps publishing its full
      // catalog while the member silently runs with an unrestricted `skill`
      // tool. That is the exact prompt/tool mismatch this module exists to avoid.
      if (getTool.call(tools, 'skill', agent) !== shadow) {
        disposeShadow()
        throw new Error('agent-teams: member skill filter failed to shadow the host `skill` tool')
      }
      disposers.push(disposeShadow)
    }
  }

  // 2. Publish exactly ONE filtered catalog on every step, under our own
  //    source kind. Drop any host-owned `skill-catalog` message (empty, full,
  //    stale or inherited) and any previous copy of ours first.
  const published = new WeakMap<object, string>()
  const off = childCtx.on('agent/pre-step', async ({ agent: stepAgent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (stepAgent.id !== agent.id) return decision
    const snapshot = skills?.snapshot
    if (snapshot === undefined) return decision
    const cwd = await resolveCwd(childCtx, agent, signal)
    const observation = await snapshot.call(skills, { cwd, signal, scope: agent })
    const entries = filterSkillSummaries(observation.skills, allowedSkills, handoffSkillName).map(skill => ({
      name: skill.name,
      description: normalizeDescription(skill.description),
    }))
    // Catalog and tool guard share ONE authority, by construction.
    catalogNames = new Set(entries.map(entry => entry.name.toLowerCase()))
    const digest = digestEntries(entries)
    const retained = decision.messages.filter(message =>
      message.source.kind !== 'skill-catalog' && message.source.kind !== MEMBER_SKILL_CATALOG_KIND)
    const ownCatalog = decision.messages.find(message =>
      message.source.kind === MEMBER_SKILL_CATALOG_KIND)
    const previous = published.get(stepAgent)
    if (previous === digest && ownCatalog !== undefined) {
      return { ...decision, messages: [...retained, ownCatalog] }
    }
    published.set(stepAgent, digest)
    const catalog = createUserMessage({
      content: [{ type: 'text', text: renderCatalog(entries) }],
      source: { kind: MEMBER_SKILL_CATALOG_KIND, form: 'catalog', entries },
    })
    return { ...decision, messages: [...retained, catalog] }
  })
  disposers.push(off)

  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * Register the built-in `handoff` skill on ONE member's child context. The
 * provider is scoped to that agent, so only members see `handoff` — the captain
 * never gets it. A no-op when the child context has no skills registry.
 * @param childCtx - the member's child context (scope of the provider).
 * @returns a disposer that removes the provider.
 */
export function installMemberHandoffSkill(childCtx: Context): () => void {
  const skills = (childCtx as unknown as {
    skills?: { registerProvider?: (create: () => SkillProviderLike) => () => void }
  }).skills
  const register = skills?.registerProvider
  if (typeof register !== 'function') return () => undefined
  return register.call(skills, () => handoffSkillProvider())
}
