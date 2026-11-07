/**
 * Member-scoped skill visibility (AgentTeams 0.2.0, requirement two, §4.5).
 *
 * A member's definition declares a skill allowlist, but the Harness `skill`
 * tool and its `<available_skills>` catalog are registered globally by
 * `@deepseek-ai/dsh-tool-skill`, so the plugin cannot change them in place.
 * This module therefore installs a *member-scope* overlay on the child ctx:
 *
 * 1. register a same-name `skill` tool in the member's scope; a scoped
 *    registration shadows the global one, and the host catalog stops
 *    advertising itself for that agent (it only publishes when its own exact
 *    tool registration still wins);
 * 2. re-publish a filtered `<available_skills>` catalog on `agent/pre-step`
 *    that lists only the allowed skills plus `handoff`, which is *always*
 *    visible so the quota-handover flow keeps working.
 *
 * The Handoff skill itself is contributed separately by
 * {@link handoffSkillProvider} so it exists even when the host has no
 * `handoff` skill. The built-in provider ranks below host skills, making it a
 * fallback rather than a replacement.
 * @module dsh-agent-teams/member-skills
 */
import { createHash } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
/** The always-visible handover skill name. */
export const HANDOFF_SKILL_NAME = 'handoff';
/**
 * Source kind of the member skill catalog. Deliberately NOT `skill-catalog`:
 * host `tool-skill` owns that kind and deletes (or replaces) every message
 * carrying it whenever its own tool is shadowed. Reusing it meant the model
 * either saw no catalog at all or saw a full, unfiltered one while our tool
 * rejected those names. A distinct kind keeps our catalog out of the host's
 * catalog waterfall so the prompt and the tool stay in sync.
 */
export const MEMBER_SKILL_CATALOG_KIND = 'agent-teams:member-skills';
/** Routing description surfaced in the filtered catalog. */
export const HANDOFF_SKILL_DESCRIPTION = 'Write a handover document when a member reaches its task or token quota and must stop taking new work.';
/** Ranks below host providers so a real host `handoff` skill wins; this is a fallback. */
export const HANDOFF_SKILL_RANK = 1000;
/** Fixed handover document sections, in order. */
export const HANDOFF_SKILL_SECTIONS = [
    '当前任务与状态',
    '已完成工作',
    '改动文件',
    '未完成项与风险',
    '建议接手步骤',
    '关键命令与验证结果',
];
/** Build the fixed-section handover document template. */
export function handoffSkillBody(memberName = '<member>') {
    const lines = [
        `# Handover: ${memberName}`,
        '',
        'Use this template for the handover document. Keep every section heading and replace the placeholders with concrete facts.',
        '',
    ];
    for (const section of HANDOFF_SKILL_SECTIONS) {
        lines.push(`## ${section}`, '');
    }
    return `${lines.join('\n').trimEnd()}\n`;
}
/**
 * Contribute the built-in `handoff` skill through `ctx.skills.registerProvider`.
 * It is a fallback: the high rank lets a host-provided `handoff` skill win.
 */
export function handoffSkillProvider() {
    const candidate = {
        name: HANDOFF_SKILL_NAME,
        description: HANDOFF_SKILL_DESCRIPTION,
        invocation: { modelInvocable: true, userInvocable: true },
        rank: HANDOFF_SKILL_RANK,
        locator: { kind: 'builtin-handoff' },
    };
    return {
        name: 'agent-teams-handoff',
        async list() {
            return [candidate];
        },
        async get(requested) {
            if (requested.name !== HANDOFF_SKILL_NAME)
                return undefined;
            return {
                name: HANDOFF_SKILL_NAME,
                description: HANDOFF_SKILL_DESCRIPTION,
                invocation: { modelInvocable: true, userInvocable: true },
                content: handoffSkillBody(),
                provider: 'agent-teams',
            };
        },
    };
}
/**
 * Merge the always-visible `handoff` skill into an allowlist.
 * `undefined` means "inherit all" and is returned untouched (nothing to add:
 * every visible skill, including `handoff`, is shown).
 */
