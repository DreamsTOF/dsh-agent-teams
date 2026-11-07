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
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';
/** Section-name prefix `mcp-client` uses for one server's instructions. */
export declare const MCP_SECTION_PREFIX = "mcp:";
/** Section name `mcp-resources` uses for its mounted-server list. */
export declare const MCP_RESOURCE_SECTION = "mcp-resource-servers";
/** The shared tools whose `server` argument addresses a mounted server. */
export declare const MCP_RESOURCE_TOOL_NAMES: readonly string[];
/**
 * Trim the JSON server-name list out of the `mcp-resource-servers` text.
 * Returns `''` when no allowed server remains (the section renders empty).
 */
export declare function trimResourceServersText(text: string, allowed: ReadonlySet<string>): string;
/**
 * Member-scoped `system-prompt/assemble` filter: drop every non-selected
 * `mcp:<server>` instruction section and trim `mcp-resource-servers` to the
 * selected servers. Non-MCP sections are untouched.
 * @param childCtx - the member's child context (scope of the listener).
 * @param agent - the member agent the filter belongs to.
 * @param allowedServers - the resolved MCP server allowlist (non-empty).
 * @returns a disposer that removes the listener.
 */
export declare function installMemberMcpInstructionsFilter(childCtx: Context, agent: Agent, allowedServers: readonly string[]): () => void;
/**
 * Shadow the shared MCP resource tools in the member scope so their `server`
 * argument is limited to the selected servers. A tool absent from the registry
 * is skipped; a disallowed server is rejected with the available list.
 * @param childCtx - the member's child context (scope of the registrations).
 * @param agent - the member agent the guard belongs to.
 * @param allowedServers - the resolved MCP server allowlist (non-empty).
 * @returns a disposer that removes every shadow registration.
 */
export declare function installMemberMcpResourceToolGuard(childCtx: Context, agent: Agent, allowedServers: readonly string[]): () => void;
/**
 * Install every member-scoped MCP derived-surface guard in one disposer:
 * the instruction/resource-list filter and the resource-tool argument guard.
 */
export declare function installMemberMcpFilter(childCtx: Context, agent: Agent, allowedServers: readonly string[]): () => void;
