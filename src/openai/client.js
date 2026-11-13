/**
 * @file src/openai/client.js
 * @module openai/client
 * @purpose API client: Responses API first, Chat Completions as transport fallback, image
 *          generate/edit, backend rotation with retries.
 * @depends node:crypto, node:timers/promises, openai/errors, openai/http, openai/sse,
 *          openai/stream, openai/chat, openai/responses, openai/images
 * @usedBy cli, shared/pipeline, roles/index
 * @exports createClient, ApiError, retryDelayMs, resolveBackends
 * @ai.tags openai, client, api
 * @ai.hint io
 * @ai.hint legacy-0.2
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ApiError } from './errors.js';
import { createHttp, readBody } from './http.js';
import { parseSSE } from './sse.js';
import { createStreamReducer } from './stream.js';
import {
    CHAT_PATH, chatGaps, createChatStreamReducer, normalizeChatResult,
    responsesRouteUnsupported, stripRejectedFields, toChatBody,
} from './chat.js';
import { buildResponsesBody } from './responses.js';
import {
    backgroundValue, encodeMultipart, imageSizeFields, imageSources, sniffImage,
} from './images.js';

/** Statuses worth another try on the same backend. */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const defaults = Object.freeze({
    baseURL: 'https://api.openai.com/v1/',
    retries: 3,
    maxErrorBytes: 64 * 1024,
    maxResponseBytes: 256 * 1024 * 1024,
    maxEventBytes: 32 * 1024 * 1024,
});

/** Headers the client sets itself; a backend header must not replace them. */
const RESERVED_HEADERS = new Set(['authorization', 'content-type', 'accept', 'x-client-request-id']);

/** RFC 7230 token characters for header names. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const textOf = (value) => (typeof value === 'string' ? value : '');
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Normalize a base URL and require a path that ends with `/`.
 * @param {string} value
 * @returns {URL}
 * @ai.hint pure
 */
function normalizeBaseURL(value) {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) {
        throw new TypeError('The base URL must not contain credentials, a query or a fragment.');
    }
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url;
}

/**
 * Stringify and check per-backend headers. Reserved names are ignored: auth and content
 * headers belong to the client.
 * @param {object|null|undefined} headers
 * @returns {Record<string, string>}
 * @ai.hint pure
 */
function normalizeHeaders(headers) {
    if (!isRecord(headers)) return {};
    const out = {};
    for (const [name, value] of Object.entries(headers)) {
        if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(name.toLowerCase()) || value == null) continue;
        const text = String(value);
        if (/[\r\n]/.test(text)) throw new TypeError(`Header ${name} contains a line break.`);
        out[name] = text;
    }
    return out;
}

/**
 * Delay before a retry. A positive Retry-After wins, capped at 60 seconds; otherwise backoff
 * with jitter. HTTP 429 waits at least 3 seconds so a repeat does not look like a burst.
 * @param {number} attempt
 * @param {string|number|null} retryAfter
 * @param {number|null} [status]
 * @returns {number}
 * @exports
 * @ai.hint pure
 */
export function retryDelayMs(attempt, retryAfter, status = null) {
    const header = Number(retryAfter);
    const fromHeader = Number.isFinite(header) && header > 0 ? Math.min(header * 1000, 60_000) : 0;
    const backoff = Math.min(500 * 2 ** attempt + Math.random() * 250, 20_000);
    const delay = Math.max(fromHeader, backoff);
    if (status === 429) return Math.max(delay, 3000);
    return fromHeader > 0 ? fromHeader : backoff;
}

/**
 * The key of a backend entry: the inline key, then the named environment variable.
 * @param {object} entry
 * @param {Record<string, string|undefined>} env
 * @returns {string|null}
 * @ai.hint pure
 */
