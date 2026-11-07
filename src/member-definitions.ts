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

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import * as YAML from 'yaml'
import { CAPTAIN_TOOL_NAMES, MEMBER_TOOL_NAMES } from './tool-names.ts'

/** Which of the three directories a definition came from. */
export type MemberDefinitionSource = 'workspace' | 'dsh' | 'user'

/** One directory/parse/resolution observation. */
export interface MemberDefinitionDiagnostic {
  level: 'info' | 'warning' | 'error'
  /** Stable machine code, e.g. `overridden`, `unknown-tool`, `frontmatter`. */
  code: string
  message: string
  /** Absolute file/directory path the diagnostic is about, when known. */
  path?: string
}

/** A parsed `*.md` definition before allowlist resolution. */
export interface MemberDefinition {
  /** Definition name: the frontmatter `name`, else the file name without `.md`. */
  name: string
  description: string
  /** `inherit` or an explicit model id. */
  model: string
  provider?: string
  reasoningEffort?: string
  /** Requested tool names (already comma/array normalized), or undefined to inherit all. */
  tools?: string[]
  /** Requested skill names, or undefined to inherit all. */
  skills?: string[]
  /** Requested MCP server names, or undefined to inherit all. */
  mcpServers?: string[]
  maxTasks: number
  maxContextTokens: number
  enabled: boolean
  /** Markdown body after the frontmatter; the default domain persona. */
  persona: string
  source: MemberDefinitionSource
  path: string
  /** Lowercase hex sha256 of the raw definition bytes, for team.json snapshots. */
  contentHash: string
  /** Per-file parse diagnostics collected while building this definition. */
  diagnostics: MemberDefinitionDiagnostic[]
}

/** Result of scanning the three directories. */
export interface ScanMemberDefinitionsResult {
  definitions: MemberDefinition[]
  diagnostics: MemberDefinitionDiagnostic[]
}

/** Injectable home directory so tests can exercise all three scopes. */
export interface ScanMemberDefinitionsOptions {
  homeDir?: string
}

/** Captains' default completed-task quota; `0` means unlimited. */
export const DEFAULT_MAX_TASKS = 5
/** Default cumulative token budget; `0` means unlimited. */
export const DEFAULT_MAX_CONTEXT_TOKENS = 200_000_000
/** Definition default that keeps the captain's route. */
export const DEFAULT_MODEL = 'inherit'

/** CodeBuddy tool name (lowercase) -> DeepSeek Harness tool name. */
export const CODEBUDDY_TOOL_MAP: Readonly<Record<string, string>> = Object.freeze({
  read_file: 'read',
  write_to_file: 'write',
  replace_in_file: 'edit',
  search_file: 'glob',
  list_dir: 'glob',
  search_content: 'grep',
  execute_command: 'pwsh',
  web_search: 'web_search',
  web_fetch: 'web_fetch',
  use_skill: 'skill',
  send_message: 'agent_teams_send_message',
  read_rules: 'read',
})

/** CodeBuddy names with no DeepSeek Harness equivalent: dropped with a warning. */
export const UNMAPPABLE_CODEBUDDY_TOOLS: readonly string[] = [
  'read_lints',
  'lsp',
  'delete_file',
  'preview_url',
  'connect_cloud_service',
  'mcp_get_tool_description',
  'mcp_call_tool',
  'automation_update',
  'task',
]

/** One resolved allowlist: what was asked for, what survived, and what did not. */
export interface ResolvedAllowlist {
  /** Requested names from the frontmatter; undefined means "inherit all". */
  requested: string[] | undefined
  /** Concrete names to keep. When `inherits` is true this is the full visible universe. */
  resolved: string[]
  /** Requested names that could not be matched (or mapped). */
  unmatched: string[]
  /** The definition asks to inherit everything (empty input or all-unmatched fallback). */
  inherits: boolean
  /** The fallback from a fully unmatched non-empty request (not a plain empty input). */
  fallback: boolean
}

/** Optional live universes used to resolve skills and MCP allowlists. */
export interface ResolveDefinitionOptions {
  /** Skill names visible to the captain. */
  captainVisibleSkills?: readonly string[]
  /** MCP server names currently mounted on the host. */
  mountedMcpServers?: readonly string[]
}

/** A definition after allowlist resolution, ready to seed a member. */
export interface ResolvedMemberDefinition {
  name: string
  description: string
  model: string
  provider?: string
  reasoningEffort?: string
  persona: string
  maxTasks: number
  maxContextTokens: number
  enabled: boolean
  source: MemberDefinitionSource
  path: string
  contentHash: string
  tools: ResolvedAllowlist
  skills: ResolvedAllowlist
  mcpServers: ResolvedAllowlist
  diagnostics: MemberDefinitionDiagnostic[]
}

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/** Trim, drop blanks, and de-duplicate names case-insensitively, keeping first-seen spelling. */
function dedupeNames(names: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of names) {
    const name = raw.trim()
    if (name === '') continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(name)
  }
  return result
}

