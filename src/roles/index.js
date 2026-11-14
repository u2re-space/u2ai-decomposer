/**
 * @file src/roles/index.js
 * @module roles
 * @purpose Role registry: instructions, model/effort resolution, and the run loop that talks
 *          to the API.
 * @depends openai/responses, model/profiles
 * @usedBy shared/pipeline, stages
 * @exports ROLE_INSTRUCTIONS, resolveRoleInstructions, resolveRole, createRoleRunner
 * @ai.tags roles
 * @ai.hint keep
 */
import { extenderInstructions } from './extender.js';
import { decomposerInstructions } from './decomposer.js';
import { rectifierInstructions } from './rectifier.js';
import { restorerInstructions, restorerVerifyInstructions } from './restorer.js';
import { overlapInstructions } from './overlap.js';
import { directorInstructions } from './director.js';
import { parseResponse } from '../openai/responses.js';
import { BATCH_SUBMITTED } from '../openai/batch.js';
import { getModelProfile, snapEffort } from '../model/profiles.js';

/**
 * Role instructions registry.
 * @type {Record<string, string>}
 */
export const ROLE_INSTRUCTIONS = Object.freeze({
    extender: extenderInstructions,
    decomposer: decomposerInstructions,
    rectifier: rectifierInstructions,
    restorer: restorerInstructions,
    restorerVerify: restorerVerifyInstructions,
    overlap: overlapInstructions,
    director: directorInstructions,
});

/**
 * Resolve a role name to its instruction text.
 * @param {string} name
 * @returns {string|null}
 */
export function resolveRoleInstructions(name) {
    return ROLE_INSTRUCTIONS[name] ?? null;
}

const textOf = (value) => (typeof value === 'string' ? value : '');
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Resolve a role into the settings of one call.
 *
 * The chain is role → `roles.default` → the top level of the config. The effort is clamped to
 * what the model accepts and to the ceiling of the role.
 * @param {object} config
 * @param {string} name
 * @param {{ model?: string|null, effort?: string|null }} [overrides] settings of this run
 * @returns {{ name: string, model: string|null, effort: string|null, imageModel: string|null, instructions: string|null, tools: string[]|null, context: string|null }}
 * @exports
 */
export function resolveRole(config, name, { model = null, effort = null } = {}) {
    const roles = isRecord(config?.roles) ? config.roles : {};
    const role = isRecord(roles[name]) ? roles[name] : {};
    const fallback = isRecord(roles.default) ? roles.default : {};

    const pick = (field) => {
        for (const source of [role, fallback]) {
            const value = source?.[field];
            if (value !== undefined && value !== null && value !== '') return value;
        }
        return null;
    };

    const resolvedModel = model ?? pick('model') ?? textOf(config?.model) ?? null;
    const profile = getModelProfile(resolvedModel, config);

    const wantedEffort = effort ?? pick('effort') ?? textOf(config?.reasoning?.effort) ?? null;
    let resolvedEffort = snapEffort(wantedEffort, profile);
    const maxEffort = pick('maxEffort');
    if (maxEffort) {
        const capped = snapEffort(maxEffort, profile);
        if (capped && resolvedEffort) {
            const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
            if (order.indexOf(resolvedEffort) > order.indexOf(capped)) resolvedEffort = capped;
        }
    }

    return {
        name,
        model: resolvedModel,
        effort: resolvedEffort,
        imageModel: pick('imageModel') ?? textOf(config?.imageModel) ?? null,
        instructions: pick('instructions') ?? resolveRoleInstructions(name),
        tools: Array.isArray(role?.tools) ? role.tools : null,
        context: pick('context'),
    };
}

/**
 * Create a role runner bound to a client.
 *
 * The runner knows how to ask a role a question and how to read the answer: JSON when the
 * role has a schema, plain text otherwise. A tool loop is optional: when a toolset is given,
 * the calls the model asks for are executed and the answers are fed back.
 * @param {{ client: object, config?: object, model?: string|null, effort?: string|null, toolset?: object|null, skills?: object|null, onEvent?: Function|null }} opts
 *   `skills` maps a role name to the text of its skill pack.
 * @returns {{ run: Function, resolve: Function }}
 */
