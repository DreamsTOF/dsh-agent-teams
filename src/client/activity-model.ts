/** Pure relationship projections used by the AgentTeams activity panel. */

/** Minimum task shape needed to derive dependency relationships. */
export interface RelationshipTask {
  readonly id: string
  readonly dependencies: readonly string[]
  readonly depth: number
}

/** One dependency-depth stage in stable display order. */
export interface RelationshipStage<T extends RelationshipTask> {
  readonly depth: number
  readonly tasks: readonly T[]
}

/** Geometry used by the compact task DAG in the activity panel. */
export interface CompactDagNode<T extends RelationshipTask> {
  readonly task: T
  readonly x: number
  readonly y: number
}

/** One dependency edge routed between two compact DAG nodes. */
export interface CompactDagEdge {
  readonly from: string
  readonly to: string
  readonly path: string
}

/** Complete, scrollable compact DAG projection. */
export interface CompactDagLayout<T extends RelationshipTask> {
  readonly width: number
  readonly height: number
  readonly nodes: readonly CompactDagNode<T>[]
  readonly edges: readonly CompactDagEdge[]
}

/** Reference-panel geometry: narrow nodes with enough room for curved edges. */
export const COMPACT_DAG_NODE_WIDTH = 92
export const COMPACT_DAG_NODE_HEIGHT = 30
export const COMPACT_DAG_COLUMN_GAP = 26
export const COMPACT_DAG_ROW_GAP = 8

/** Compact `provider/model` route, or just the model when the provider is absent. */
export function memberRouteLabel(member: { readonly provider?: string; readonly model?: string } | undefined): string {
  if (member === undefined) return ''
  const provider = member.provider?.trim() ?? ''
  const model = member.model?.trim() ?? ''
  if (provider !== '' && model !== '') return `${provider}/${model}`
  return model
}

/**
 * Compact route shown on a running task. Prefer the task's own snapshot
 * field; fall back to the assignee member when older hosts omit it.
 */
export function taskModelLabel(
  task: { readonly model?: string; readonly assignee: string },
  members: readonly { readonly name: string; readonly provider?: string; readonly model?: string }[],
): string {
  const direct = task.model?.trim() ?? ''
  if (direct !== '') return direct
  return memberRouteLabel(members.find((candidate) => candidate.name === task.assignee))
}

/** Short model id for tight DAG/chip surfaces (`openai/gpt-5.6-sol` → `gpt-5.6-sol`). */
export function compactModelLabel(route: string): string {
  const trimmed = route.trim()
  if (trimmed === '') return ''
  const slash = trimmed.lastIndexOf('/')
  return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}

/** A live team the current captain still owns and has not halted. */
export function liveCaptainTeam<T extends { readonly captainSessionId: string; readonly halted?: boolean }>(
  teams: readonly T[],
  sessionId: string | undefined,
): T | undefined {
  const owner = sessionId?.trim() ?? ''
  if (owner === '') return undefined
  return teams.find((team) => team.captainSessionId === owner && team.halted !== true)
}

/** Minimal member shape needed to order the delegation list (issue #192). */
export interface MemberListEntry {
  readonly name: string
  readonly activity?: string
  readonly status?: string
}

/** Minimal task shape needed to derive a member's finish time (issue #192). */
export interface MemberFinishTask {
  readonly assignee: string
  readonly status: string
  readonly updatedAt?: number
}

/**
 * Latest terminal-task `updatedAt` owned by one member.
 * @param memberName - member whose owned tasks are scanned.
 * @param tasks - team tasks carrying durable `updatedAt` stamps.
 * @returns the newest terminal stamp, or undefined when the member owns none.
 */
