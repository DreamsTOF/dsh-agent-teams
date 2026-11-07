/**
 * Runtime member model switching.
 *
 * Updates one idle member's effective provider/model/reasoningEffort without
 * touching the immutable spawn snapshot (`spawn*`) or the host subagent
 * descriptor. Validation reads the live LLM catalogs (`ctx.llm`) and the host
 * applies the new route from the member's next model step through
 * `ctx.agents.get(member.id).model.select()`.
 *
 * Design: docs/upgrade-0.2.0 (requirement one) and
 * docs/adr/0001-member-runtime-model-switching.md.
 * @module dsh-agent-teams/member-model-switch
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TeamMember, TeamState } from './types.ts'

/** Normalized provider/model/reasoningEffort triple written to the member. */
export interface MemberModelRoute {
  /** Registered LLM provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort, absent when the target has no explicit effort. */
  reasoningEffort?: string
}

/** Arguments for {@link switchMemberModel}. */
export interface SwitchMemberModelInput {
  /** The caller's durable team record (the member must belong to it). */
  team: TeamState
  /** The member whose runtime route is switched. */
  member: TeamMember
  /** Target provider route. */
  provider: string
  /** Target provider-owned model id. */
  model: string
  /** Optional target reasoning effort; must be advertised by the target model. */
  reasoningEffort?: string
}

/**
 * Outcome of a runtime model switch. Failures carry a readable message and
 * guarantee that neither the member record nor the host route was changed.
 */
export type MemberModelSwitchResult =
  | {
      readonly ok: true
      /** False when the request named the already-active route (no host write). */
      readonly changed: boolean
      readonly route: MemberModelRoute
      readonly member: TeamMember
    }
  | { readonly ok: false; readonly error: string }

/** Member lifecycle statuses that may switch models at runtime. */
const SWITCHABLE_MEMBER_STATUSES: ReadonlySet<string> = new Set(['idle', 'ready'])

/** Build the failure variant. */
function errorResult(error: string): MemberModelSwitchResult {
  return { ok: false, error }
}

/** Render at most `limit` ids for an error message. */
function sampleIds(ids: readonly string[], limit = 8): string {
  const head = ids.slice(0, limit)
  return `${head.join(', ')}${ids.length > limit ? ', …' : ''}`
}

/**
 * Pure state transition: point the member's current route at `route` and clear
 * any automatic-fallback marker (`activeProvider` / `activeModel` /
 * `fallbackActive`). The immutable first-spawn snapshot (`spawn*`) and every
 * other field are preserved untouched.
 * @param member - the member record to derive the next record from.
 * @param route - the validated route the user selected.
 * @returns a new member record; the input is not mutated.
 */
export function applyManualSwitch(member: TeamMember, route: MemberModelRoute): TeamMember {
  const next: TeamMember = { ...member, provider: route.provider, model: route.model }
  if (route.reasoningEffort === undefined) delete next.reasoningEffort
  else next.reasoningEffort = route.reasoningEffort
  // A manual choice always replaces automatic fallback state; the fallback
  // route config itself stays so a later failure can still switch again.
  delete next.activeProvider
  delete next.activeModel
  delete next.fallbackActive
  return next
}

/** Resolve the member record inside the team, preferring object identity. */
function teamMemberRecord(team: TeamState, member: TeamMember): TeamMember | undefined {
  if (team.members.includes(member)) return member
  if (member.id === '') return undefined
  return team.members.find(candidate => candidate.id === member.id)
}

/** Validate the provider is registered and the model belongs to its catalog. */
async function validateProviderAndModel(
  ctx: Context,
  provider: string,
  model: string,
): Promise<string | undefined> {
  const listProviders = ctx.llm.listProviders
  if (typeof listProviders === 'function') {
    const providers = listProviders.call(ctx.llm)
    // A non-empty registry is authoritative; an empty one is advisory because
    // some adapters only materialize routes on demand.
    if (providers.length > 0 && !providers.some(candidate => candidate.id === provider)) {
      return `unknown provider "${provider}" (registered: ${sampleIds(providers.map(candidate => candidate.id))})`
    }
  }
  let catalog
  try {
    catalog = await ctx.llm.listModels(provider)
  } catch (error: unknown) {
    return `cannot list models for provider "${provider}": ${error instanceof Error ? error.message : String(error)}`
  }
  // Catalog membership is advisory for an empty catalog (dynamic adapters),
  // but a non-empty catalog is authoritative enough to reject a typo.
  if (catalog.length > 0 && !catalog.some(candidate => candidate.id === model)) {
    return `unknown model "${model}" for provider "${provider}" (available: ${sampleIds(catalog.map(candidate => candidate.id))})`
  }
  return undefined
}

