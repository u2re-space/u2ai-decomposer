/**
 * @file src/openai/client.js
 * @module openai/client
 * @purpose OpenAI-compatible HTTP client: Responses API and Chat Completions, streaming SSE, image routes.
 * @depends node:https, node:crypto
 * @exports createClient, ApiError
 * @ai.tags openai, client, api
 * @ai.hint keep
 */

/**
 * @typedef {Error & { status?: number, code?: string, body?: unknown }} ApiError
 */

/**
 * Create an API error.
 * @param {string} message
 * @param {number} status
 * @param {unknown} [body]
 * @returns {ApiError}
 */
function apiError(message, status, body) {
    const err = new Error(message);
    err.status = status;
    err.name = 'ApiError';
    err.body = body;
    return err;
}

export { apiError as ApiError };

/**
 * Create an OpenAI-compatible client for the configured backends.
 * @param {{ config: object, signal?: AbortSignal }} opts
 * @returns {Promise<{ responses: object, chat: object, images: object, close: () => void }>}
 */
export async function createClient({ config, signal = null }) {
    const baseURL = config.baseURL || 'https://api.openai.com/v1';
    const apiKey = config.apiKey || process.env.OPENAI_API_KEY || '';

    /**
     * Make an HTTP request to the API.
     * @param {string} method
     * @param {string} path
     * @param {object} [body]
     * @param {object} [opts]
     * @returns {Promise<object>}
     */
    async function request(method, path, body = null, { headers = {}, stream = false } = {}) {
        const url = new URL(path, baseURL);
        const reqHeaders = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            ...headers,
        };

        const { default: https } = await import('node:https');
        const { default: http } = await import('node:http');
        const mod = url.protocol === 'https:' ? https : http;

        return new Promise((resolve, reject) => {
            const req = mod.request(url, {
                method,
                headers: reqHeaders,
                signal,
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode >= 400) {
                        reject(apiError(`HTTP ${res.statusCode}`, res.statusCode, data));
                        return;
                    }
                    try { resolve(JSON.parse(data)); }
                    catch { resolve(data); }
                });
            });
            req.on('error', reject);
            if (body) req.write(JSON.stringify(body));
            req.end();
        });
    }

    return {
        responses: {
            /**
             * Create a response (Responses API).
             * @param {{ model: string, messages: object[], tools?: object[], max_turns?: number, signal?: AbortSignal }} params
             * @returns {Promise<{ status: string, messages: object[], error: string|null }>}
             */
            async create(params) {
                return request('POST', '/responses', params, { signal: params.signal });
            },
        },
        chat: {
            /**
             * Create a chat completion.
             * @param {{ model: string, messages: object[], tools?: object[] }} params
             * @returns {Promise<object>}
             */
            async create(params) {
                return request('POST', '/chat/completions', params);
            },
        },
        images: {
            /**
             * Generate an image.
             * @param {{ model: string, prompt: string, size?: string, format?: string, n?: number, signal?: AbortSignal }} params
             * @returns {Promise<string[]>} base64 payloads
             */
            async generate(params) {
                const res = await request('POST', '/images/generations', params);
                return res?.data?.map((d) => d.b64_json ?? d.url) ?? [];
            },
            /**
             * Edit an image.
             * @param {{ model: string, prompt: string, files: Array<{filename:string,mime:string,bytes:Buffer}>, size?: string, format?: string, signal?: AbortSignal }} params
             * @returns {Promise<string[]>} base64 payloads
             */
            async edit(params) {
                const res = await request('POST', '/images/edits', params);
                return res?.data?.map((d) => d.b64_json ?? d.url) ?? [];
            },
        },
        close() { /* no persistent connections to clean up */ },
    };
}