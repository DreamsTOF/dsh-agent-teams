/**
 * Durable session lineage for team identity (ADR-0003).
 *
 * DSH 0.2.2 forks do not record `header.parentSession`, and a fork is an
 * independent root conversation: it never inherits the lead of the team its
 * source session led. Team identity is therefore the exact recorded
 * `captainSessionId`; the `parentSession` chain is never read as a lead
 * relationship. `isTopLevelSession` only recognises an ordinary fork (seeded,
 * non-subagent, delegation depth zero) and never grants team membership.
 *
 * A member is a subagent child of its captain, so a member session id is
 * excluded from lead identity outright: membership revocation must never hand
 * a member session the captain's authority.
 *
 * @module dsh-agent-teams/lineage
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';
/** Maximum fork-chain depth resolved for one identity (cycle- and length-bounded). */
export declare const LINEAGE_MAX_DEPTH = 32;
/** One calling session's durable identity as the team lookups need it. */
export interface LeadIdentity {
    /** The calling session id. */
    readonly sessionId: string;
    /** Ancestor session ids reachable through `header.parentSession`, nearest first. Diagnostic only: team identity is exact captainSessionId (ADR-0003). */
    readonly ancestry: readonly string[];
    /** Whether this session is an ordinary top-level fork. Diagnostic only; never grants team lead identity (ADR-0003). */
    readonly inheritsLead: boolean;
}
/** The live session for one id: resident agent first, then the live session store. */
export declare function liveSession(ctx: Context, id: string): Session | undefined;
/** Whether one session is an ordinary top-level fork: seeded, not a subagent child, and at delegation depth zero. Identifies ordinary forks only; team identity never derives from it (ADR-0003). */
export declare function isTopLevelSession(session: Session): boolean;
/**
 * Durable ancestry of one session, nearest first. The calling session's own
 * header supplies the first hop; later hops come from resident sessions or
 * stored headers, so a fork resolves through sessions that are not loaded.
 * @param ctx - the plugin context (injects `agents`).
 * @param session - the calling session.
 * @returns ancestor session ids, bounded by {@link LINEAGE_MAX_DEPTH}.
 */
export declare function resolveAncestry(ctx: Context, session: Session): Promise<readonly string[]>;
/**
 * Ancestry resolvable without awaiting: the calling session's durable first
 * hop, then resident sessions, then whatever the async resolver cached.
 */
export declare function sessionAncestry(ctx: Context, session: Session): readonly string[];
/** Resolve one session's lead identity synchronously (prompt-assembly path). */
export declare function leadIdentityOf(ctx: Context, session: Session): LeadIdentity;
/** Resolve one session's lead identity durably (authorization paths). */
export declare function leadIdentityOfAsync(ctx: Context, session: Session): Promise<LeadIdentity>;
/** The lead-relevant view of a team record. */
export interface LeadScopedTeam {
    readonly captainSessionId: string;
    /** Present on real team state; omitting it keeps the pure exact-id contract. */
    readonly members?: readonly {
        readonly id: string;
        readonly status?: string;
    }[];
}
/**
 * Whether one identity leads a team: only the exact recorded captain session
 * leads it. A fork is an independent root and never inherits lead identity, so
 * `lead.ancestry` and `lead.inheritsLead` are deliberately ignored (ADR-0003).
 */
export declare function teamLeadMatch(team: LeadScopedTeam, lead: LeadIdentity): boolean;
/**
 * Whether one live session id leads a team: exactly the recorded captain, with
 * members excluded. A fork never inherits lead identity (ADR-0003).
 */
export declare function sessionLeadsTeam(ctx: Context, team: LeadScopedTeam, sessionId: string): boolean;
/** Durable {@link sessionLeadsTeam}: exact captain id, members excluded (ADR-0003). */
export declare function sessionLeadsTeamAsync(ctx: Context, team: LeadScopedTeam, sessionId: string): Promise<boolean>;
/**
 * Nearest live lead session of a team: the recorded captain, and only while it
 * is resident. A fork is an independent root and never receives
 * captain-directed reports (ADR-0003), so there is no fork fallback.
 * @param ctx - the plugin context (injects `agents`).
 * @param team - current team state.
 * @returns the live captain agent, or undefined when it is not resident.
 */
export declare function nearestLiveLead(ctx: Context, team: LeadScopedTeam, live?: readonly Agent[]): Agent | undefined;
/**
 * Diagnostic note for a caller that matched no team but is a fork, so an
 * operator can distinguish "no team exists" from "a team exists that this
 * session does not lead".
 */
export declare function forkLineageNote(session: Session): string;
