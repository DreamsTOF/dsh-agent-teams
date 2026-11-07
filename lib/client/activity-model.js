/** Pure relationship projections used by the AgentTeams activity panel. */
/** Reference-panel geometry: narrow nodes with enough room for curved edges. */
export const COMPACT_DAG_NODE_WIDTH = 92;
export const COMPACT_DAG_NODE_HEIGHT = 30;
export const COMPACT_DAG_COLUMN_GAP = 26;
export const COMPACT_DAG_ROW_GAP = 8;
/** Compact `provider/model` route, or just the model when the provider is absent. */
export function memberRouteLabel(member) {
    if (member === undefined)
        return '';
    const provider = member.provider?.trim() ?? '';
    const model = member.model?.trim() ?? '';
    if (provider !== '' && model !== '')
        return `${provider}/${model}`;
    return model;
}
/**
 * Compact route shown on a running task. Prefer the task's own snapshot
 * field; fall back to the assignee member when older hosts omit it.
 */
export function taskModelLabel(task, members) {
    const direct = task.model?.trim() ?? '';
    if (direct !== '')
        return direct;
    return memberRouteLabel(members.find((candidate) => candidate.name === task.assignee));
}
/** Short model id for tight DAG/chip surfaces (`openai/gpt-5.6-sol` → `gpt-5.6-sol`). */
export function compactModelLabel(route) {
    const trimmed = route.trim();
    if (trimmed === '')
        return '';
    const slash = trimmed.lastIndexOf('/');
    return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}
/** A live team the current captain still owns and has not halted. */
export function liveCaptainTeam(teams, sessionId) {
    const owner = sessionId?.trim() ?? '';
    if (owner === '')
        return undefined;
    return teams.find((team) => team.captainSessionId === owner && team.halted !== true);
}
/**
 * Latest terminal-task `updatedAt` owned by one member.
 * @param memberName - member whose owned tasks are scanned.
 * @param tasks - team tasks carrying durable `updatedAt` stamps.
 * @returns the newest terminal stamp, or undefined when the member owns none.
 */
