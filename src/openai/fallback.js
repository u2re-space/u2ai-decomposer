/**
 * @file src/openai/fallback.js
 * @module openai/fallback
 * @purpose Model fallback: a chain of models to try when one refuses or fails.
 * @exports fallbackChain, withModelFallback, fallbackModels
 * @ai.tags fallback
 * @ai.hint pure
 * @ai.hint legacy-0.2
 */

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const textOf = (value) => (typeof value === 'string' ? value : '');

/**
 * The models to try after the given one: the list under `fallback.models.<model>`, then the
 * list under `fallback.models.*` (the catch-all chain).
 * @param {object} config
 * @param {string|null} model
 * @returns {string[]}
 * @exports
 */
export function fallbackModels(config, model) {
    if (config?.fallback?.enabled === false) return [];
    const map = config?.fallback?.models;
    if (!isRecord(map)) return [];
    const pick = (list) => (Array.isArray(list)
        ? list.map((item) => (typeof item === 'string' ? item : textOf(item?.model))).filter(Boolean)
        : []);
    const own = pick(map[model]);
    const shared = pick(map['*']);
    return [...own, ...shared.filter((item) => !own.includes(item))];
}

/**
 * The full chain of models for a request: the requested model first, then its fallbacks.
 * @param {object} config
 * @param {string|null} model
 * @returns {string[]}
 * @exports
 */
export function fallbackChain(config, model) {
    const chain = [];
    if (model) chain.push(model);
    for (const item of fallbackModels(config, model)) if (!chain.includes(item)) chain.push(item);
    return chain;
}

/**
 * Run a call with the model chain: the next model is tried when the call fails with an
 * error that another model may survive (a refused request, an overload, a missing model).
 * @param {{ config: object, model: string|null, call: (model: string|null) => Promise<any>, onTry?: Function|null }} params
 * @returns {Promise<{ result: any, model: string|null, attempts: Array<{ model: string|null, error: string }> }>}
 * @exports
 */
export async function withModelFallback({ config, model, call, onTry = null }) {
    const chain = fallbackChain(config, model);
    const attempts = [];
    let lastError = null;
    for (const candidate of chain) {
        try {
            onTry?.({ model: candidate, attempt: attempts.length + 1 });
            const result = await call(candidate);
            return { result, model: candidate, attempts };
        } catch (error) {
            lastError = error;
            attempts.push({ model: candidate, error: error?.message ?? String(error) });
        }
    }
    throw lastError ?? new Error('No model answered the request.');
}