function keyOf(entry, env) {
    if (typeof entry?.apiKey === 'string' && entry.apiKey.trim()) return entry.apiKey.trim();
    if (typeof entry?.env === 'string' && entry.env) {
        const value = env?.[entry.env];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
}

/**
 * The ordered backends of one route kind.
 *
 * `images` uses `imagesBackends` (and falls back to `backends`), `text` uses `backends`.
 * A per-model list in `modelsBackends` wins over the general one: a model is often served
 * by a host that the general list does not know about.
 * @param {object} config
 * @param {{ kind?: 'text'|'images', model?: string|null, env?: object }} [options]
 * @returns {Array<{ baseURL: string, apiKey: string|null, headers: object, body: object, supports: object }>}
 * @exports
 */
export function resolveBackends(config, { kind = 'text', model = null, env = process.env } = {}) {
    const general = kind === 'images'
        ? (Array.isArray(config?.imagesBackends) && config.imagesBackends.length ? config.imagesBackends : config?.backends)
        : config?.backends;
    const perModel = model ? config?.modelsBackends?.[model] : null;
    const entries = Array.isArray(perModel) && perModel.length ? perModel : (Array.isArray(general) ? general : []);

    const chain = [];
    for (const entry of entries) {
        if (!isRecord(entry)) continue;
        const baseURL = textOf(entry.baseURL ?? entry.baseUrl).trim();
        if (!baseURL) continue;
        chain.push({
            baseURL,
            apiKey: keyOf(entry, env),
            headers: normalizeHeaders(entry.headers),
            body: isRecord(entry.body) ? { ...entry.body } : {},
            supports: isRecord(entry.supports) ? { ...entry.supports } : {},
        });
    }
    if (chain.some((item) => item.apiKey)) return chain.filter((item) => item.apiKey);

    // No keyed backend: the primary URL and key of the config are the only option left.
    const baseURL = textOf(config?.baseURL).trim();
    if (!baseURL) return chain;
    return [{
        baseURL,
        apiKey: textOf(config?.apiKey).trim() || null,
        headers: {},
        body: {},
        supports: {},
    }, ...chain.filter((item) => item.baseURL !== baseURL)];
}

/**
 * Create an API client for the configured backends.
 *
 * The client owns the transport only: it knows the routes, the retries and the rotation
 * between hosts. What a request means is decided by the caller (roles, stages).
 * @param {{ config: object, env?: object, signal?: AbortSignal|null, onEvent?: Function|null }} opts
 * @returns {Promise<object>}
 */
export async function createClient({ config, env = process.env, signal = null, onEvent = null } = {}) {
    const transport = createHttp({
        idleTimeoutMs: Number.isSafeInteger(config?.timeoutMs) ? config.timeoutMs : 120_000,
        connectTimeoutMs: 30_000,
    });
    const retries = Number.isSafeInteger(config?.limits?.requestRetries)
        ? config.limits.requestRetries
        : (Number.isSafeInteger(config?.retries) ? config.retries : defaults.retries);
    const announce = (event) => { try { onEvent?.(event); } catch { /* an observer never breaks a request */ } };

    /**
     * Build an ApiError out of a failed response.
     * @param {{ status: number, headers: object, body: AsyncGenerator<Buffer> }} res
     * @param {string} clientRequestId
     * @returns {Promise<ApiError>}
     * @ai.hint io
     */
    async function apiErrorFrom(res, clientRequestId) {
        const raw = await readBody(res.body, defaults.maxErrorBytes, { truncate: true }).catch(() => Buffer.alloc(0));
        const text = raw.toString('utf8').trim();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { parsed = null; }
        const err = isRecord(parsed) ? (parsed.error ?? parsed) : null;
        const details = isRecord(err) ? err : {};
        const fromBody = typeof err === 'string' ? err : textOf(details.message);
        const message = (fromBody || text).slice(0, 2000) || `HTTP ${res.status}`;
        return new ApiError(message, {
            code: 'API_ERROR',
            status: res.status,
            requestId: res.headers['x-request-id'] ?? null,
            clientRequestId,
            retryAfter: res.headers['retry-after'] ?? null,
            apiCode: details.code ?? null,
            apiType: details.type ?? null,
            param: details.param ?? null,
            retryable: RETRYABLE_STATUS.has(res.status),
        });
    }

    /**
     * Send one request to one backend, with the configured number of retries.
     * @param {object} backend
     * @param {string} path route relative to the base URL
     * @param {{ method?: string, body?: object, rawBody?: Buffer|string, contentType?: string, signal?: AbortSignal|null, stream?: boolean, onEvent?: Function|null }} options
     * @returns {Promise<object>}
     * @ai.hint io
     */
    async function send(backend, path, {
        method = 'POST', body = null, rawBody = null, contentType = 'application/json',
        signal: callSignal = null, stream = false, onEvent = null,
    } = {}) {
        const root = normalizeBaseURL(backend.baseURL);
        const url = new URL(path, root);
        let attempt = 0;
        for (;;) {
            const clientRequestId = randomUUID();
            const headers = {
                Authorization: `Bearer ${backend.apiKey ?? ''}`,
                'X-Client-Request-Id': clientRequestId,
                ...backend.headers,
            };
            if (rawBody !== null) headers['Content-Type'] = contentType;
            else if (body !== null) headers['Content-Type'] = 'application/json';
            if (stream) headers.Accept = 'text/event-stream';

            let res;
            try {
                res = await transport.request({
                    url,
                    method,
                    headers,
                    body: rawBody !== null ? rawBody : (body !== null ? JSON.stringify(body) : undefined),
                    signal: callSignal ?? signal,
                });
            } catch (error) {
                const wrapped = error instanceof ApiError
                    ? error
                    : new ApiError(`Network error: ${error.message}`, { code: 'NETWORK_ERROR', retryable: true, cause: error });
                if (wrapped.code === 'ABORTED' || error?.name === 'AbortError') throw wrapped;
                if (attempt < retries && wrapped.retryable !== false) {
                    const delay = retryDelayMs(attempt, null, null);
                    announce({ type: 'request.retry', attempt: attempt + 1, delayMs: delay, error: wrapped.message });
                    await sleep(delay);
                    attempt++;
                    continue;
                }
                throw wrapped;
            }

            if (res.status >= 400) {
                const error = await apiErrorFrom(res, clientRequestId);
                if (attempt < retries && RETRYABLE_STATUS.has(res.status)) {
                    const delay = retryDelayMs(attempt, error.retryAfter, res.status);
                    announce({ type: 'request.retry', attempt: attempt + 1, delayMs: delay, error: error.message });
                    await sleep(delay);
                    attempt++;
                    continue;
                }
                throw error;
            }

            return { res, backend, root };
        }
    }

    /**
     * Read a JSON answer.
     * @param {AsyncGenerator<Buffer>} body
     * @returns {Promise<object>}
     * @ai.hint io
     */
    async function readJson(body) {
        const raw = await readBody(body, defaults.maxResponseBytes);
        const text = raw.toString('utf8');
        if (!text.trim()) return {};
        try { return JSON.parse(text); } catch { return { raw: text }; }
    }

    /**
     * Call one route on one backend, without the rotation.
     * The channels below need it: a task id belongs to the host that created it.
     * @param {object} backend
     * @param {string} path route relative to the base URL
     * @param {{ method?: string, body?: object, rawBody?: Buffer|string, contentType?: string, signal?: AbortSignal|null, stream?: boolean, onEvent?: Function|null, model?: string|null }} options
     * @returns {Promise<object>}
     * @ai.hint io
     */
    async function callBackend(backend, path, {
        method = 'POST', body = null, rawBody = null, contentType = 'application/json',
        signal: callSignal = null, stream = false, onEvent: callEvent = null, model = null,
    } = {}) {
        announce({ type: 'request.start', backend: backend.baseURL, path, model });
        const { res } = await send(backend, path, {
            method, body, rawBody, contentType, signal: callSignal, stream, onEvent: callEvent,
        });
        return stream
            ? await readStream(res.body, { kind: stream === 'chat' ? 'chat' : 'responses', model, onEvent: callEvent })
            : await readJson(res.body);
    }

    /**
     * Read a streamed answer and reduce it to the final response object.
     * @param {AsyncGenerator<Buffer>} body
     * @param {{ kind: 'responses'|'chat', model: string|null, onEvent?: Function|null }} options
     * @returns {Promise<object>}
     * @ai.hint io
     */
    async function readStream(body, { kind, model, onEvent: streamEvent = null }) {
        const reducer = kind === 'chat'
            ? createChatStreamReducer({ emit: streamEvent ?? (() => {}), model })
            : createStreamReducer({ emit: streamEvent ?? (() => {}) });
        for await (const event of parseSSE(body, { maxEventBytes: defaults.maxEventBytes, requireType: kind !== 'chat' })) {
            reducer.handle(event);
        }
        if (reducer.streamError) throw reducer.streamError;
        return reducer.response;
    }

    /**
     * Call a route, rotating over the backends of the kind.
     * @param {string} path
     * @param {object} options
     * @returns {Promise<object>}
     * @ai.hint io
     */
    async function call(path, {
        method = 'POST', body = null, rawBody = null, contentType = 'application/json',
        kind = 'text', model = null, signal: callSignal = null, stream = false,
        onEvent: callEvent = null, supports = null,
    } = {}) {
        const chain = resolveBackends(config, { kind, model, env });
        if (!chain.length) {
            throw new ApiError('No backend is configured for this request.', { code: 'NO_BACKEND' });
        }
        let lastError = null;
        for (const backend of chain) {
            if (supports && backend.supports?.[supports] === false) {
                announce({ type: 'request.skip', backend: backend.baseURL, reason: `no ${supports} route` });
                continue;
            }
            try {
                const answer = await callBackend(backend, path, {
                    method, body, rawBody, contentType, signal: callSignal, stream, onEvent: callEvent, model,
                });
                return answer;
            } catch (error) {
                lastError = error;
                const status = error?.status;
                announce({ type: 'request.error', backend: backend.baseURL, status: status ?? null, error: error.message });
                if (error?.name === 'AbortError' || error?.code === 'ABORTED') throw error;
                // A host without the route is not a host to retry: the caller picks another transport.
                if (supports === 'responses' && responsesRouteUnsupported(error)) break;
                // Otherwise the next backend gets the request.
            }
        }
        throw lastError ?? new ApiError('No backend answered the request.', { code: 'NO_BACKEND' });
    }

    /**
     * The Responses API with a Chat Completions fallback for hosts without the route.
     * @param {object} params
     * @returns {Promise<object>} the answer in the Responses shape
     */
    async function responsesCreate({
        model = null, instructions = null, input = null, parts = null, tools = null,
        schema = null, schemaName = 'response', strict = true, effort = null, summary = null,
        mode = null, maxOutputTokens = null, temperature = null, store = false, truncation = null,
        verbosity = null, stream = false, signal: callSignal = null, onEvent: callEvent = null,
        previousResponseId = null, toolChoice = null, parallelToolCalls = null,
    } = {}) {
        const body = buildResponsesBody({
            model, instructions, input, parts, tools, schema, schemaName, strict, effort, summary, mode,
            maxOutputTokens, temperature, store, truncation, verbosity, stream, previousResponseId,
            toolChoice, parallelToolCalls,
        });
        const wantedModel = model ?? config?.model ?? null;

        try {
            const answer = await call('responses', {
                method: 'POST', body, kind: 'text', model: wantedModel, signal: callSignal,
                stream: stream ? 'responses' : false, onEvent: callEvent, supports: 'responses',
            });
            return answer;
        } catch (error) {
            if (!responsesRouteUnsupported(error)) throw error;
            const gaps = chatGaps(body);
            if (gaps.length) {
                announce({ type: 'transport.fallback', reason: `the host has no Responses API; dropped: ${gaps.join(', ')}` });
            }
            const chatBody = toChatBody(body);
            try {
                const answer = await call(CHAT_PATH, {
                    method: 'POST', body: chatBody, kind: 'text', model: wantedModel, signal: callSignal,
                    stream: stream ? 'chat' : false, onEvent: callEvent, supports: 'chat',
                });
                return normalizeChatResult(answer, { model: wantedModel });
            } catch (chatError) {
                // A strict gateway may refuse one optional field: drop it and repeat once.
                const { body: stripped, removed } = stripRejectedFields(chatBody, chatError);
                if (!removed.length) throw chatError;
                announce({ type: 'request.adjust', removed });
                const answer = await call(CHAT_PATH, {
                    method: 'POST', body: stripped, kind: 'text', model: wantedModel, signal: callSignal,
                    stream: stream ? 'chat' : false, onEvent: callEvent, supports: 'chat',
                });
                return normalizeChatResult(answer, { model: wantedModel });
            }
        }
    }

    /**
     * Download an image the API answered with a URL.
     * @param {string} url
     * @param {AbortSignal|null} callSignal
     * @returns {Promise<{ bytes: Buffer, mime: string }>}
     * @ai.hint io
     */
    async function fetchImage(url, callSignal) {
        const target = new URL(url);
        const res = await transport.request({
            url: target,
            method: 'GET',
            headers: { Accept: 'image/*' },
            signal: callSignal ?? signal,
        });
        if (res.status >= 400) throw await apiErrorFrom(res, null);
        const bytes = await readBody(res.body, defaults.maxResponseBytes);
        return { bytes, mime: sniffImage(bytes).mime };
    }

    /**
     * Turn an image API answer into bytes.
     * @param {object} answer
     * @param {AbortSignal|null} callSignal
     * @returns {Promise<Array<{ bytes: Buffer, mime: string }>>}
     * @ai.hint io
     */
    async function imageBytes(answer, callSignal) {
        const out = [];
        for (const source of imageSources(answer)) {
            if (source.kind === 'b64') {
                const bytes = Buffer.from(source.value, 'base64');
                out.push({ bytes, mime: sniffImage(bytes).mime });
            } else {
                out.push(await fetchImage(source.value, callSignal));
            }
        }
        return out;
    }

    return {
        /**
         * The Responses API.
         */
        responses: {
            create: responsesCreate,
        },

        /**
         * The Chat Completions API, for hosts that serve only that route.
         */
        chat: {
            /**
             * @param {{ model?: string|null, messages?: object[], stream?: boolean, signal?: AbortSignal|null, onEvent?: Function|null }} params
             * @returns {Promise<object>}
             */
            async create({ model = null, messages = [], stream = false, signal: callSignal = null, onEvent: callEvent = null } = {}) {
                const body = { model: model ?? config?.model ?? null, messages };
                const answer = await call(CHAT_PATH, {
                    method: 'POST', body, kind: 'text', model: body.model, signal: callSignal,
                    stream: stream ? 'chat' : false, onEvent: callEvent, supports: 'chat',
                });
                return normalizeChatResult(answer, { model: body.model });
            },
        },

        /**
         * The images API: generation and editing.
         */
        images: {
            /**
             * Generate an image.
             * @param {{ model?: string|null, prompt: string, size?: string|null, format?: string|null, quality?: string|null, background?: string|null, n?: number|null, signal?: AbortSignal|null }} params
             * @returns {Promise<{ images: Array<{ bytes: Buffer, mime: string }> }>}
             */
            async generate({
                model = null, prompt, size = null, format = null, quality = null, background = null,
                n = null, signal: callSignal = null,
            } = {}) {
                const usedModel = model ?? config?.imageModel ?? config?.model ?? null;
                const fields = imageSizeFields({ size, model: usedModel, format, quality });
                const body = { model: usedModel, prompt, ...fields };
                if (n) body.n = n;
                const bg = backgroundValue({ model: usedModel, format, background });
                if (bg) body.background = bg;
                const answer = await call('images/generations', {
                    method: 'POST', body, kind: 'images', model: usedModel, signal: callSignal, supports: 'images',
                });
                return { images: await imageBytes(answer, callSignal), raw: answer };
            },

            /**
             * Edit an image. The mask marks the area to change; without it the whole picture is
             * the source.
             * @param {{ model?: string|null, prompt: string, image: { filename: string, mime?: string, bytes: Buffer }, mask?: { filename: string, mime?: string, bytes: Buffer }|null, size?: string|null, format?: string|null, quality?: string|null, background?: string|null, n?: number|null, signal?: AbortSignal|null }} params
             * @returns {Promise<{ images: Array<{ bytes: Buffer, mime: string }> }>}
             */
            async edit({
                model = null, prompt, image, mask = null, size = null, format = null, quality = null,
                background = null, n = null, signal: callSignal = null,
            } = {}) {
                const usedModel = model ?? config?.imageModel ?? config?.model ?? null;
                const fields = imageSizeFields({ size, model: usedModel, format, quality });
                const bg = backgroundValue({ model: usedModel, format, background });
                const form = {
                    model: usedModel,
                    prompt,
                    ...fields,
                    ...(n ? { n: String(n) } : {}),
                    ...(bg ? { background: bg } : {}),
                };
                const files = [{
                    field: 'image',
                    filename: image?.filename ?? 'image.png',
                    mime: image?.mime ?? sniffImage(image?.bytes).mime,
                    bytes: image?.bytes ?? Buffer.alloc(0),
                }];
                if (mask?.bytes) {
                    files.push({
                        field: 'mask',
                        filename: mask.filename ?? 'mask.png',
                        mime: mask.mime ?? sniffImage(mask.bytes).mime,
                        bytes: mask.bytes,
                    });
                }
                const { body: rawBody, contentType } = encodeMultipart({ fields: form, files });
                const answer = await call('images/edits', {
                    method: 'POST', rawBody, contentType, kind: 'images', model: usedModel, signal: callSignal, supports: 'images',
                });
                return { images: await imageBytes(answer, callSignal), raw: answer };
            },
        },

        /**
         * The models route, for diagnostics.
         */
        models: {
            /**
             * @param {{ signal?: AbortSignal|null }} [params]
             * @returns {Promise<object>}
             */
            async list({ signal: callSignal = null } = {}) {
                return call('models', { method: 'GET', kind: 'text', signal: callSignal });
            },
        },

        /**
         * The backends of one route kind as sticky channels.
         *
         * A channel talks to one host and never rotates, which is what an asynchronous task
         * needs: the task id belongs to the host that created it, so the task is polled there.
         * @param {'text'|'images'} kind
         * @param {string|null} model the model the request names; a per-model list wins
         * @returns {Array<{ label: string, baseURL: string, call: Function }>}
         */
        channels(kind = 'text', model = null) {
            return resolveBackends(config, { kind, model, env }).map((backend) => ({
                label: backend.baseURL,
                baseURL: backend.baseURL,
                call: (path, options = {}) => callBackend(backend, path, options),
            }));
        },

        /**
         * The backends in use, for diagnostics and dry runs.
         * @returns {Array<{ baseURL: string, apiKey: string|null, supports: object }>}
         */
        backends({ kind = 'text', model = null } = {}) {
            return resolveBackends(config, { kind, model, env });
        },

        /**
         * Close the transport.
         * @returns {void}
         * @ai.hint io
         */
        close() {
            transport.close();
        },
    };
}

export { ApiError };