/** Validate a requested reasoning effort against the target model's capability. */
async function validateReasoningEffort(
  ctx: Context,
  provider: string,
  model: string,
  reasoningEffort: string,
): Promise<string | undefined> {
  let info
  try {
    info = await ctx.llm.resolveModelInfo(provider, model)
  } catch (error: unknown) {
    return `cannot resolve model "${provider}/${model}": ${error instanceof Error ? error.message : String(error)}`
  }
  const efforts = info.reasoning?.efforts ?? []
  if (efforts.length === 0) {
    return `model "${provider}/${model}" does not advertise selectable reasoning efforts`
  }
  if (!efforts.some(effort => String(effort.id) === reasoningEffort)) {
    return `model "${provider}/${model}" does not support reasoning effort "${reasoningEffort}"`
      + ` (supported: ${sampleIds(efforts.map(effort => String(effort.id)))})`
  }
  return undefined
}

/**
 * Switch one member's runtime model route after validating it against the live
 * LLM catalogs.
 *
 * Only an idle member of a non-halted team may switch: a member whose durable
 * status is `working`/`exhausted`/`removed`, or whose live agent is `running`,
 * is rejected without queueing or interrupting its turn. On success the host is
 * told the new route for the member's next model step and the durable member
 * record is updated in place (the caller persists the team). All validation
 * happens before any mutation, so a rejected request never leaves a partial
 * write. Re-submitting the already-active route is a no-op (`changed: false`).
 * @param ctx - plugin context exposing the LLM catalogs and the agent registry.
 * @param input - team, member, and the requested provider/model/reasoningEffort.
 * @returns the switched member, or a readable error with no side effects.
 */
export async function switchMemberModel(
  ctx: Context,
  input: SwitchMemberModelInput,
): Promise<MemberModelSwitchResult> {
  const { team } = input
  if (team.halted === true) {
    return errorResult(`team "${team.name.trim() === '' ? team.id : team.name}" is halted; resume the team before switching member models`)
  }

  const member = teamMemberRecord(team, input.member)
  if (member === undefined) {
    return errorResult(`member "${input.member.name}" does not belong to team "${team.id}"`)
  }

  const status = String(member.status)
  if (!SWITCHABLE_MEMBER_STATUSES.has(status)) {
    if (status === 'working') {
      return errorResult(`member "${member.name}" is working; wait until its current task finishes before switching models`)
    }
    return errorResult(`member "${member.name}" is ${status}; models can only be switched while the member is idle`)
  }

  if (member.id === '') {
    return errorResult(`member "${member.name}" has not been spawned yet; edit the staged plan instead of switching its runtime model`)
  }

  const agent = ctx.agents.get(member.id as SessionId)
  if (agent === undefined) {
    return errorResult(`member "${member.name}" has no live agent session to switch`)
  }
  if (agent.status === 'running') {
    return errorResult(`member "${member.name}" is running; wait until its current task finishes before switching models`)
  }

  const provider = input.provider?.trim() ?? ''
  const model = input.model?.trim() ?? ''
  const trimmedEffort = input.reasoningEffort?.trim()
  const reasoningEffort = trimmedEffort === undefined || trimmedEffort === '' ? undefined : trimmedEffort
  if (provider === '') return errorResult('provider must not be empty')
  if (model === '') return errorResult('model must not be empty')

  const routeError = await validateProviderAndModel(ctx, provider, model)
  if (routeError !== undefined) return errorResult(routeError)

  if (reasoningEffort !== undefined) {
    const effortError = await validateReasoningEffort(ctx, provider, model, reasoningEffort)
    if (effortError !== undefined) return errorResult(effortError)
  }

  const route: MemberModelRoute = {
    provider,
    model,
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
  }

  // Idempotent: the same active route with no fallback in effect is a no-op so
  // a repeated submission records no extra host selection. A lingering fallback
  // still counts as a change because a manual choice must clear it.
  const fallbackPending = member.fallbackActive === true
    || member.activeProvider !== undefined
    || member.activeModel !== undefined
  const sameEffort = (member.reasoningEffort ?? undefined) === (route.reasoningEffort ?? undefined)
  if (member.provider === route.provider && member.model === route.model && sameEffort && !fallbackPending) {
    return { ok: true, changed: false, route, member }
  }

  const selection: ModelSelection = {
    provider: route.provider,
    model: route.model,
    ...route.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: route.reasoningEffort as ReasoningEffortId },
  }
  try {
    agent.model.select(selection)
  } catch (error: unknown) {
    return errorResult(`the host refused to select "${route.provider}/${route.model}": ${error instanceof Error ? error.message : String(error)}`)
  }

  const next = applyManualSwitch(member, route)
  const index = team.members.indexOf(member)
  team.members[index] = next
  return { ok: true, changed: true, route, member: next }
}