export function memberFinishedAt(
  memberName: string,
  tasks: readonly MemberFinishTask[],
): number | undefined {
  let latest: number | undefined
  for (const task of tasks) {
    if (task.assignee !== memberName) continue
    if (task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled') continue
    const stamp = task.updatedAt
    if (typeof stamp !== 'number' || !Number.isFinite(stamp)) continue
    if (latest === undefined || stamp > latest) latest = stamp
  }
  return latest
}

/** Whether a member still has live work (running activity or an open task). */
function memberIsRunning(
  member: MemberListEntry,
  tasks: readonly MemberFinishTask[],
): boolean {
  if (member.activity === 'working' || member.status === 'working') return true
  return tasks.some((task) => task.assignee === member.name
    && (task.status === 'pending' || task.status === 'claimed' || task.status === 'in_progress'))
}

/**
 * Order the delegation member list for issue #192.
 *
 * Running members keep their incoming relative order and come first; finished
 * members follow sorted by finish time, newest first. Members without a
 * derivable finish time keep their incoming relative order after the stamped
 * ones, so an older host that omits stamps never reorders them randomly.
 * @param members - delegation roster in snapshot order.
 * @param tasks - team tasks carrying durable `updatedAt` stamps.
 * @returns the members in display order.
 */
export function orderDelegationMembers<TMember extends MemberListEntry>(
  members: readonly TMember[],
  tasks: readonly MemberFinishTask[],
): readonly TMember[] {
  const running: { member: TMember; index: number }[] = []
  const finishedStamped: { member: TMember; index: number; finishedAt: number }[] = []
  const finishedUnstamped: { member: TMember; index: number }[] = []
  members.forEach((member, index) => {
    if (memberIsRunning(member, tasks)) {
      running.push({ member, index })
      return
    }
    const finishedAt = memberFinishedAt(member.name, tasks)
    if (finishedAt === undefined) finishedUnstamped.push({ member, index })
    else finishedStamped.push({ member, index, finishedAt })
  })
  finishedStamped.sort((left, right) => right.finishedAt - left.finishedAt || left.index - right.index)
  return [
    ...running,
    ...finishedStamped,
    ...finishedUnstamped,
  ].map((entry) => entry.member)
}

/** Whether the captain chat should keep showing the in-progress banner. */
export function teamIsActive(team: {
  readonly phase?: string
  readonly halted?: boolean
  readonly members: readonly { readonly status?: string; readonly activity?: string }[]
  readonly tasks: readonly { readonly status: string }[]
}): boolean {
  if (team.halted === true || team.phase === 'staged') return false
  if (team.members.some((member) => member.activity === 'working' || member.status === 'working')) return true
  if (team.tasks.some((task) => task.status === 'pending' || task.status === 'claimed' || task.status === 'in_progress')) return true
  return team.members.length > 0 && team.tasks.length === 0
}

/** Compact banner copy: running members, otherwise the current planning state. */
export function teamProgressSummary(
  team: {
    readonly members: readonly { readonly name: string; readonly status?: string; readonly activity?: string; readonly currentTask?: string }[]
    readonly tasks: readonly { readonly id: string; readonly subject: string; readonly status: string }[]
  },
  separator: string,
): { readonly working: number; readonly detail: string } {
  const workingMembers = team.members.filter((member) => member.activity === 'working' || member.status === 'working')
  const runningTasks = team.tasks.filter((task) => task.status === 'claimed' || task.status === 'in_progress')
  const labels = runningTasks.map((task) => task.subject.trim() || task.id).filter((label) => label !== '')
  if (workingMembers.length > 0 || labels.length > 0) {
    return {
      working: Math.max(workingMembers.length, labels.length),
      detail: labels.slice(0, 2).join(separator),
    }
  }
  if (team.tasks.length === 0) return { working: 0, detail: '' }
  return { working: 0, detail: '' }
}

/** Use a fill-width grid when the task graph has no real dependency edges. */
export function usesParallelTaskGrid<T extends RelationshipTask>(tasks: readonly T[]): boolean {
  if (tasks.length === 0) return false
  const taskIds = new Set(tasks.map((task) => task.id))
  return tasks.every((task) => task.dependencies.every((dependency) => !taskIds.has(dependency)))
}

/**
 * Whether an expanded activity panel still belongs to the current session.
 *
 * The panel is mounted in the root-scoped shell overlay, so React does not
 * remount it when the conversation route changes. Ownership keeps an expanded
 * panel from leaking onto the new-session screen (or another conversation)
 * while its local open state is being reset.
 */
export function activityPanelExpandedForSession(
  open: boolean,
  owner: string | undefined,
  current: string | undefined,
): boolean {
  return open && owner !== undefined && owner === current
}

/** Inputs for deciding whether genuinely new live work may expand the panel. */
export interface ActivityPanelAutoExpandInput {
  readonly alreadyAutoOpened: boolean
  readonly pageSettled: boolean
  readonly restoreComplete: boolean
  readonly previousLiveTeamIds: ReadonlySet<string>
  readonly currentLiveTeamIds: readonly string[]
}

/**
 * Auto-expand only for live teams that appear after the current session's
 * initial restore pass. Replayed cards, archived teams, and live teams restored
 * while reopening a conversation must remain behind the collapsed badge.
 */
export function activityPanelShouldAutoExpand({
  alreadyAutoOpened,
  pageSettled,
  restoreComplete,
  previousLiveTeamIds,
  currentLiveTeamIds,
}: ActivityPanelAutoExpandInput): boolean {
  return !alreadyAutoOpened
    && pageSettled
    && restoreComplete
    && currentLiveTeamIds.some((teamId) => !previousLiveTeamIds.has(teamId))
}

/**
 * Resolve the task whose dependency chain should be highlighted.
 *
 * A pinned task is an explicit user choice. Keyboard focus takes precedence
 * over delayed pointer intent so an older hover timer cannot steal the active
 * chain from someone navigating the task map with the keyboard.
 */
export function dependencyFocusTaskId(
  pinnedTaskId: string | null,
  keyboardTaskId: string | null,
  hoverTaskId: string | null,
): string | null {
  return pinnedTaskId ?? keyboardTaskId ?? hoverTaskId
}

/** Group tasks by their precomputed dependency depth. */
export function taskStages<T extends RelationshipTask>(tasks: readonly T[]): readonly RelationshipStage<T>[] {
  const byDepth = new Map<number, T[]>()
  for (const task of tasks) {
    const depth = Number.isFinite(task.depth) ? Math.max(0, Math.floor(task.depth)) : 0
    const stage = byDepth.get(depth) ?? []
    stage.push(task)
    byDepth.set(depth, stage)
  }
  return [...byDepth.entries()]
    .sort(([left], [right]) => left - right)
    .map(([depth, stageTasks]) => ({
      depth,
      tasks: stageTasks.slice().sort((left, right) => left.id.localeCompare(right.id, 'en', { numeric: true })),
    }))
}

/**
 * Lay tasks out as the reference panel's compact left-to-right DAG.
 *
 * Columns are dependency-depth stages. Rows are stable task-id order within
 * each stage. Edges use cubic curves so fan-in remains readable without
 * turning every task into a large card.
 */
export function compactDagLayout<T extends RelationshipTask>(tasks: readonly T[], dimensions?: {
  readonly nodeWidth: number; readonly nodeHeight: number; readonly columnGap: number; readonly rowGap: number
}): CompactDagLayout<T> {
  const nodeWidth = dimensions?.nodeWidth ?? COMPACT_DAG_NODE_WIDTH
  const nodeHeight = dimensions?.nodeHeight ?? COMPACT_DAG_NODE_HEIGHT
  const columnGap = dimensions?.columnGap ?? COMPACT_DAG_COLUMN_GAP
  const rowGap = dimensions?.rowGap ?? COMPACT_DAG_ROW_GAP
  const stages = taskStages(tasks)
  const positions = new Map<string, { x: number; y: number }>()
  const nodes: CompactDagNode<T>[] = []
  for (const [column, stage] of stages.entries()) {
    for (const [row, task] of stage.tasks.entries()) {
      const x = column * (nodeWidth + columnGap)
      const y = row * (nodeHeight + rowGap)
      positions.set(task.id, { x, y })
      nodes.push({ task, x, y })
    }
  }
  const edges: CompactDagEdge[] = []
  for (const task of tasks) {
    const target = positions.get(task.id)
    if (target === undefined) continue
    for (const dependency of task.dependencies) {
      const source = positions.get(dependency)
      if (source === undefined) continue
      const x1 = source.x + nodeWidth
      const y1 = source.y + nodeHeight / 2
      const x2 = target.x
      const y2 = target.y + nodeHeight / 2
      edges.push({
        from: dependency,
        to: task.id,
        path: `M${x1} ${y1}C${x1 + 14} ${y1},${x2 - 14} ${y2},${x2} ${y2}`,
      })
    }
  }
  const rows = Math.max(1, ...stages.map((stage) => stage.tasks.length))
  return {
    width: stages.length === 0
      ? 0
      : stages.length * nodeWidth + (stages.length - 1) * columnGap,
    height: stages.length === 0
      ? 0
      : rows * nodeHeight + (rows - 1) * rowGap,
    nodes,
    edges,
  }
}

/**
 * Return the complete upstream/downstream chain around one task.
 *
 * Traversal uses both dependency directions and remains cycle-safe, so the UI
 * can highlight every handoff related to the focused task even if malformed
 * durable data contains a cycle.
 */
export function relatedTaskIds(taskId: string, tasks: readonly RelationshipTask[]): ReadonlySet<string> {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  if (!byId.has(taskId)) return new Set()
  const dependents = new Map<string, string[]>()
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      const targets = dependents.get(dependency) ?? []
      targets.push(task.id)
      dependents.set(dependency, targets)
    }
  }
  const related = new Set<string>()
  const upstreamSeen = new Set<string>()
  const downstreamSeen = new Set<string>()
  const visitUpstream = (id: string): void => {
    if (upstreamSeen.has(id)) return
    upstreamSeen.add(id)
    related.add(id)
    for (const dependency of byId.get(id)?.dependencies ?? []) visitUpstream(dependency)
  }
  const visitDownstream = (id: string): void => {
    if (downstreamSeen.has(id)) return
    downstreamSeen.add(id)
    related.add(id)
    for (const dependent of dependents.get(id) ?? []) visitDownstream(dependent)
  }
  visitUpstream(taskId)
  visitDownstream(taskId)
  return related
}

