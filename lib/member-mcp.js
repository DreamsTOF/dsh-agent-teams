/**
 * Member-scoped MCP derived-surface visibility (AgentTeams 0.2.0, §4.6).
 *
 * An MCP server leaves three derived surfaces beyond its tool schemas, and the
 * tool filter only governs the tool list:
 *
 * 1. `mcp:<server>` — the server's `instructions`, published as a GLOBAL
 *    `systemPrompt` section by `mcp-client` (`registerServerContext`).
 * 2. `mcp-resource-servers` — one GLOBAL section listing every mounted
 *    resource server (`mcp-resources`).
 * 3. `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`
 *    — shared tools whose `server` argument addresses ANY mounted server.
 *
 * A member selecting only server A must not see B's instructions, B in the
 * resource list, or be able to read B's resources. This module trims all three
 * at the member scope. Instructions and the resource list are transformed in a
 * scoped `system-prompt/assemble` listener; the resource tools are shadowed in
 * the member scope to validate the `server` argument.
 * @module dsh-agent-teams/member-mcp
 */
/** Section-name prefix `mcp-client` uses for one server's instructions. */
export const MCP_SECTION_PREFIX = 'mcp:';
/** Section name `mcp-resources` uses for its mounted-server list. */
export const MCP_RESOURCE_SECTION = 'mcp-resource-servers';
/** The shared tools whose `server` argument addresses a mounted server. */
export const MCP_RESOURCE_TOOL_NAMES = [
    'list_mcp_resources',
    'list_mcp_resource_templates',
    'read_mcp_resource',
];
/** Lowercased, non-empty set of allowed server names. */
function allowedSet(servers) {
    return new Set(servers.map(name => name.trim().toLowerCase()).filter(name => name !== ''));
}
/**
 * Trim the JSON server-name list out of the `mcp-resource-servers` text.
 * Returns `''` when no allowed server remains (the section renders empty).
 */
export function trimResourceServersText(text, allowed) {
    const match = /as the server argument:\s*(\[[^\]]*\])/.exec(text);
    const list = match?.[1];
    if (list === undefined)
        return text;
    let names;
    try {
        names = JSON.parse(list);
    }
    catch {
        return text;
    }
    if (!Array.isArray(names))
        return text;
    const kept = names.filter((name) => typeof name === 'string' && allowed.has(name.toLowerCase()));
    if (kept.length === 0)
        return '';
    if (kept.length === names.length)
        return text;
    return text.replace(list, JSON.stringify(kept));
}
/**
 * Member-scoped `system-prompt/assemble` filter: drop every non-selected
 * `mcp:<server>` instruction section and trim `mcp-resource-servers` to the
 * selected servers. Non-MCP sections are untouched.
 * @param childCtx - the member's child context (scope of the listener).
 * @param agent - the member agent the filter belongs to.
 * @param allowedServers - the resolved MCP server allowlist (non-empty).
 * @returns a disposer that removes the listener.
 */
export function installMemberMcpInstructionsFilter(childCtx, agent, allowedServers) {
    const allowed = allowedSet(allowedServers);
    const on = childCtx.on;
    void agent;
    return on.call(childCtx, 'system-prompt/assemble', async (_assembly, _context, next) => {
        const result = await next();
        const sections = result.sections;
        if (!Array.isArray(sections))
            return result;
        const kept = [];
        for (const section of sections) {
            const name = section?.name;
            if (typeof name === 'string' && name.startsWith(MCP_SECTION_PREFIX)) {
                if (!allowed.has(name.slice(MCP_SECTION_PREFIX.length).toLowerCase()))
                    continue;
                kept.push(section);
            }
            else if (name === MCP_RESOURCE_SECTION) {
                const text = typeof section.text === 'string' ? trimResourceServersText(section.text, allowed) : undefined;
                if (text === '')
                    continue;
                kept.push(text === undefined || text === section.text ? section : { ...section, text });
            }
            else {
                kept.push(section);
            }
        }
        return kept.length === sections.length ? result : { ...result, sections: kept };
    });
}
/**
 * Shadow the shared MCP resource tools in the member scope so their `server`
 * argument is limited to the selected servers. A tool absent from the registry
 * is skipped; a disallowed server is rejected with the available list.
 * @param childCtx - the member's child context (scope of the registrations).
 * @param agent - the member agent the guard belongs to.
 * @param allowedServers - the resolved MCP server allowlist (non-empty).
 * @returns a disposer that removes every shadow registration.
 */
export function installMemberMcpResourceToolGuard(childCtx, agent, allowedServers) {
    const allowed = allowedSet(allowedServers);
    const tools = childCtx.tools;
    const get = tools?.get;
    const register = tools?.register;
    if (typeof get !== 'function' || typeof register !== 'function')
        return () => undefined;
    const disposers = [];
    for (const name of MCP_RESOURCE_TOOL_NAMES) {
        const hostTool = get.call(tools, name, agent);
        if (hostTool === undefined)
            continue;
        const originalExecute = hostTool.execute;
        const shadow = { ...hostTool };
        shadow.execute = async (args, exec) => {
            const server = typeof args?.server === 'string'
                ? args.server
                : '';
            if (!allowed.has(server.trim().toLowerCase())) {
                throw new Error(`MCP resource server "${server}" is not available to this member. Available servers: ${[...allowed].sort().join(', ') || '(none)'}.`);
            }
            if (originalExecute === undefined)
                throw new Error('MCP resource tool is unavailable');
            return originalExecute.call(hostTool, args, exec);
        };
        disposers.push(register.call(tools, shadow));
    }
    return () => { for (const dispose of disposers)
        dispose(); };
}
/**
 * Install every member-scoped MCP derived-surface guard in one disposer:
 * the instruction/resource-list filter and the resource-tool argument guard.
 */
export function installMemberMcpFilter(childCtx, agent, allowedServers) {
    const disposeSections = installMemberMcpInstructionsFilter(childCtx, agent, allowedServers);
    const disposeTools = installMemberMcpResourceToolGuard(childCtx, agent, allowedServers);
    return () => { disposeTools(); disposeSections(); };
}
