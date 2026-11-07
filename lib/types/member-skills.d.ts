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
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'skill-catalog': {
            readonly kind: 'skill-catalog';
            readonly form: 'catalog';
            readonly update?: true;
            readonly incomplete?: true;
            readonly entries: readonly {
                readonly name: string;
                readonly description: string;
            }[];
        };
        'agent-teams:member-skills': {
            readonly kind: 'agent-teams:member-skills';
            readonly form: 'catalog';
            readonly entries: readonly {
                readonly name: string;
                readonly description: string;
            }[];
        };
    }
}
/** The always-visible handover skill name. */
export declare const HANDOFF_SKILL_NAME = "handoff";
/**
 * Source kind of the member skill catalog. Deliberately NOT `skill-catalog`:
 * host `tool-skill` owns that kind and deletes (or replaces) every message
 * carrying it whenever its own tool is shadowed. Reusing it meant the model
 * either saw no catalog at all or saw a full, unfiltered one while our tool
 * rejected those names. A distinct kind keeps our catalog out of the host's
 * catalog waterfall so the prompt and the tool stay in sync.
 */
export declare const MEMBER_SKILL_CATALOG_KIND = "agent-teams:member-skills";
/** Routing description surfaced in the filtered catalog. */
export declare const HANDOFF_SKILL_DESCRIPTION = "Write a handover document when a member reaches its task or token quota and must stop taking new work.";
/** Ranks below host providers so a real host `handoff` skill wins; this is a fallback. */
export declare const HANDOFF_SKILL_RANK = 1000;
/** Provider name returned by the built-in handoff skill provider. */
export declare const HANDOFF_SKILL_PROVIDER = "agent-teams-handoff";
/** Fixed handover document sections, in order. */
export declare const HANDOFF_SKILL_SECTIONS: readonly string[];
/** Minimal structural view of a skill summary (see `@deepseek-ai/dsh-skill`). */
export interface SkillSummaryLike {
    readonly name: string;
    readonly description: string;
    readonly invocation?: {
        readonly modelInvocable?: boolean;
        readonly userInvocable?: boolean;
    };
    readonly source?: string;
    readonly provider?: string;
}
/** Minimal structural view of a skill candidate contributed by a provider. */
export interface SkillCandidateLike extends SkillSummaryLike {
    readonly rank?: number;
    readonly locator?: unknown;
}
/** Minimal structural view of a loaded skill definition. */
export interface SkillDefinitionLike extends SkillSummaryLike {
    readonly content: string;
    readonly provider?: string;
}
/** Minimal structural view of a skill provider registered on `ctx.skills`. */
export interface SkillProviderLike {
    readonly name: string;
    list(options?: unknown): Promise<readonly SkillCandidateLike[]>;
    get(candidate: SkillCandidateLike, options?: unknown): Promise<SkillDefinitionLike | undefined>;
}
/** Build the fixed-section handover document template. */
export declare function handoffSkillBody(memberName?: string): string;
/**
 * Contribute the built-in `handoff` skill through `ctx.skills.registerProvider`.
 * It is a fallback: the high rank lets a host-provided `handoff` skill win.
 */
export declare function handoffSkillProvider(): SkillProviderLike;
/**
 * Merge the always-visible `handoff` skill into an allowlist.
 * `undefined` means "inherit all" and is returned untouched (nothing to add:
 * every visible skill, including `handoff`, is shown).
 */
export declare function mergeHandoffSkill(allowedSkills: readonly string[] | undefined, handoffSkillName?: string): string[] | undefined;
/**
 * Keep only the allowed skills plus `handoff`, and drop model-invisible ones.
 * `undefined` keeps every model-invocable skill (inherit all).
 */
export declare function filterSkillSummaries<T extends SkillSummaryLike>(summaries: readonly T[], allowedSkills: readonly string[] | undefined, handoffSkillName?: string): T[];
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
export declare function installMemberSkillFilter(childCtx: Context, agent: Agent, allowedSkills: readonly string[] | undefined, handoffSkillName?: string): () => void;
/**
 * Register the built-in `handoff` skill on ONE member's child context. The
 * provider is scoped to that agent, so only members see `handoff` — the captain
 * never gets it. A no-op when the child context has no skills registry.
 * @param childCtx - the member's child context (scope of the provider).
 * @returns a disposer that removes the provider.
 */
export declare function installMemberHandoffSkill(childCtx: Context): () => void;