/**
 * Minimal member shape the activity panel reads from the host snapshot for
 * runtime route and quota display. The optional quota/fallback fields are
 * emitted by the host snapshot even though the base {@link ActivityMember}
 * transport type predates them.
 */
export interface MemberRuntimeView {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly activeProvider?: string
  readonly activeModel?: string
  readonly fallbackActive?: boolean
  readonly status?: string
  readonly activity?: string
  readonly completedTasks?: number
  readonly maxTasks?: number | null
  readonly tokens?: number | null
  readonly maxContextTokens?: number | null
  readonly exhaustedReason?: string
  readonly handoverPending?: boolean
}

/** Member statuses that may switch model routes at runtime. */
const MEMBER_SWITCHABLE_STATUSES: ReadonlySet<string> = new Set(['idle', 'ready'])

/**
 * Whether the member may switch its runtime model: only an idle (or `ready`)
 * member that is not currently running. `working`/`exhausted`/`removed` and a
 * live `working` activity all disable the control.
 */
export function memberModelSwitchable(member: Pick<MemberRuntimeView, 'status' | 'activity'>): boolean {
  if (member.activity === 'working') return false
  return MEMBER_SWITCHABLE_STATUSES.has(member.status ?? 'idle')
}

/** Whether the member is exhausted (status or a recorded quota reason). */
export function memberExhausted(member: Pick<MemberRuntimeView, 'status' | 'exhaustedReason'>): boolean {
  if (member.status === 'exhausted') return true
  return member.exhaustedReason !== undefined && member.exhaustedReason.trim() !== ''
}

