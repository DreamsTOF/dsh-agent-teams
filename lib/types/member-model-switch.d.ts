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
import type { Context } from '@deepseek-ai/cordis';
import type { TeamMember, TeamState } from './types.ts';
/** Normalized provider/model/reasoningEffort triple written to the member. */
export interface MemberModelRoute {
    /** Registered LLM provider route. */
    provider: string;
    /** Provider-owned model id. */
    model: string;
    /** Adapter-owned reasoning effort, absent when the target has no explicit effort. */
    reasoningEffort?: string;
}
/** Arguments for {@link switchMemberModel}. */
export interface SwitchMemberModelInput {
    /** The caller's durable team record (the member must belong to it). */
    team: TeamState;
    /** The member whose runtime route is switched. */
    member: TeamMember;
    /** Target provider route. */
    provider: string;
    /** Target provider-owned model id. */
    model: string;
    /** Optional target reasoning effort; must be advertised by the target model. */
    reasoningEffort?: string;
}
/**
 * Outcome of a runtime model switch. Failures carry a readable message and
 * guarantee that neither the member record nor the host route was changed.
 */
export type MemberModelSwitchResult = {
    readonly ok: true;
    /** False when the request named the already-active route (no host write). */
    readonly changed: boolean;
    readonly route: MemberModelRoute;
    readonly member: TeamMember;
} | {
    readonly ok: false;
    readonly error: string;
};
/**
 * Pure state transition: point the member's current route at `route` and clear
 * any automatic-fallback marker (`activeProvider` / `activeModel` /
 * `fallbackActive`). The immutable first-spawn snapshot (`spawn*`) and every
 * other field are preserved untouched.
 * @param member - the member record to derive the next record from.
 * @param route - the validated route the user selected.
 * @returns a new member record; the input is not mutated.
 */
export declare function applyManualSwitch(member: TeamMember, route: MemberModelRoute): TeamMember;
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
export declare function switchMemberModel(ctx: Context, input: SwitchMemberModelInput): Promise<MemberModelSwitchResult>;
