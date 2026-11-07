/**
 * Markdown + YAML member definitions (AgentTeams 0.2.0, requirement two).
 *
 * The Harness agent preset is a Cordis plugin composition, not a directory,
 * so this module owns the whole member-directory concept on the plugin side:
 *
 * - scan three top-level `*.md` directories, highest priority first:
 *   `<workspace>/.agents/agents` > `~/.dsh/agents` > `~/.agents/agents`;
 * - parse the YAML frontmatter and keep the Markdown body as the domain
 *   persona;
 * - resolve the `tools` / `skills` / `mcpServers` allowlists against the
 *   captain's live visibility (empty or wholly unmatched inherits everything,
 *   a partial match keeps only the matches);
 * - translate CodeBuddy tool names to DeepSeek Harness names, dropping the
 *   ones with no equivalent.
 *
 * Everything here is pure: it reads files and returns data plus diagnostics.
 * Wiring the result into a spawned member's `childCtx` is a later task.
 * @module dsh-agent-teams/member-definitions
 */
/** Which of the three directories a definition came from. */
export type MemberDefinitionSource = 'workspace' | 'dsh' | 'user';
/** One directory/parse/resolution observation. */
export interface MemberDefinitionDiagnostic {
    level: 'info' | 'warning' | 'error';
    /** Stable machine code, e.g. `overridden`, `unknown-tool`, `frontmatter`. */
    code: string;
    message: string;
    /** Absolute file/directory path the diagnostic is about, when known. */
    path?: string;
}
/** A parsed `*.md` definition before allowlist resolution. */
export interface MemberDefinition {
    /** Definition name: the frontmatter `name`, else the file name without `.md`. */
    name: string;
    description: string;
    /** `inherit` or an explicit model id. */
    model: string;
    provider?: string;
    reasoningEffort?: string;
    /** Requested tool names (already comma/array normalized), or undefined to inherit all. */
    tools?: string[];
    /** Requested skill names, or undefined to inherit all. */
    skills?: string[];
    /** Requested MCP server names, or undefined to inherit all. */
    mcpServers?: string[];
    maxTasks: number;
    maxContextTokens: number;
    enabled: boolean;
    /** Markdown body after the frontmatter; the default domain persona. */
    persona: string;
    source: MemberDefinitionSource;
    path: string;
    /** Lowercase hex sha256 of the raw definition bytes, for team.json snapshots. */
    contentHash: string;
    /** Per-file parse diagnostics collected while building this definition. */
    diagnostics: MemberDefinitionDiagnostic[];
}
/** Result of scanning the three directories. */
export interface ScanMemberDefinitionsResult {
    definitions: MemberDefinition[];
    diagnostics: MemberDefinitionDiagnostic[];
}
/** Injectable home directory so tests can exercise all three scopes. */
export interface ScanMemberDefinitionsOptions {
    homeDir?: string;
}
/** Captains' default completed-task quota; `0` means unlimited. */
export declare const DEFAULT_MAX_TASKS = 5;
/** Default cumulative token budget; `0` means unlimited. */
export declare const DEFAULT_MAX_CONTEXT_TOKENS = 200000000;
/** Definition default that keeps the captain's route. */
export declare const DEFAULT_MODEL = "inherit";
/** CodeBuddy tool name (lowercase) -> DeepSeek Harness tool name. */
export declare const CODEBUDDY_TOOL_MAP: Readonly<Record<string, string>>;
/** CodeBuddy names with no DeepSeek Harness equivalent: dropped with a warning. */
export declare const UNMAPPABLE_CODEBUDDY_TOOLS: readonly string[];
/** One resolved allowlist: what was asked for, what survived, and what did not. */
export interface ResolvedAllowlist {
    /** Requested names from the frontmatter; undefined means "inherit all". */
    requested: string[] | undefined;
    /** Concrete names to keep. When `inherits` is true this is the full visible universe. */
    resolved: string[];
    /** Requested names that could not be matched (or mapped). */
    unmatched: string[];
    /** The definition asks to inherit everything (empty input or all-unmatched fallback). */
    inherits: boolean;
    /** The fallback from a fully unmatched non-empty request (not a plain empty input). */
    fallback: boolean;
    /** Wildcard entries from `tools` (e.g. `browser-use:*`); kept as prompt-section patterns. */
    patterns?: string[];
}
/** Optional live universes used to resolve skills and MCP allowlists. */
export interface ResolveDefinitionOptions {
    /** Skill names visible to the captain. */
    captainVisibleSkills?: readonly string[];
    /** MCP server names currently mounted on the host. */
    mountedMcpServers?: readonly string[];
}
/** A definition after allowlist resolution, ready to seed a member. */
export interface ResolvedMemberDefinition {
    name: string;
    description: string;
    model: string;
    provider?: string;
    reasoningEffort?: string;
    persona: string;
    maxTasks: number;
    maxContextTokens: number;
    enabled: boolean;
    source: MemberDefinitionSource;
    path: string;
    contentHash: string;
    tools: ResolvedAllowlist;
    skills: ResolvedAllowlist;
    mcpServers: ResolvedAllowlist;
    /** Wildcard `tools` entries, reused to keep matching prompt-section names for the member. */
    sectionPatterns: string[];
    diagnostics: MemberDefinitionDiagnostic[];
}
/**
 * Scan the three member-definition directories.
 *
 * Only top-level `*.md` files are read. A missing directory is empty (no
 * error). A same-name definition keeps the highest-priority file and records
 * the lower ones as `overridden`. A YAML error affects only its own file: it
 * is reported and skipped, and the remaining files still load.
 * @param workspace - workspace root that owns the project-scope directory.
 * @param options - injectable `homeDir` for tests; defaults to `os.homedir()`.
 * @returns the winning definitions plus every scan/parse diagnostic.
 */