export function mergeHandoffSkill(allowedSkills, handoffSkillName = HANDOFF_SKILL_NAME) {
    if (allowedSkills === undefined)
        return undefined;
    const result = [];
    const seen = new Set();
    const push = (value) => {
        const name = value.trim();
        if (name === '')
            return;
        const key = name.toLowerCase();
        if (seen.has(key))
            return;
        seen.add(key);
        result.push(name);
    };
    for (const name of allowedSkills)
        push(name);
    push(handoffSkillName);
    return result;
}
/**
 * Keep only the allowed skills plus `handoff`, and drop model-invisible ones.
 * `undefined` keeps every model-invocable skill (inherit all).
 */
export function filterSkillSummaries(summaries, allowedSkills, handoffSkillName = HANDOFF_SKILL_NAME) {
    const handoff = handoffSkillName.toLowerCase();
    const allowed = allowedSkills === undefined
        ? undefined
        : new Set(allowedSkills.map(name => name.trim().toLowerCase()).filter(name => name !== ''));
    return summaries.filter(skill => {
        if (skill.invocation?.modelInvocable === false)
            return false;
        if (allowed === undefined)
            return true;
        const name = skill.name.toLowerCase();
        return name === handoff || allowed.has(name);
    });
}
/** Collapse and bound a catalog description line. */
function normalizeDescription(value, maxLength = 500) {
    const normalized = value.replaceAll(/\s+/g, ' ').trim();
    return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}
/** Render the model-facing `<available_skills>` frame for the filtered catalog. */
function renderCatalog(entries) {
    const lines = [
        '<system-reminder>',
        entries.length === 0
            ? 'No skills are available to this member. Do not call the `skill` tool and do not infer skill instructions.'
            : 'A skill is a reusable set of task-specific instructions. The following skills are available to this member:',
        '',
        '<available_skills>',
        ...entries.map(entry => `- \`${entry.name}\`: ${entry.description}`),
        '</available_skills>',
        '',
        'This is the only valid skill catalog for this member. Ignore any other skill catalog, names from earlier turns, or names you may infer.',
        'If the task clearly matches a skill, call the `skill` tool with the exact name from this list before acting. Never call a name outside this list.',
        '</system-reminder>',
    ];
    return lines.join('\n');
}
/** Stable digest of the catalog entries so an unchanged catalog is not republished every step. */
function digestEntries(entries) {
    const canonical = entries.map(entry => JSON.stringify([entry.name, entry.description])).join('\n');
    return createHash('sha256').update(canonical).digest('hex');
}
/** Resolve the workspace cwd for a catalog lookup when the host exposes one. */
async function resolveCwd(childCtx, agent, signal) {
    const workingDirectory = childCtx.workingDirectory;
    if (typeof workingDirectory?.ensure !== 'function')
        return undefined;
    try {
        return await workingDirectory.ensure(agent, signal);
    }
    catch {
        return undefined;
    }
}
/**
 * Install the member-scope skill filter on a member child context.
 *
 * Registers a same-name `skill` tool that shadows the host tool and rejects
 * any name outside the allowed set (plus `handoff`), and re-publishes the
 * filtered `<available_skills>` catalog on each step. Returns a disposer that
 * removes both contributions.
 * @param childCtx - the member's child context (scope of the registration).
 * @param agent - the member agent the overlay belongs to.
 * @param allowedSkills - the resolved skill allowlist; `undefined` inherits all.
 * @param handoffSkillName - the always-visible handover skill name.
 */
