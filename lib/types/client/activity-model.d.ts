/** Pure relationship projections used by the AgentTeams activity panel. */
/** Minimum task shape needed to derive dependency relationships. */
export interface RelationshipTask {
    readonly id: string;
    readonly dependencies: readonly string[];
    readonly depth: number;
}
/** One dependency-depth stage in stable display order. */
export interface RelationshipStage<T extends RelationshipTask> {
    readonly depth: number;
    readonly tasks: readonly T[];
}
/** Geometry used by the compact task DAG in the activity panel. */
export interface CompactDagNode<T extends RelationshipTask> {
    readonly task: T;
    readonly x: number;
    readonly y: number;
}
/** One dependency edge routed between two compact DAG nodes. */
export interface CompactDagEdge {
    readonly from: string;
    readonly to: string;
    readonly path: string;
}
/** Complete, scrollable compact DAG projection. */
export interface CompactDagLayout<T extends RelationshipTask> {
    readonly width: number;
    readonly height: number;
    readonly nodes: readonly CompactDagNode<T>[];
    readonly edges: readonly CompactDagEdge[];
}
/** Reference-panel geometry: narrow nodes with enough room for curved edges. */
export declare const COMPACT_DAG_NODE_WIDTH = 92;
export declare const COMPACT_DAG_NODE_HEIGHT = 30;
export declare const COMPACT_DAG_COLUMN_GAP = 26;
export declare const COMPACT_DAG_ROW_GAP = 8;
/** Compact `provider/model` route, or just the model when the provider is absent. */
export declare function memberRouteLabel(member: {
    readonly provider?: string;
    readonly model?: string;
} | undefined): string;
/**
 * Compact route shown on a running task. Prefer the task's own snapshot
 * field; fall back to the assignee member when older hosts omit it.
 */
export declare function taskModelLabel(task: {
    readonly model?: string;
    readonly assignee: string;
}, members: readonly {
    readonly name: string;
    readonly provider?: string;
    readonly model?: string;
}[]): string;
/** Short model id for tight DAG/chip surfaces (`openai/gpt-5.6-sol` → `gpt-5.6-sol`). */
export declare function compactModelLabel(route: string): string;
/** A live team the current captain still owns and has not halted. */
export declare function liveCaptainTeam<T extends {
    readonly captainSessionId: string;
    readonly halted?: boolean;
}>(teams: readonly T[], sessionId: string | undefined): T | undefined;
/** Minimal member shape needed to order the delegation list (issue #192). */
export interface MemberListEntry {
    readonly name: string;
    readonly activity?: string;
    readonly status?: string;
}
/** Minimal task shape needed to derive a member's finish time (issue #192). */
export interface MemberFinishTask {
    readonly assignee: string;
    readonly status: string;
    readonly updatedAt?: number;
}
/**
 * Latest terminal-task `updatedAt` owned by one member.
 * @param memberName - member whose owned tasks are scanned.
 * @param tasks - team tasks carrying durable `updatedAt` stamps.
 * @returns the newest terminal stamp, or undefined when the member owns none.
 */
export declare function memberFinishedAt(memberName: string, tasks: readonly MemberFinishTask[]): number | undefined;
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
export declare function orderDelegationMembers<TMember extends MemberListEntry>(members: readonly TMember[], tasks: readonly MemberFinishTask[]): readonly TMember[];
/** Whether the captain chat should keep showing the in-progress banner. */
export declare function teamIsActive(team: {
    readonly phase?: string;
    readonly halted?: boolean;
    readonly members: readonly {
        readonly status?: string;
        readonly activity?: string;
    }[];
    readonly tasks: readonly {
        readonly status: string;
    }[];
}): boolean;
/** Compact banner copy: running members, otherwise the current planning state. */
export declare function teamProgressSummary(team: {
    readonly members: readonly {
        readonly name: string;
        readonly status?: string;
        readonly activity?: string;
        readonly currentTask?: string;
    }[];
    readonly tasks: readonly {
        readonly id: string;
        readonly subject: string;
        readonly status: string;
    }[];
}, separator: string): {
    readonly working: number;
    readonly detail: string;
};
/** Use a fill-width grid when the task graph has no real dependency edges. */
export declare function usesParallelTaskGrid<T extends RelationshipTask>(tasks: readonly T[]): boolean;
/**
 * Whether an expanded activity panel still belongs to the current session.
 *
 * The panel is mounted in the root-scoped shell overlay, so React does not
 * remount it when the conversation route changes. Ownership keeps an expanded
 * panel from leaking onto the new-session screen (or another conversation)
 * while its local open state is being reset.
 */
export declare function activityPanelExpandedForSession(open: boolean, owner: string | undefined, current: string | undefined): boolean;
/** Inputs for deciding whether genuinely new live work may expand the panel. */
export interface ActivityPanelAutoExpandInput {
    readonly alreadyAutoOpened: boolean;
    readonly pageSettled: boolean;
    readonly restoreComplete: boolean;
    readonly previousLiveTeamIds: ReadonlySet<string>;
    readonly currentLiveTeamIds: readonly string[];
}
/**
 * Auto-expand only for live teams that appear after the current session's
 * initial restore pass. Replayed cards, archived teams, and live teams restored
 * while reopening a conversation must remain behind the collapsed badge.
 */