/** Coerce one frontmatter value to a trimmed string, or undefined when absent/empty. */
function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

/** Split a comma-separated string or a YAML string array into a de-duplicated name list. */
function parseNameList(
  value: unknown,
  field: string,
  diagnostics: MemberDefinitionDiagnostic[],
): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (Array.isArray(value)) {
    const names = value
      .map(item => (typeof item === 'string' ? item : String(item)))
      .filter(item => item.trim() !== '')
    const deduped = dedupeNames(names)
    return deduped.length === 0 ? undefined : deduped
  }
  if (typeof value === 'string') {
    const deduped = dedupeNames(value.split(','))
    return deduped.length === 0 ? undefined : deduped
  }
  diagnostics.push({
    level: 'warning',
    code: 'invalid-field',
    message: `field "${field}" must be a comma-separated string or a string array; ignored`,
  })
  return undefined
}

/** Parse a non-negative integer field, falling back with a warning when invalid. */
function parseInteger(
  value: unknown,
  field: string,
  fallback: number,
  diagnostics: MemberDefinitionDiagnostic[],
): number {
  if (value === undefined || value === null) return fallback
  const parsed = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    diagnostics.push({
      level: 'warning',
      code: 'invalid-field',
      message: `field "${field}" must be a non-negative integer; using ${fallback}`,
    })
    return fallback
  }
  return parsed
}

/** Parse a boolean field with the common truthy/falsy spellings, falling back when invalid. */
function parseBoolean(
  value: unknown,
  field: string,
  fallback: boolean,
  diagnostics: MemberDefinitionDiagnostic[],
): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  const text = String(value).trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(text)) return true
  if (['false', '0', 'no', 'off'].includes(text)) return false
  diagnostics.push({
    level: 'warning',
    code: 'invalid-field',
    message: `field "${field}" must be a boolean; using ${fallback}`,
  })
  return fallback
}

/** Split frontmatter from body; throws a readable error on malformed input. */
function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const normalized = text.startsWith('\uFEFF') ? text.slice(1) : text
  if (!normalized.startsWith('---')) return { data: {}, body: normalized }
  const match = FRONTMATTER.exec(normalized)
  if (match === null) throw new Error('frontmatter starts with "---" but has no closing "---"')
  const rawYaml = match[1] ?? ''
  let parsed: unknown
  try {
    parsed = YAML.parse(rawYaml)
  } catch (error: unknown) {
    throw new Error(`invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`)
  }
  const body = normalized.slice(match[0].length)
  if (parsed === null || parsed === undefined) return { data: {}, body }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('frontmatter must be a YAML mapping')
  }
  return { data: parsed as Record<string, unknown>, body }
}

