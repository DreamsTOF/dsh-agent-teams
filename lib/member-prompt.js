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
/** Section-name prefix every tool-guidance section uses. */
export const TOOL_SECTION_PREFIX = 'tool:';
/**
 * Compile name-pattern whitelists into anchored regexes. `*` is a wildcard
 * (matching any run of characters), so `browser-use:*` becomes
 * `^(?:browser-use:.*)$` and matches every section starting with
 * `browser-use:`. Real regex syntax is otherwise preserved. Invalid patterns
 * are skipped so a typo never aborts a member spawn.
 */
export function compileSectionWhitelist(patterns) {
    if (patterns === undefined)
        return [];
    const compiled = [];
    for (const pattern of patterns) {
        const trimmed = pattern.trim();
        if (trimmed === '')
            continue;
        try {
            compiled.push(new RegExp(`^(?:${trimmed.replace(/\*/g, '.*')})$`));
        }
        catch {
            // An invalid pattern is skipped rather than failing the spawn.
        }
    }
    return compiled;
}
/** Whether a section name matches any whitelist pattern. */
export function matchesSectionWhitelist(name, whitelist) {
    return whitelist.some(regex => regex.test(name));
}
/**
 * Install a member-scoped `system-prompt/assemble` filter that drops every
 * `tool:<name>` guidance section whose tool is not visible to the member.
 * @param childCtx - the member's child context (scope of the listener).
 * @param agent - the member agent the filter belongs to.
 * @returns a disposer that removes the listener.
 */
export function installMemberToolGuidanceFilter(childCtx, agent, whitelist = []) {
    const tools = childCtx.tools;
    const get = tools?.get;
    const on = childCtx.on;
    if (typeof get !== 'function' || typeof on !== 'function')
        return () => undefined;
    return on.call(childCtx, 'system-prompt/assemble', async (_assembly, _context, next) => {
        const result = await next();
        const sections = result.sections;
        if (!Array.isArray(sections))
            return result;
        const kept = sections.filter((section) => {
            const name = section?.name;
            if (typeof name !== 'string')
                return true;
            if (matchesSectionWhitelist(name, whitelist))
                return true;
            if (!name.startsWith(TOOL_SECTION_PREFIX))
                return true;
            return get.call(tools, name.slice(TOOL_SECTION_PREFIX.length), agent) !== undefined;
        });
        return kept.length === sections.length ? result : { ...result, sections: kept };
    });
}