export declare function activityPanelShouldAutoExpand({ alreadyAutoOpened, pageSettled, restoreComplete, previousLiveTeamIds, currentLiveTeamIds, }: ActivityPanelAutoExpandInput): boolean;
/**
 * Resolve the task whose dependency chain should be highlighted.
 *
 * A pinned task is an explicit user choice. Keyboard focus takes precedence
 * over delayed pointer intent so an older hover timer cannot steal the active
 * chain from someone navigating the task map with the keyboard.
 */
export declare function dependencyFocusTaskId(pinnedTaskId: string | null, keyboardTaskId: string | null, hoverTaskId: string | null): string | null;
/** Group tasks by their precomputed dependency depth. */
export declare function taskStages<T extends RelationshipTask>(tasks: readonly T[]): readonly RelationshipStage<T>[];
/**
 * Lay tasks out as the reference panel's compact left-to-right DAG.
 *
 * Columns are dependency-depth stages. Rows are stable task-id order within
 * each stage. Edges use cubic curves so fan-in remains readable without
 * turning every task into a large card.
 */
export declare function compactDagLayout<T extends RelationshipTask>(tasks: readonly T[], dimensions?: {
    readonly nodeWidth: number;
    readonly nodeHeight: number;
    readonly columnGap: number;
    readonly rowGap: number;
}): CompactDagLayout<T>;
/**
 * Return the complete upstream/downstream chain around one task.
 *
 * Traversal uses both dependency directions and remains cycle-safe, so the UI
 * can highlight every handoff related to the focused task even if malformed
 * durable data contains a cycle.
 */
export declare function relatedTaskIds(taskId: string, tasks: readonly RelationshipTask[]): ReadonlySet<string>;
/**
 * Minimal member shape the activity panel reads from the host snapshot for
 * runtime route and quota display. The optional quota/fallback fields are
 * emitted by the host snapshot even though the base {@link ActivityMember}
 * transport type predates them.
 */
export interface MemberRuntimeView {
    readonly provider?: string;
    readonly model?: string;
    readonly reasoningEffort?: string;
    readonly activeProvider?: string;
    readonly activeModel?: string;
    readonly fallbackActive?: boolean;
    readonly status?: string;
    readonly activity?: string;
    readonly completedTasks?: number;
    readonly maxTasks?: number | null;
    readonly tokens?: number | null;
    readonly maxContextTokens?: number | null;
    readonly exhaustedReason?: string;
    readonly handoverPending?: boolean;
}
/**
 * Whether the member may switch its runtime model: only an idle (or `ready`)
 * member that is not currently running. `working`/`exhausted`/`removed` and a
 * live `working` activity all disable the control.
 */
export declare function memberModelSwitchable(member: Pick<MemberRuntimeView, 'status' | 'activity'>): boolean;
/** Whether the member is exhausted (status or a recorded quota reason). */
export declare function memberExhausted(member: Pick<MemberRuntimeView, 'status' | 'exhaustedReason'>): boolean;
/** Whether an automatic fallback route is currently active for the member. */
export declare function memberFallbackActive(member: Pick<MemberRuntimeView, 'fallbackActive' | 'activeProvider' | 'activeModel'>): boolean;
/**
 * Format a cumulative token count with a compact k/M/B suffix.
 * @param value - token count, or null/undefined when not measurable.
 * @returns e.g. `0`, `950`, `1.2k`, `3.4M`; `—` for a missing value.
 */
export declare function formatTokenCount(value: number | null | undefined): string;
/** `completed/max`, or just `completed` when the quota is unlimited (null). */
export declare function memberTaskQuotaValue(completed: number, max: number | null): string;
/** `used/max` token budget in compact notation, or just `used` when unlimited. */
export declare function memberTokenQuotaValue(tokens: number | null, max: number | null): string;
/** One selectable provider/model route with its reasoning-effort catalog. */
export interface ModelCatalogEffort {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
}
/** Flattened provider/model catalog entry used by the member model picker. */
export interface ModelCatalogEntry {
    readonly key: string;
    readonly provider: string;
    readonly providerName: string;
    readonly modelId: string;
    readonly modelName: string;
    readonly description?: string;
    readonly efforts: readonly ModelCatalogEffort[];
    readonly defaultEffort?: string;
}
/** Structural subset of the host model directory groups the picker reads. */
export interface ModelCatalogGroupLike {
    readonly id: string;
    readonly name: string;
    readonly models: readonly {
        readonly id: string;
        readonly name: string;
        readonly description?: string;
        readonly reasoning?: {
            readonly efforts: readonly ModelCatalogEffort[];
            readonly defaultEffort?: string;
        };
    }[];
}
/** Stable key for one provider/model route. */
export declare function modelCatalogRouteKey(provider: string, model: string): string;
/** Flatten the host model directory groups into selectable route entries. */
export declare function modelCatalogEntries(groups: readonly ModelCatalogGroupLike[]): readonly ModelCatalogEntry[];
/** Find one provider/model route in a flattened catalog. */
export declare function findModelCatalogEntry(entries: readonly ModelCatalogEntry[], provider: string, model: string): ModelCatalogEntry | undefined;
/**
 * Resolve the effort a picker should display: an empty/`default` request means
 * the model's own default; otherwise the requested id (even when unavailable).
 */
export declare function effectiveModelEffort(entry: ModelCatalogEntry | undefined, requested: string): string | undefined;
