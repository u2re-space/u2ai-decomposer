/**
 * @file src/roles/index.js
 * @module roles
 * @purpose Role registry and runner: resolves role by name, loads instructions, runs AI role.
 * @depends node:fs/promises
 * @exports createRoleRunner, ROLE_INSTRUCTIONS
 * @ai.tags roles
 * @ai.hint keep
 */
import { extenderInstructions } from './extender.js';
import { decomposerInstructions } from './decomposer.js';
import { rectifierInstructions } from './rectifier.js';
import { restorerInstructions } from './restorer.js';
import { overlapInstructions } from './overlap.js';
import { directorInstructions } from './director.js';

/**
 * Role instructions registry.
 * @type {Record<string, string>}
 */
export const ROLE_INSTRUCTIONS = Object.freeze({
    extender: extenderInstructions,
    decomposer: decomposerInstructions,
    rectifier: rectifierInstructions,
    restorer: restorerInstructions,
    overlap: overlapInstructions,
    director: directorInstructions,
});

/**
 * Resolve role name to instruction string.
 * @param {string} name
 * @returns {string|null}
 */
export function resolveRoleInstructions(name) {
    return ROLE_INSTRUCTIONS[name] ?? null;
}

/**
 * Create a role runner that calls the AI client.
 * @param {{ client: object }} opts
 * @returns {{ run: (name: string, params: object) => Promise<{ status: string, data: object|null, error: string|null, text: string }> }}
 */
export function createRoleRunner({ client }) {
    /**
     * Run an AI role.
     * @param {string} name
     * @param {{ text: string, parts?: object[], instructions?: string, schema?: object, schemaName?: string, maxTurns?: number, model?: string|null, effort?: string|null, signal?: AbortSignal }} params
     * @returns {Promise<{ status: string, data: object|null, error: string|null, text: string }>}
     */
    async function run(name, { text, parts = [], instructions = null, schema = null, schemaName = null, maxTurns = 1, model = null, effort = null, signal = null }) {
        const roleInstructions = instructions ?? ROLE_INSTRUCTIONS[name];
        if (!roleInstructions) {
            return { status: 'error', data: null, error: `Unknown role: ${name}`, text: '' };
        }

        try {
            // Build messages for the AI client.
            const messages = [
                { role: 'system', content: roleInstructions },
                { role: 'user', content: text },
            ];

            // If parts (images) are provided, attach them.
            const content = parts.length
                ? [{ type: 'text', text }, ...parts]
                : text;

            const result = await client.responses.create({
                model: model || null,
                messages: [{ role: 'user', content }],
                tools: schema ? [{ type: 'function', name: schemaName, function: { name: schemaName, description: schemaName, parameters: schema } }] : [],
                max_turns: maxTurns,
                signal,
            });

            // Parse JSON from the response.
            const textContent = result.messages?.[0]?.content?.[0]?.text ?? '';
            let data = null;
            try {
                data = JSON.parse(textContent);
            } catch {
                // Not JSON — return as text.
            }

            return {
                status: result.status || 'completed',
                data,
                error: result.error || null,
                text: textContent,
            };
        } catch (error) {
            return { status: 'error', data: null, error: error.message, text: '' };
        }
    }

    return { run };
}