/** Build one definition from raw file text; returns undefined when the file is unparseable. */
function buildDefinition(
  text: string,
  filePath: string,
  source: MemberDefinitionSource,
  sink: MemberDefinitionDiagnostic[],
): MemberDefinition | undefined {
  const local: MemberDefinitionDiagnostic[] = []
  let split: { data: Record<string, unknown>; body: string }
  try {
    split = splitFrontmatter(text)
  } catch (error: unknown) {
    sink.push({
      level: 'error',
      code: 'frontmatter',
      path: filePath,
      message: `${basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`,
    })
    return undefined
  }
  const data = split.data
  const fallbackName = basename(filePath).replace(/\.md$/i, '').trim()
  const name = optionalString(data.name) ?? (fallbackName === '' ? 'unnamed' : fallbackName)
  const provider = optionalString(data.provider)
  const reasoningEffort = optionalString(data.reasoningEffort)
  const definition: MemberDefinition = {
    name,
    description: optionalString(data.description) ?? '',
    model: optionalString(data.model) ?? DEFAULT_MODEL,
    ...(provider === undefined ? {} : { provider }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    tools: parseNameList(data.tools, 'tools', local),
    skills: parseNameList(data.skills, 'skills', local),
    mcpServers: parseNameList(data.mcpServers, 'mcpServers', local),
    maxTasks: parseInteger(data.maxTasks, 'maxTasks', DEFAULT_MAX_TASKS, local),
    maxContextTokens: parseInteger(data.maxContextTokens, 'maxContextTokens', DEFAULT_MAX_CONTEXT_TOKENS, local),
    enabled: parseBoolean(data.enabled, 'enabled', true, local),
    persona: split.body.trim(),
    source,
    path: filePath,
    contentHash: createHash('sha256').update(text, 'utf8').digest('hex'),
    diagnostics: local,
  }
  sink.push(...local)
  return definition
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
export async function scanMemberDefinitions(
  workspace: string,
  options: ScanMemberDefinitionsOptions = {},
): Promise<ScanMemberDefinitionsResult> {
  const home = options.homeDir ?? homedir()
  const dirs: ReadonlyArray<{ dir: string; source: MemberDefinitionSource }> = [
    { dir: join(workspace, '.agents', 'agents'), source: 'workspace' },
    { dir: join(home, '.dsh', 'agents'), source: 'dsh' },
    { dir: join(home, '.agents', 'agents'), source: 'user' },
  ]
  const diagnostics: MemberDefinitionDiagnostic[] = []
  const winners = new Map<string, MemberDefinition>()
  const definitions: MemberDefinition[] = []
  for (const { dir, source } of dirs) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      diagnostics.push({
        level: 'warning',
        code: 'scan-failed',
        path: dir,
        message: `could not read member definition directory ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      })
      continue
    }
    const files = entries
      .filter(entry => entry.isFile() && /\.md$/i.test(entry.name))
      .map(entry => entry.name)
      .sort()
    for (const fileName of files) {
      const filePath = join(dir, fileName)
      let text: string
      try {
        text = await readFile(filePath, 'utf8')
      } catch (error: unknown) {
        diagnostics.push({
          level: 'error',
          code: 'read-failed',
          path: filePath,
          message: `could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        })
        continue
      }
      const definition = buildDefinition(text, filePath, source, diagnostics)
      if (definition === undefined) continue
      if (!definition.enabled) {
        diagnostics.push({
          level: 'info',
          code: 'disabled-definition',
          path: filePath,
          message: `definition "${definition.name}" is disabled and was skipped`,
        })
        continue
      }
      const key = definition.name.toLowerCase()
      const winner = winners.get(key)
      if (winner !== undefined) {
        diagnostics.push({
          level: 'warning',
          code: 'overridden',
          path: filePath,
          message: `definition "${definition.name}" at ${source} scope is overridden by the higher-priority ${winner.source} definition at ${winner.path}`,
        })
        continue
      }
      winners.set(key, definition)
      definitions.push(definition)
    }
  }
  return { definitions, diagnostics }
}

/** The tools a member inherits: every captain-visible tool except captain-only ones, plus coordination. */
function inheritedMemberTools(captainVisibleTools: readonly string[]): string[] {
  const captainOnly = new Set(CAPTAIN_TOOL_NAMES.map(name => name.toLowerCase()))
  const result: string[] = []
  const seen = new Set<string>()
  const push = (name: string): void => {
    const key = name.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    result.push(name)
  }
  for (const name of captainVisibleTools) {
    if (captainOnly.has(name.toLowerCase())) continue
    push(name)
  }
  for (const name of MEMBER_TOOL_NAMES) push(name)
  return result
}

/** Map one requested tool name to a DSH name, or flag it unmappable. */
function mapToolName(raw: string): { name: string; mapped: boolean; unmappable: boolean } {
  const key = raw.trim().toLowerCase()
  if (Object.hasOwn(CODEBUDDY_TOOL_MAP, key)) {
    return { name: CODEBUDDY_TOOL_MAP[key] as string, mapped: true, unmappable: false }
  }
  if (UNMAPPABLE_CODEBUDDY_TOOLS.includes(key)) {
    return { name: raw.trim(), mapped: false, unmappable: true }
  }
  return { name: raw.trim(), mapped: false, unmappable: false }
}

