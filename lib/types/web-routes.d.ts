import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostConnectionService } from '@deepseek-ai/dsh-client-connection';
/** One read-only member-definition row returned to the staging editor. */
export interface MemberDefinitionSummaryPayload {
    readonly name: string;
    readonly description: string;
    readonly source: string;
    /** `inherit` or the resolved `provider/model` id. */
    readonly model: string;
    readonly tools: readonly string[];
    readonly skills: readonly string[];
    readonly maxTasks: number;
    readonly maxContextTokens: number;
}
/**
 * Build the host-side member-definition directory payload the staging editor
 * consumes. Reuses the same scan/resolve path as the
 * `agent_teams_list_member_definitions` tool so the panel and the captain see
 * one directory. Pure read: no workspace or team state is modified.
 */
export declare function collectMemberDefinitionsPayload(workspace: string, captainVisibleTools: readonly string[]): Promise<{
    definitions: MemberDefinitionSummaryPayload[];
}>;
/** Public WebServer route surface used by the plugin. */
export interface WebRouteHost {
    register(route: {
        kind: 'exact' | 'prefix';
        path: string;
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
    }): () => void;
}
export type BrowserRequestGate = Pick<HostConnectionService, 'requestRejection'>;
export declare class RequestBodyError extends Error {
    readonly status: 400 | 413;
    constructor(message: string, status: 400 | 413);
}
/** Parsed body of a member runtime-model switch request. */
export interface MemberModelSwitchRequest {
    sessionId: string;
    teamId: string;
    memberName: string;
    provider: string;
    model: string;
    reasoningEffort?: string;
}
/**
 * Validate the browser member-model switch body. Returns a precise error string
 * instead of throwing so the route can answer 400 without leaking internals.
 */
export declare function parseMemberModelSwitchRequest(payload: Record<string, unknown>): MemberModelSwitchRequest | {
    error: string;
};
/** Bound memory while draining oversized requests so the route can return 413. */
export declare function readJsonRequest(req: IncomingMessage, maxBytes?: number): Promise<Record<string, unknown>>;
/** Revalidate a current JSON representation across both identity and gzip delivery. */
export declare function writeJsonWithEtag(req: IncomingMessage, res: ServerResponse, body: string): void;
/** Raw WebServer routes do not inherit Connection's authentication fence. */
export declare function authenticatedWebRoutes(server: WebRouteHost, connection: () => BrowserRequestGate | undefined): WebRouteHost;