export function installMemberSkillFilter(childCtx, agent, allowedSkills, handoffSkillName = HANDOFF_SKILL_NAME) {
    const disposers = [];
    const visible = mergeHandoffSkill(allowedSkills, handoffSkillName);
    const visibleSet = visible === undefined ? undefined : new Set(visible.map(name => name.toLowerCase()));
    const tools = childCtx.tools;
    const skills = childCtx.skills;
    // The catalog the model sees and the names the `skill` tool accepts MUST be
    // the same set. `catalogNames` becomes the authority as soon as the first
    // step has resolved the real skill registry; until then the allowlist bounds
    // both sides. Deriving them separately is what let the prompt drift.
    let catalogNames;
    const availableHint = () => {
        const names = catalogNames ?? visibleSet;
        return names === undefined ? 'every skill' : [...names].sort().join(', ') || '(none)';
    };
    // 1. Shadow the host `skill` tool inside this member's scope.
    const getTool = tools?.get;
    const registerTool = tools?.register;
    if (getTool !== undefined && registerTool !== undefined) {
        const hostTool = getTool.call(tools, 'skill', agent);
        if (hostTool !== undefined) {
            const originalExecute = hostTool.execute;
            const shadow = { ...hostTool };
            shadow.execute = async (args, exec) => {
                const requested = typeof args?.name === 'string'
                    ? (args.name)
                    : '';
                const names = catalogNames ?? visibleSet;
                if (names !== undefined && !names.has(requested.trim().toLowerCase())) {
                    // Echo the exact catalog: a bare "not available" makes the model
                    // retry blind names from a stale catalog forever.
                    throw new Error(`skill "${requested}" is not available to this member. Available skills: ${availableHint()}. Only use names from this member's skill catalog.`);
                }
                if (originalExecute === undefined)
                    throw new Error('skill tool is unavailable');
                return originalExecute.call(hostTool, args, exec);
            };
            const disposeShadow = registerTool.call(tools, shadow);
            // Fail closed at the real boundary: if the scoped registration did not
            // actually shadow the host tool, the host keeps publishing its full
            // catalog while the member silently runs with an unrestricted `skill`
            // tool. That is the exact prompt/tool mismatch this module exists to avoid.
            if (getTool.call(tools, 'skill', agent) !== shadow) {
                disposeShadow();
                throw new Error('agent-teams: member skill filter failed to shadow the host `skill` tool');
            }
            disposers.push(disposeShadow);
        }
    }
    // 2. Publish exactly ONE filtered catalog on every step, under our own
    //    source kind. Drop any host-owned `skill-catalog` message (empty, full,
    //    stale or inherited) and any previous copy of ours first.
    const published = new WeakMap();
    const off = childCtx.on('agent/pre-step', async ({ agent: stepAgent, signal }, next) => {
        const decision = await next();
        if (decision.kind === 'reject')
            return decision;
        if (stepAgent.id !== agent.id)
            return decision;
        const snapshot = skills?.snapshot;
        if (snapshot === undefined)
            return decision;
        const cwd = await resolveCwd(childCtx, agent, signal);
        const observation = await snapshot.call(skills, { cwd, signal, scope: agent });
        const entries = filterSkillSummaries(observation.skills, allowedSkills, handoffSkillName).map(skill => ({
            name: skill.name,
            description: normalizeDescription(skill.description),
        }));
        // Catalog and tool guard share ONE authority, by construction.
        catalogNames = new Set(entries.map(entry => entry.name.toLowerCase()));
        const digest = digestEntries(entries);
        const retained = decision.messages.filter(message => message.source.kind !== 'skill-catalog' && message.source.kind !== MEMBER_SKILL_CATALOG_KIND);
        const ownCatalog = decision.messages.find(message => message.source.kind === MEMBER_SKILL_CATALOG_KIND);
        const previous = published.get(stepAgent);
        if (previous === digest && ownCatalog !== undefined) {
            return { ...decision, messages: [...retained, ownCatalog] };
        }
        published.set(stepAgent, digest);
        const catalog = createUserMessage({
            content: [{ type: 'text', text: renderCatalog(entries) }],
            source: { kind: MEMBER_SKILL_CATALOG_KIND, form: 'catalog', entries },
        });
        return { ...decision, messages: [...retained, catalog] };
    });
    disposers.push(off);
    return () => {
        for (const dispose of disposers)
            dispose();
    };
}