/** Resolve the tool allowlist against the captain's live tool visibility. */
function resolveTools(
  requested: string[] | undefined,
  captainVisibleTools: readonly string[],
  diagnostics: MemberDefinitionDiagnostic[],
): ResolvedAllowlist {
  const inherited = inheritedMemberTools(captainVisibleTools)
  if (requested === undefined || requested.length === 0) {
    return { requested: undefined, resolved: inherited, unmatched: [], inherits: true, fallback: false }
  }
  const captain = new Map(captainVisibleTools.map(name => [name.toLowerCase(), name]))
  const captainOnly = new Set(CAPTAIN_TOOL_NAMES.map(name => name.toLowerCase()))
  const resolved: string[] = []
  const unmatched: string[] = []
  const seen = new Set<string>()
  const push = (name: string): void => {
    const key = name.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    resolved.push(name)
  }
  for (const raw of requested) {
    const mapping = mapToolName(raw)
    if (mapping.unmappable) {
      diagnostics.push({
        level: 'warning',
        code: 'unknown-tool',
        message: `tool "${raw.trim()}" has no DeepSeek Harness equivalent and was dropped`,
      })
      unmatched.push(raw)
      continue
    }
    const candidate = mapping.name
    if (captainOnly.has(candidate.toLowerCase())) {
      diagnostics.push({
        level: 'warning',
        code: 'captain-only-tool',
        message: `tool "${raw.trim()}" maps to captain-only "${candidate}" and was dropped`,
      })
      unmatched.push(raw)
      continue
    }
    const actual = captain.get(candidate.toLowerCase())
    if (actual === undefined) {
      diagnostics.push({
        level: 'warning',
        code: 'unavailable-tool',
        message: `tool "${raw.trim()}"${mapping.mapped ? ` (mapped to "${candidate}")` : ''} is not visible to the captain and was dropped`,
      })
      unmatched.push(raw)
      continue
    }
    push(actual)
  }
  if (resolved.length === 0) {
    diagnostics.push({
      level: 'warning',
      code: 'tools-fallback',
      message: 'no requested tool matched; inheriting all captain-visible tools',
    })
    return { requested, resolved: inherited, unmatched, inherits: true, fallback: true }
  }
  for (const name of MEMBER_TOOL_NAMES) push(name)
  return { requested, resolved, unmatched, inherits: false, fallback: false }
}

/**
 * Resolve a name allowlist (skills or MCP servers) against an optional universe.
 * Without a universe the request is kept verbatim (it cannot be checked here).
 */
function resolveAllowlist(
  requested: string[] | undefined,
  universe: readonly string[] | undefined,
  label: string,
  codePrefix: string,
  diagnostics: MemberDefinitionDiagnostic[],
): ResolvedAllowlist {
  if (requested === undefined || requested.length === 0) {
    return { requested: undefined, resolved: universe === undefined ? [] : [...universe], unmatched: [], inherits: true, fallback: false }
  }
  if (universe === undefined) {
    return { requested, resolved: dedupeNames(requested), unmatched: [], inherits: false, fallback: false }
  }
  const available = new Map(universe.map(name => [name.toLowerCase(), name]))
  const resolved: string[] = []
  const unmatched: string[] = []
  const seen = new Set<string>()
  for (const raw of requested) {
    const actual = available.get(raw.trim().toLowerCase())
    if (actual === undefined) {
      unmatched.push(raw)
      diagnostics.push({
        level: 'warning',
        code: `${codePrefix}-unknown`,
        message: `${label} "${raw.trim()}" is not available and was dropped`,
      })
      continue
    }
    const key = actual.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    resolved.push(actual)
  }
  if (resolved.length === 0) {
    diagnostics.push({
      level: 'warning',
      code: `${codePrefix}-fallback`,
      message: `no requested ${label} matched; inheriting all available ${label}`,
    })
    return { requested, resolved: [...universe], unmatched, inherits: true, fallback: true }
  }
  return { requested, resolved, unmatched, inherits: false, fallback: false }
}

/**
 * Resolve one definition into the member seed: concrete tool/skill/MCP
 * allowlists plus the persona, model route, quota, and diagnostics.
 * @param definition - a definition returned by {@link scanMemberDefinitions}.
 * @param captainVisibleTools - tool names the captain can currently see.
 * @param options - optional captain-visible skills and mounted MCP servers.
 */
export function resolveDefinition(
  definition: MemberDefinition,
  captainVisibleTools: readonly string[],
  options: ResolveDefinitionOptions = {},
): ResolvedMemberDefinition {
  const diagnostics: MemberDefinitionDiagnostic[] = [...definition.diagnostics]
  const tools = resolveTools(definition.tools, captainVisibleTools, diagnostics)
  const skills = resolveAllowlist(definition.skills, options.captainVisibleSkills, 'skill', 'skill', diagnostics)
  const mcpServers = resolveAllowlist(definition.mcpServers, options.mountedMcpServers, 'MCP server', 'mcp', diagnostics)
  return {
    name: definition.name,
    description: definition.description,
    model: definition.model,
    ...(definition.provider === undefined ? {} : { provider: definition.provider }),
    ...(definition.reasoningEffort === undefined ? {} : { reasoningEffort: definition.reasoningEffort }),
    persona: definition.persona,
    maxTasks: definition.maxTasks,
    maxContextTokens: definition.maxContextTokens,
    enabled: definition.enabled,
    source: definition.source,
    path: definition.path,
    contentHash: definition.contentHash,
    tools,
    skills,
    mcpServers,
    diagnostics,
  }
}