export declare function scanMemberDefinitions(workspace: string, options?: ScanMemberDefinitionsOptions): Promise<ScanMemberDefinitionsResult>;
/**
 * Resolve one definition into the member seed: concrete tool/skill/MCP
 * allowlists plus the persona, model route, quota, and diagnostics.
 * @param definition - a definition returned by {@link scanMemberDefinitions}.
 * @param captainVisibleTools - tool names the captain can currently see.
 * @param options - optional captain-visible skills and mounted MCP servers.
 */
export declare function resolveDefinition(definition: MemberDefinition, captainVisibleTools: readonly string[], options?: ResolveDefinitionOptions): ResolvedMemberDefinition;
/** Parse the MCP server name out of a host tool name `mcp__<server>__<tool>`. */
export declare function mcpServerOfToolName(name: string): string | undefined;
/** Distinct mounted MCP servers derivable from visible tool names. */
export declare function mountedMcpServerNames(visibleToolNames: readonly string[]): string[];
/**
 * Final tool allow list for a member definition under orthogonal semantics:
 * `tools` gates the explicit (non-MCP) tools — empty/absent inherits all — and
 * `mcpServers` opens EVERY tool of each named server (a server with N tools
 * opens all N) — empty/absent inherits every mounted server. The result is
 * `tools ∪ (all tools of the selected servers)`, so a definition with 3 tools
 * plus one 10-tool MCP server grants 13 tools.
 *
 * Returns `{ allow: undefined, restricted: false }` when neither allowlist
 * restricts the member, meaning no tool filter should be installed.
 */
export declare function resolveMemberToolAllow(options: {
    tools: ResolvedAllowlist;
    mcpServers: ResolvedAllowlist;
    captainVisibleTools: readonly string[];
    baseAllow?: readonly string[] | undefined;
}): {
    allow: string[] | undefined;
    restricted: boolean;
};
/** Captain-facing view of a member definition: just the name and a one-line description. */
export interface MemberDefinitionSummary {
    readonly name: string;
    readonly description: string;
}
/** Reduce raw definitions to the captain-facing summary (name + trimmed description). */
export declare function summarizeMemberDefinitions(definitions: readonly {
    readonly name: string;
    readonly description?: string;
}[]): MemberDefinitionSummary[];