/** Whether an automatic fallback route is currently active for the member. */
export function memberFallbackActive(
  member: Pick<MemberRuntimeView, 'fallbackActive' | 'activeProvider' | 'activeModel'>,
): boolean {
  if (member.fallbackActive === true) return true
  return member.activeProvider !== undefined && member.activeModel !== undefined
}

/**
 * Format a cumulative token count with a compact k/M/B suffix.
 * @param value - token count, or null/undefined when not measurable.
 * @returns e.g. `0`, `950`, `1.2k`, `3.4M`; `—` for a missing value.
 */
export function formatTokenCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const n = Math.max(0, value)
  const trim = (scaled: number): string => {
    const rounded = Math.round(scaled * 10) / 10
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
  }
  if (n < 1_000) return String(Math.round(n))
  if (n < 1_000_000) return `${trim(n / 1_000)}k`
  if (n < 1_000_000_000) return `${trim(n / 1_000_000)}M`
  return `${trim(n / 1_000_000_000)}B`
}

/** `completed/max`, or just `completed` when the quota is unlimited (null). */
export function memberTaskQuotaValue(completed: number, max: number | null): string {
  return max === null ? String(completed) : `${completed}/${max}`
}

/** `used/max` token budget in compact notation, or just `used` when unlimited. */
export function memberTokenQuotaValue(tokens: number | null, max: number | null): string {
  const used = formatTokenCount(tokens)
  return max === null ? used : `${used}/${formatTokenCount(max)}`
}