export function createRoleRunner({ client, config = {}, model = null, effort = null, toolset = null, skills = null, onEvent = null } = {}) {
    /**
     * Tell the reader what the role is doing right now.
     *
     * The call itself may take minutes — a reasoning model with a picture is slow — and a
     * silent terminal looks like a hung one. The reader gets a line instead of a silence.
     * @param {string} type the name of the event
     * @param {object} payload the details of the event
     * @returns {void}
     */
    function notifyRole(type, payload) {
        if (!onEvent) return;
        try { onEvent({ type, ...payload }); } catch { /* an observer never breaks a run */ }
    }

    /**
     * Run one role.
     * @param {string} name role name
     * @param {{ text: string, parts?: object[], instructions?: string|null, schema?: object|null, schemaName?: string|null, maxTurns?: number, model?: string|null, effort?: string|null, signal?: AbortSignal|null, extraTools?: object[], stream?: boolean|null }} [params]
     * @returns {Promise<{ status: string, data: object|null, text: string, toolCalls: object[], usage: object|null, error: string|null, model: string|null, trace: object[] }>}
     */
    async function run(name, {
        text = '', parts = [], instructions = null, schema = null, schemaName = null,
        maxTurns = 1, model: runModel = null, effort: runEffort = null, signal = null, extraTools = null,
        stream: runStream = null,
    } = {}) {
        const role = resolveRole(config, name, { model: runModel ?? model, effort: runEffort ?? effort });
        const skillText = typeof skills?.[name] === 'string' ? skills[name].trim() : '';
        const roleInstructions = [instructions ?? role.instructions, skillText].filter(Boolean).join('\n\n');
        if (!roleInstructions) {
            return {
                status: 'error', data: null, text: '', toolCalls: [], usage: null,
                error: `Unknown role: ${name}`, model: role.model, trace: [],
            };
        }

        const tools = extraTools ?? (
            toolset?.specsFor
                ? toolset.specsFor(name, role.tools ?? null)
                : (toolset?.specs ?? null)
        );
        // A streamed answer keeps the connection alive while the model thinks and lets the
        // reader see that the work is going on. A host that does not serve the route as a
        // stream is answered again without the flag by the client.
        const stream = runStream ?? config?.streaming !== false;
        const trace = [];
        const items = [];
        let last = null;

        try {
            const turns = Math.max(1, Number.isSafeInteger(maxTurns) ? maxTurns : 1);
            for (let turn = 0; turn < turns; turn++) {
                notifyRole('role.start', { role: name, model: role.model, effort: role.effort, turn: turn + 1, turns });
                const answer = await client.responses.create({
                    model: role.model,
                    instructions: roleInstructions,
                    input: turn === 0 ? text : items,
                    parts: turn === 0 ? parts : null,
                    tools,
                    schema,
                    schemaName: schemaName ?? 'response',
                    effort: role.effort,
                    signal,
                    onEvent,
                    stream,
                    // One turn, one question: the request may be a part of a parallel round, and
                    // then it may go into the batch of that round.
                    batchable: turns === 1,
                });
                const parsed = parseResponse(answer);
                last = parsed;
                for (const call of parsed.toolCalls) trace.push({ tool: call.name, args: call.arguments });
                notifyRole('role.done', {
                    role: name, model: parsed.model ?? role.model, status: parsed.status,
                    usage: parsed.usage, toolCalls: parsed.toolCalls.length,
                });

                if (!parsed.toolCalls.length || !toolset) break;

                // Run the calls and feed the results back to the model.
                for (const [index, call] of parsed.toolCalls.entries()) {
                    const callId = call.callId ?? call.id ?? `call_${turn}_${index}`;
                    let output = '';
                    try {
                        output = await toolset.execute(call.name, call.arguments);
                    } catch (error) {
                        output = `Tool error: ${error?.message ?? error}`;
                    }
                    items.push({ type: 'function_call', call_id: callId, name: call.name, arguments: call.raw });
                    items.push({
                        type: 'function_call_output',
                        call_id: callId,
                        output: textOf(output).slice(0, 20_000),
                    });
                }
            }
        } catch (error) {
            // The batch is out and the answers are not here yet: the run stops and waits for
            // the second phase. This is not a failure of the role.
            if (error?.code === BATCH_SUBMITTED) throw error;
            return {
                status: 'error', data: null, text: last?.text ?? '', toolCalls: last?.toolCalls ?? [],
                usage: last?.usage ?? null, error: error?.message ?? String(error),
                model: role.model, trace,
            };
        }

        return {
            status: last?.status ?? 'completed',
            data: last?.data ?? null,
            text: last?.text ?? '',
            toolCalls: last?.toolCalls ?? [],
            usage: last?.usage ?? null,
            error: last?.error?.message ?? null,
            model: last?.model ?? role.model,
            trace,
        };
    }

    return {
        run,
        resolve: (name, overrides = {}) => resolveRole(config, name, overrides),
    };
}
