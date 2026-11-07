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
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';
/** Section-name prefix every tool-guidance section uses. */
export declare const TOOL_SECTION_PREFIX = "tool:";
/**
 * Compile name-pattern whitelists into anchored regexes. `*` is a wildcard
 * (matching any run of characters), so `browser-use:*` becomes
 * `^(?:browser-use:.*)$` and matches every section starting with
 * `browser-use:`. Real regex syntax is otherwise preserved. Invalid patterns
 * are skipped so a typo never aborts a member spawn.
 */
export declare function compileSectionWhitelist(patterns: readonly string[] | undefined): RegExp[];
/** Whether a section name matches any whitelist pattern. */
export declare function matchesSectionWhitelist(name: string, whitelist: readonly RegExp[]): boolean;
/**
 * Install a member-scoped `system-prompt/assemble` filter that drops every
 * `tool:<name>` guidance section whose tool is not visible to the member.
 * @param childCtx - the member's child context (scope of the listener).
 * @param agent - the member agent the filter belongs to.
 * @returns a disposer that removes the listener.
 */
export declare function installMemberToolGuidanceFilter(childCtx: Context, agent: Agent, whitelist?: readonly RegExp[]): () => void;
