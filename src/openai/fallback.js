/**
 * @file src/openai/fallback.js
 * @purpose Multi-backend fallback: try channels in order when one fails.
 * @exports resolveBackend, tryFallback
 * @ai.hint keep
 */

/**
 * Pick the first backend that has a key configured.
 * @param {object} config
 * @returns {{ baseURL: string, apiKey: string }}
 */
export function resolveBackend(config) {
    const backends = config?.backends ?? [];
    for (const b of backends) {
        const key = b.apiKey ?? '';
        if (key && key !== '') return { baseURL: b.baseURL ?? b.baseUrl ?? '', apiKey: key };
    }
    return { baseURL: config?.baseURL ?? '', apiKey: config?.apiKey ?? '' };
}

/**
 * Try a function across backends until one succeeds.
 * @param {Array<{baseURL:string,apiKey:string}>} backends
 * @param {(backend: object) => Promise<any>} fn
 * @returns {Promise<any>}
 */
export async function tryFallback(backends, fn) {
    let lastError = null;
    for (const backend of backends) {
        try {
            return await fn(backend);
        } catch (e) {
            lastError = e;
        }
    }
    throw lastError ?? new Error('No backends available');
}