/** Maximum fork-chain depth resolved for one identity (cycle- and length-bounded). */
export const LINEAGE_MAX_DEPTH = 32;
/**
 * Official optional service access. `ctx.get` is the reflection accessor for a
 * service a plugin does not declare in `inject`; a missing service yields
 * `undefined` instead of a contract error, and a getter that still refuses is
 * contained here.
 */
function optionalService(ctx, name) {
    const get = ctx.get;
    if (typeof get !== 'function')
        return undefined;
    try {
        return get.call(ctx, name);
    }
    catch {
        return undefined;
    }
}
/** Ancestry this process already resolved for one session. */
const ancestryCache = new Map();
/** The live session for one id: resident agent first, then the live session store. */
export function liveSession(ctx, id) {
    const branded = id;
    const agent = ctx.agents.get(branded);
    if (agent !== undefined)
        return agent.session;
    return optionalService(ctx, 'sessions')?.get?.(branded);
}
/** Whether one session is an ordinary top-level fork: seeded, not a subagent child, and at delegation depth zero. Identifies ordinary forks only; team identity never derives from it (ADR-0003). */
export function isTopLevelSession(session) {
    const header = session.header;
    return header.isSeeded === true && header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0;
}
/** Durable parent of one session id: the live header, else the stored header. */
async function durableParent(ctx, id) {
    const live = liveSession(ctx, id);
    if (live !== undefined)
        return live.header.parentSession;
    const persistence = optionalService(ctx, 'sessionPersistence');
    try {
        const snapshot = await persistence?.stat?.(id);
        const parent = snapshot?.header?.parentSession;
        return parent;
    }
    catch {
        // Unreadable stored metadata ends this chain; authorization then fails
        // closed on the identity the caller itself provides.
        return undefined;
    }
}
/**
 * Durable ancestry of one session, nearest first. The calling session's own
 * header supplies the first hop; later hops come from resident sessions or
 * stored headers, so a fork resolves through sessions that are not loaded.
 * @param ctx - the plugin context (injects `agents`).
 * @param session - the calling session.
 * @returns ancestor session ids, bounded by {@link LINEAGE_MAX_DEPTH}.
 */
export async function resolveAncestry(ctx, session) {
    const ancestry = [];
    const seen = new Set([session.id]);
    let parent = session.header.parentSession;
    while (parent !== undefined && ancestry.length < LINEAGE_MAX_DEPTH && !seen.has(parent)) {
        seen.add(parent);
        ancestry.push(parent);
        parent = await durableParent(ctx, parent);
    }
    ancestryCache.set(session.id, ancestry);
    return ancestry;
}
/**
 * Ancestry resolvable without awaiting: the calling session's durable first
 * hop, then resident sessions, then whatever the async resolver cached.
 */
export function sessionAncestry(ctx, session) {
    const cached = ancestryCache.get(session.id);
    if (cached !== undefined)
        return cached;
    const ancestry = [];
    const seen = new Set([session.id]);
    let parent = session.header.parentSession;
    while (parent !== undefined && ancestry.length < LINEAGE_MAX_DEPTH && !seen.has(parent)) {
        seen.add(parent);
        ancestry.push(parent);
        parent = liveSession(ctx, parent)?.header.parentSession;
    }
    return ancestry;
}
/** Resolve one session's lead identity synchronously (prompt-assembly path). */
export function leadIdentityOf(ctx, session) {
    return {
        sessionId: session.id,
        ancestry: sessionAncestry(ctx, session),
        inheritsLead: isTopLevelSession(session),
    };
}
/** Resolve one session's lead identity durably (authorization paths). */
export async function leadIdentityOfAsync(ctx, session) {
    return {
        sessionId: session.id,
        ancestry: await resolveAncestry(ctx, session),
        inheritsLead: isTopLevelSession(session),
    };
}
/**
 * Whether one identity leads a team: only the exact recorded captain session
 * leads it. A fork is an independent root and never inherits lead identity, so
 * `lead.ancestry` and `lead.inheritsLead` are deliberately ignored (ADR-0003).
 */
export function teamLeadMatch(team, lead) {
    const members = team.members ?? [];
    // A listed member is never a lead, retired or not: a member session is a
    // subagent child of its captain, and membership revocation must never hand
    // that session lead authority.
    if (members.some(member => member.id === lead.sessionId))
        return false;
    return team.captainSessionId === lead.sessionId;
}
/**
 * Whether one live session id leads a team: exactly the recorded captain, with
 * members excluded. A fork never inherits lead identity (ADR-0003).
 */
export function sessionLeadsTeam(ctx, team, sessionId) {
    if (team.members?.some(member => member.id === sessionId) === true)
        return false;
    return team.captainSessionId === sessionId;
}
/** Durable {@link sessionLeadsTeam}: exact captain id, members excluded (ADR-0003). */
export async function sessionLeadsTeamAsync(ctx, team, sessionId) {
    if (team.members?.some(member => member.id === sessionId) === true)
        return false;
    return team.captainSessionId === sessionId;
}
/**
 * Nearest live lead session of a team: the recorded captain, and only while it
 * is resident. A fork is an independent root and never receives
 * captain-directed reports (ADR-0003), so there is no fork fallback.
 * @param ctx - the plugin context (injects `agents`).
 * @param team - current team state.
 * @returns the live captain agent, or undefined when it is not resident.
 */
export function nearestLiveLead(ctx, team, live) {
    return ctx.agents.get(team.captainSessionId);
}
/**
 * Diagnostic note for a caller that matched no team but is a fork, so an
 * operator can distinguish "no team exists" from "a team exists that this
 * session does not lead".
 */
export function forkLineageNote(session) {
    const parent = session.header.parentSession;
    if (parent === undefined)
        return '';
    return ` (this session is a fork of ${parent}; no active team in this workspace is led by that session or by a lead session in its lineage)`;
}