/** One selectable provider/model route with its reasoning-effort catalog. */
export interface ModelCatalogEffort {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** Flattened provider/model catalog entry used by the member model picker. */
export interface ModelCatalogEntry {
  readonly key: string
  readonly provider: string
  readonly providerName: string
  readonly modelId: string
  readonly modelName: string
  readonly description?: string
  readonly efforts: readonly ModelCatalogEffort[]
  readonly defaultEffort?: string
}

/** Structural subset of the host model directory groups the picker reads. */
export interface ModelCatalogGroupLike {
  readonly id: string
  readonly name: string
  readonly models: readonly {
    readonly id: string
    readonly name: string
    readonly description?: string
    readonly reasoning?: {
      readonly efforts: readonly ModelCatalogEffort[]
      readonly defaultEffort?: string
    }
  }[]
}

/** Stable key for one provider/model route. */
export function modelCatalogRouteKey(provider: string, model: string): string {
  return JSON.stringify([provider, model])
}

/** Flatten the host model directory groups into selectable route entries. */
export function modelCatalogEntries(
  groups: readonly ModelCatalogGroupLike[],
): readonly ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = []
  for (const group of groups) {
    for (const model of group.models) {
      entries.push({
        key: modelCatalogRouteKey(group.id, model.id),
        provider: group.id,
        providerName: group.name,
        modelId: model.id,
        modelName: model.name,
        ...model.description === undefined ? {} : { description: model.description },
        efforts: model.reasoning?.efforts ?? [],
        ...model.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort },
      })
    }
  }
  return entries
}

/** Find one provider/model route in a flattened catalog. */
export function findModelCatalogEntry(
  entries: readonly ModelCatalogEntry[],
  provider: string,
  model: string,
): ModelCatalogEntry | undefined {
  const key = modelCatalogRouteKey(provider, model)
  return entries.find((entry) => entry.key === key)
}

/**
 * Resolve the effort a picker should display: an empty/`default` request means
 * the model's own default; otherwise the requested id (even when unavailable).
 */
export function effectiveModelEffort(entry: ModelCatalogEntry | undefined, requested: string): string | undefined {
  if (requested === '' || requested === 'default') return entry?.defaultEffort
  return requested
}