export function memberFinishedAt(memberName, tasks) {
    let latest;
    for (const task of tasks) {
        if (task.assignee !== memberName)
            continue;
        if (task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled')
            continue;
        const stamp = task.updatedAt;
        if (typeof stamp !== 'number' || !Number.isFinite(stamp))
            continue;
        if (latest === undefined || stamp > latest)
            latest = stamp;
    }
    return latest;
}
/** Whether a member still has live work (running activity or an open task). */
function memberIsRunning(member, tasks) {
    if (member.activity === 'working' || member.status === 'working')
        return true;
    return tasks.some((task) => task.assignee === member.name
        && (task.status === 'pending' || task.status === 'claimed' || task.status === 'in_progress'));
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
export function orderDelegationMembers(members, tasks) {
    const running = [];
    const finishedStamped = [];
    const finishedUnstamped = [];
    members.forEach((member, index) => {
        if (memberIsRunning(member, tasks)) {
            running.push({ member, index });
            return;
        }
        const finishedAt = memberFinishedAt(member.name, tasks);
        if (finishedAt === undefined)
            finishedUnstamped.push({ member, index });
        else
            finishedStamped.push({ member, index, finishedAt });
    });
    finishedStamped.sort((left, right) => right.finishedAt - left.finishedAt || left.index - right.index);
    return [
        ...running,
        ...finishedStamped,
        ...finishedUnstamped,
    ].map((entry) => entry.member);
}
/** Whether the captain chat should keep showing the in-progress banner. */
export function teamIsActive(team) {
    if (team.halted === true || team.phase === 'staged')
        return false;
    if (team.members.some((member) => member.activity === 'working' || member.status === 'working'))
        return true;
    if (team.tasks.some((task) => task.status === 'pending' || task.status === 'claimed' || task.status === 'in_progress'))
        return true;
    return team.members.length > 0 && team.tasks.length === 0;
}
/** Compact banner copy: running members, otherwise the current planning state. */
export function teamProgressSummary(team, separator) {
    const workingMembers = team.members.filter((member) => member.activity === 'working' || member.status === 'working');
    const runningTasks = team.tasks.filter((task) => task.status === 'claimed' || task.status === 'in_progress');
    const labels = runningTasks.map((task) => task.subject.trim() || task.id).filter((label) => label !== '');
    if (workingMembers.length > 0 || labels.length > 0) {
        return {
            working: Math.max(workingMembers.length, labels.length),
            detail: labels.slice(0, 2).join(separator),
        };
    }
    if (team.tasks.length === 0)
        return { working: 0, detail: '' };
    return { working: 0, detail: '' };
}
/** Use a fill-width grid when the task graph has no real dependency edges. */
export function usesParallelTaskGrid(tasks) {
    if (tasks.length === 0)
        return false;
    const taskIds = new Set(tasks.map((task) => task.id));
    return tasks.every((task) => task.dependencies.every((dependency) => !taskIds.has(dependency)));
}
/**
 * Whether an expanded activity panel still belongs to the current session.
 *
 * The panel is mounted in the root-scoped shell overlay, so React does not
 * remount it when the conversation route changes. Ownership keeps an expanded
 * panel from leaking onto the new-session screen (or another conversation)
 * while its local open state is being reset.
 */
export function activityPanelExpandedForSession(open, owner, current) {
    return open && owner !== undefined && owner === current;
}
/**
 * Auto-expand only for live teams that appear after the current session's
 * initial restore pass. Replayed cards, archived teams, and live teams restored
 * while reopening a conversation must remain behind the collapsed badge.
 */
export function activityPanelShouldAutoExpand({ alreadyAutoOpened, pageSettled, restoreComplete, previousLiveTeamIds, currentLiveTeamIds, }) {
    return !alreadyAutoOpened
        && pageSettled
        && restoreComplete
        && currentLiveTeamIds.some((teamId) => !previousLiveTeamIds.has(teamId));
}
/**
 * Resolve the task whose dependency chain should be highlighted.
 *
 * A pinned task is an explicit user choice. Keyboard focus takes precedence
 * over delayed pointer intent so an older hover timer cannot steal the active
 * chain from someone navigating the task map with the keyboard.
 */
export function dependencyFocusTaskId(pinnedTaskId, keyboardTaskId, hoverTaskId) {
    return pinnedTaskId ?? keyboardTaskId ?? hoverTaskId;
}
/** Group tasks by their precomputed dependency depth. */
export function taskStages(tasks) {
    const byDepth = new Map();
    for (const task of tasks) {
        const depth = Number.isFinite(task.depth) ? Math.max(0, Math.floor(task.depth)) : 0;
        const stage = byDepth.get(depth) ?? [];
        stage.push(task);
        byDepth.set(depth, stage);
    }
    return [...byDepth.entries()]
        .sort(([left], [right]) => left - right)
        .map(([depth, stageTasks]) => ({
        depth,
        tasks: stageTasks.slice().sort((left, right) => left.id.localeCompare(right.id, 'en', { numeric: true })),
    }));
}
/**
 * Lay tasks out as the reference panel's compact left-to-right DAG.
 *
 * Columns are dependency-depth stages. Rows are stable task-id order within
 * each stage. Edges use cubic curves so fan-in remains readable without
 * turning every task into a large card.
 */
export function compactDagLayout(tasks, dimensions) {
    const nodeWidth = dimensions?.nodeWidth ?? COMPACT_DAG_NODE_WIDTH;
    const nodeHeight = dimensions?.nodeHeight ?? COMPACT_DAG_NODE_HEIGHT;
    const columnGap = dimensions?.columnGap ?? COMPACT_DAG_COLUMN_GAP;
    const rowGap = dimensions?.rowGap ?? COMPACT_DAG_ROW_GAP;
    const stages = taskStages(tasks);
    const positions = new Map();
    const nodes = [];
    for (const [column, stage] of stages.entries()) {
        for (const [row, task] of stage.tasks.entries()) {
            const x = column * (nodeWidth + columnGap);
            const y = row * (nodeHeight + rowGap);
            positions.set(task.id, { x, y });
            nodes.push({ task, x, y });
        }
    }
    const edges = [];
    for (const task of tasks) {
        const target = positions.get(task.id);
        if (target === undefined)
            continue;
        for (const dependency of task.dependencies) {
            const source = positions.get(dependency);
            if (source === undefined)
                continue;
            const x1 = source.x + nodeWidth;
            const y1 = source.y + nodeHeight / 2;
            const x2 = target.x;
            const y2 = target.y + nodeHeight / 2;
            edges.push({
                from: dependency,
                to: task.id,
                path: `M${x1} ${y1}C${x1 + 14} ${y1},${x2 - 14} ${y2},${x2} ${y2}`,
            });
        }
    }
    const rows = Math.max(1, ...stages.map((stage) => stage.tasks.length));
    return {
        width: stages.length === 0
            ? 0
            : stages.length * nodeWidth + (stages.length - 1) * columnGap,
        height: stages.length === 0
            ? 0
            : rows * nodeHeight + (rows - 1) * rowGap,
        nodes,
        edges,
    };
}
/**
 * Return the complete upstream/downstream chain around one task.
 *
 * Traversal uses both dependency directions and remains cycle-safe, so the UI
 * can highlight every handoff related to the focused task even if malformed
 * durable data contains a cycle.
 */
export function relatedTaskIds(taskId, tasks) {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    if (!byId.has(taskId))
        return new Set();
    const dependents = new Map();
    for (const task of tasks) {
        for (const dependency of task.dependencies) {
            const targets = dependents.get(dependency) ?? [];
            targets.push(task.id);
            dependents.set(dependency, targets);
        }
    }
    const related = new Set();
    const upstreamSeen = new Set();
    const downstreamSeen = new Set();
    const visitUpstream = (id) => {
        if (upstreamSeen.has(id))
            return;
        upstreamSeen.add(id);
        related.add(id);
        for (const dependency of byId.get(id)?.dependencies ?? [])
            visitUpstream(dependency);
    };
    const visitDownstream = (id) => {
        if (downstreamSeen.has(id))
            return;
        downstreamSeen.add(id);
        related.add(id);
        for (const dependent of dependents.get(id) ?? [])
            visitDownstream(dependent);
    };
    visitUpstream(taskId);
    visitDownstream(taskId);
    return related;
}
/** Member statuses that may switch model routes at runtime. */
const MEMBER_SWITCHABLE_STATUSES = new Set(['idle', 'ready']);
/**
 * Whether the member may switch its runtime model: only an idle (or `ready`)
 * member that is not currently running. `working`/`exhausted`/`removed` and a
 * live `working` activity all disable the control.
 */
export function memberModelSwitchable(member) {
    if (member.activity === 'working')
        return false;
    return MEMBER_SWITCHABLE_STATUSES.has(member.status ?? 'idle');
}
/** Whether the member is exhausted (status or a recorded quota reason). */
export function memberExhausted(member) {
    if (member.status === 'exhausted')
        return true;
    return member.exhaustedReason !== undefined && member.exhaustedReason.trim() !== '';
}
/** Whether an automatic fallback route is currently active for the member. */
export function memberFallbackActive(member) {
    if (member.fallbackActive === true)
        return true;
    return member.activeProvider !== undefined && member.activeModel !== undefined;
}
/**
 * Format a cumulative token count with a compact k/M/B suffix.
 * @param value - token count, or null/undefined when not measurable.
 * @returns e.g. `0`, `950`, `1.2k`, `3.4M`; `—` for a missing value.
 */
export function formatTokenCount(value) {
    if (value === null || value === undefined || !Number.isFinite(value))
        return '—';
    const n = Math.max(0, value);
    const trim = (scaled) => {
        const rounded = Math.round(scaled * 10) / 10;
        return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    };
    if (n < 1_000)
        return String(Math.round(n));
    if (n < 1_000_000)
        return `${trim(n / 1_000)}k`;
    if (n < 1_000_000_000)
        return `${trim(n / 1_000_000)}M`;
    return `${trim(n / 1_000_000_000)}B`;
}
/** `completed/max`, or just `completed` when the quota is unlimited (null). */
export function memberTaskQuotaValue(completed, max) {
    return max === null ? String(completed) : `${completed}/${max}`;
}
/** `used/max` token budget in compact notation, or just `used` when unlimited. */
export function memberTokenQuotaValue(tokens, max) {
    const used = formatTokenCount(tokens);
    return max === null ? used : `${used}/${formatTokenCount(max)}`;
}
/** Stable key for one provider/model route. */
export function modelCatalogRouteKey(provider, model) {
    return JSON.stringify([provider, model]);
}
/** Flatten the host model directory groups into selectable route entries. */
export function modelCatalogEntries(groups) {
    const entries = [];
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
            });
        }
    }
    return entries;
}
/** Find one provider/model route in a flattened catalog. */
export function findModelCatalogEntry(entries, provider, model) {
    const key = modelCatalogRouteKey(provider, model);
    return entries.find((entry) => entry.key === key);
}
/**
 * Resolve the effort a picker should display: an empty/`default` request means
 * the model's own default; otherwise the requested id (even when unavailable).
 */
export function effectiveModelEffort(entry, requested) {
    if (requested === '' || requested === 'default')
        return entry?.defaultEffort;
    return requested;
}
