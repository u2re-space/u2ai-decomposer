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
import { ApiError, outOfCredit } from './errors.js';
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
import { fallbackChain } from './fallback.js';
import {
    BATCH_ENDPOINT, BATCH_WINDOW, BATCH_SUBMITTED, batchEndpointFor, createBatcher,
    fetchBatch, submitBatch,
} from './batch.js';

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
 * `images` uses `imagesBackends` (and falls back to `backends`), `text` uses `backends`, and
 * `layers` uses `layerBackends` — the host that splits a screen into layers is a different one.
 * A per-model list in `modelsBackends` wins over the general one: a model is often served
 * by a host that the general list does not know about.
 * @param {object} config
 * @param {{ kind?: 'text'|'images'|'layers', model?: string|null, env?: object }} [options]
 * @returns {Array<{ baseURL: string, apiKey: string|null, headers: object, body: object, supports: object }>}
 * @exports
 */
export function resolveBackends(config, { kind = 'text', model = null, env = process.env } = {}) {
    const general = kind === 'images'
        ? (Array.isArray(config?.imagesBackends) && config.imagesBackends.length ? config.imagesBackends : config?.backends)
        : (kind === 'layers' ? config?.layerBackends : config?.backends);
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
    // The layer route is served by one host and one model: a host without a key cannot answer,
    // and the host of the text route does not know the model at all.
    if (kind === 'layers') return chain.filter((item) => item.apiKey);
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
 * The stall timeout of one route.
 *
 * The timeout is not a budget of the whole call: it is the time the host may stay silent.
 * A text call that is streamed keeps sending events while the model thinks, so the window
 * only fires when the host really stops. An image call has no stream at all — the picture
 * comes in one piece — so it needs a window of its own, longer than the text one.
 *
 * @param {object} config the loaded configuration
 * @param {'text'|'images'} kind the route
 * @returns {number} the milliseconds of silence the host may keep
 * @exports
 * @ai.hint pure
 */
export function requestTimeoutMs(config, kind = 'text') {
    if (kind === 'images') {
        const value = Number(config?.imageTimeoutMs);
        if (Number.isSafeInteger(value) && value >= 5_000) return value;
        return 900_000;
    }
    const value = Number(config?.timeoutMs);
    if (Number.isSafeInteger(value) && value >= 5_000) return value;
    return 600_000;
}

/**
 * Did the host refuse the route because of the `stream` flag?
 *
 * A gateway that serves the Responses route but not as a stream answers with a 400 and
 * the word "stream" in the message. The caller repeats the request without the flag.
 * @param {object} error the error of the call
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function streamUnsupported(error) {
    const status = Number(error?.status ?? 0);
    if (status !== 400 && status !== 422 && status !== 501) return false;
    return /stream/i.test(String(error?.message ?? ''));
}

/**
 * Create an API client for the configured backends.
 *
 * The client owns the transport only: it knows the routes, the retries and the rotation
 * between hosts. What a request means is decided by the caller (roles, stages).
 * @param {{ config: object, env?: object, signal?: AbortSignal|null, onEvent?: Function|null,
 *   batch?: { mode?: 'off'|'submit'|'fetch', journal?: object|null, collectMs?: number,
 *     pollMs?: number, waitMs?: number, maxRequests?: number, window?: string,
 *     endpoint?: string|null }|null }} opts
 *   `batch` turns on the two-phase batch route: the requests of a parallel round go out as one
 *   batch in the `submit` phase, and the answers are taken from the journal in the `fetch` phase.
 * @returns {Promise<object>}
 */
export async function createClient({
    config, env = process.env, signal = null, onEvent = null, batch = null,
} = {}) {
    const transport = createHttp({
        idleTimeoutMs: requestTimeoutMs(config, 'text'),
        connectTimeoutMs: 30_000,
    });
    const retries = Number.isSafeInteger(config?.limits?.requestRetries)
        ? config.limits.requestRetries
        : (Number.isSafeInteger(config?.retries) ? config.retries : defaults.retries);
    const announce = (event) => { try { onEvent?.(event); } catch { /* an observer never breaks a request */ } };
    /** The hosts that refused for the lack of money: they are not asked again in this run. */
    const brokeHosts = new Set();

    // The batch route is two-phase: the requests go out in one run and the answers come in
    // another. The journal is what the two phases share.
    const batchMode = batch?.mode === 'submit' || batch?.mode === 'fetch';
    const journal = batch?.journal ?? null;
    const batchOptions = {
        collectMs: Number.isSafeInteger(batch?.collectMs) ? batch.collectMs : 1500,
        pollMs: Number.isSafeInteger(batch?.pollMs) ? batch.pollMs : 5000,
        waitMs: Number.isSafeInteger(batch?.waitMs) ? batch.waitMs : 0,
        maxRequests: Number.isSafeInteger(batch?.maxRequests) ? batch.maxRequests : 64,
        window: typeof batch?.window === 'string' && batch.window.trim() ? batch.window.trim() : BATCH_WINDOW,
        endpoint: typeof batch?.endpoint === 'string' && batch.endpoint.trim() ? batch.endpoint.trim() : null,
    };
    /** The queue of the requests of a parallel round; it is created when the first one arrives. */
    let batcher = null;

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
        // Some gateways answer with a `detail` instead of a `message`: the reason has to be read.
        const detail = textOf(details.detail);
        const reason = fromBody || detail;
        const message = (reason || text).slice(0, 2000) || `HTTP ${res.status}`;
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
     * @param {{ method?: string, body?: object, rawBody?: Buffer|string, contentType?: string, signal?: AbortSignal|null, stream?: boolean, onEvent?: Function|null, idleTimeout?: number }} options
     * @returns {Promise<object>}
     * @ai.hint io
     */
    async function send(backend, path, {
        method = 'POST', body = null, rawBody = null, contentType = 'application/json',
        signal: callSignal = null, stream = false, onEvent = null, idleTimeout = null,
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
                    idleTimeout: idleTimeout ?? undefined,
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
     * Read a text answer.
     *
     * Some files are not JSON: the result file of a batch is JSONL, one answer per line, and a
     * parser that expects a single JSON object would call it an empty answer.
     * @param {AsyncGenerator<Buffer>} body
     * @returns {Promise<string>}
     * @ai.hint io
     */
    async function readText(body) {
        const raw = await readBody(body, defaults.maxResponseBytes);
        return raw.toString('utf8');
    }

    /**
     * Call one route on one backend, without the rotation.
     * The channels below need it: a task id belongs to the host that created it.
     * @param {object} backend
     * @param {string} path route relative to the base URL
     * @param {{ method?: string, body?: object, rawBody?: Buffer|string, contentType?: string, signal?: AbortSignal|null, stream?: boolean, onEvent?: Function|null, model?: string|null, idleTimeout?: number|null, raw?: boolean }} options
     * @returns {Promise<object>}
     * @ai.hint io
     */
    async function callBackend(backend, path, {
        method = 'POST', body = null, rawBody = null, contentType = 'application/json',
        signal: callSignal = null, stream = false, onEvent: callEvent = null, model = null,
        idleTimeout: callTimeout = null, raw = false,
    } = {}) {
        announce({ type: 'request.start', backend: backend.baseURL, path, model });
        const { res } = await send(backend, path, {
            method, body, rawBody, contentType, signal: callSignal, stream, onEvent: callEvent,
            idleTimeout: callTimeout,
        });
        if (raw) return await readText(res.body);
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
        return reducer.finalResponse ? reducer.finalResponse() : reducer.response;
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
        onEvent: callEvent = null, supports = null, idleTimeout: callTimeout = null,
    } = {}) {
        const chain = resolveBackends(config, { kind, model, env });
        if (!chain.length) {
            throw new ApiError('No backend is configured for this request.', { code: 'NO_BACKEND' });
        }
        // The window of silence depends on the route: an image comes in one piece, a text
        // answer streams.
        const timeout = callTimeout ?? requestTimeoutMs(config, kind);
        let lastError = null;
        for (const backend of chain) {
            if (supports && backend.supports?.[supports] === false) {
                announce({ type: 'request.skip', backend: backend.baseURL, reason: `no ${supports} route` });
                continue;
            }
            // A host that ran out of money is not asked again: the next host takes the request.
            if (brokeHosts.has(backend.baseURL)) {
                announce({ type: 'request.skip', backend: backend.baseURL, reason: 'no balance' });
                continue;
            }
            try {
                const answer = await callBackend(backend, path, {
                    method, body, rawBody, contentType, signal: callSignal, stream, onEvent: callEvent, model,
                    idleTimeout: timeout,
                });
                return answer;
            } catch (error) {
                lastError = error;
                const status = error?.status;
                announce({ type: 'request.error', backend: backend.baseURL, status: status ?? null, error: error.message });
                if (error?.name === 'AbortError' || error?.code === 'ABORTED') throw error;
                // A host without the route is not a host to retry: the caller picks another transport.
                if (supports === 'responses' && responsesRouteUnsupported(error)) break;
                // A host without money is remembered: asking it again only wastes time.
                if (outOfCredit(error)) {
                    brokeHosts.add(backend.baseURL);
                    announce({ type: 'host.broke', backend: backend.baseURL, error: error.message });
                }
                // Otherwise the next backend gets the request.
            }
        }
        throw lastError ?? new ApiError('No backend answered the request.', { code: 'NO_BACKEND' });
    }

    /**
     * The hosts that serve the batch route.
     *
     * A host takes part in a batch only when the config says so: the flag `supports.batch` is
     * the promise of the host that it serves the route of the batch.
     * @returns {Array<{ baseURL: string, apiKey: string|null, headers: object, body: object, supports: object }>}
     * @ai.hint pure
     */
    function batchHosts() {
        return resolveBackends(config, { kind: 'text', env })
            .filter((backend) => backend.supports?.batch === true && backend.apiKey && !brokeHosts.has(backend.baseURL));
    }

    /**
     * The queue of the requests of a parallel round.
     * @returns {{ add: Function, flush: Function, size: Function }}
     * @ai.hint io
     */
    function ensureBatcher() {
        if (batcher) return batcher;
        batcher = createBatcher({
            collectMs: batchOptions.collectMs,
            maxRequests: batchOptions.maxRequests,
            announce,
            // A batch that did not work out is not the end of the run: the requests go the usual way.
            send: async (params) => await responsesCreate(params, { noBatch: true }),
            run: async (group) => await submitGroup(group),
        });
        return batcher;
    }

    /**
     * Submit one group of requests as a batch and remember it in the journal.
     *
     * The answers are not here yet — the host works on the batch in the background — so the round
     * is over: every request of the group is refused with the error that stops the run.
     * @param {Array<{ customId: string, model: string|null, body: object, hash: string|null }>} group
     * @returns {Promise<{ pending: true, batchId: string }>}
     * @ai.hint io
     */
    async function submitGroup(group) {
        const hosts = batchHosts();
        if (!hosts.length) {
            throw new ApiError('No host serves the batch route.', { code: 'NO_BACKEND' });
        }
        let lastError = null;
        for (const backend of hosts) {
            const endpoint = batchOptions.endpoint || batchEndpointFor(backend.baseURL);
            const channel = { call: (path, options = {}) => callBackend(backend, path, options) };
            const requests = group.map((item) => ({
                customId: item.customId,
                url: endpoint,
                body: item.body,
            }));
            try {
                const submitted = await submitBatch({
                    channel,
                    requests,
                    endpoint,
                    window: batchOptions.window,
                    signal,
                });
                for (const item of group) {
                    await journal?.rememberRequest(item.hash, { customId: item.customId, model: item.model });
                }
                await journal?.saveBatch({
                    id: submitted.id,
                    host: backend.baseURL,
                    endpoint,
                    status: submitted.status,
                    requests: group.map((item) => ({
                        customId: item.customId,
                        hash: item.hash,
                        model: item.model,
                    })),
                });
                announce({
                    type: 'batch.submit',
                    id: submitted.id,
                    host: backend.baseURL,
                    endpoint,
                    requests: group.length,
                    status: submitted.status,
                });
                return { pending: true, batchId: submitted.id };
            } catch (error) {
                lastError = error;
                announce({
                    type: 'request.error',
                    backend: backend.baseURL,
                    status: error?.status ?? null,
                    error: error?.message ?? String(error),
                });
                if (outOfCredit(error)) {
                    brokeHosts.add(backend.baseURL);
                    announce({ type: 'host.broke', backend: backend.baseURL, error: error?.message ?? String(error) });
                }
            }
        }
        throw lastError ?? new ApiError('No host took the batch.', { code: 'NO_BACKEND' });
    }

    /**
     * The second phase of the batch: take the answers of the submitted batches into the journal.
     *
     * A batch that is not done yet is not an error: the run says so and stops, and the user runs
     * the fetch again when the host has finished the work.
     * @param {{ waitMs?: number|null }} [options]
     * @returns {Promise<{ ready: boolean, batches: Array<object> }>}
     * @ai.hint io
     */
    async function fetchBatches({ waitMs = null } = {}) {
        if (!journal) return { ready: true, batches: [] };
        const rows = await journal.listBatches();
        const pending = rows.filter((row) => !row.done);
        const report = [];
        for (const row of pending) {
            const backend = resolveBackends(config, { kind: 'text', env })
                .find((item) => item.baseURL === row.host);
            if (!backend || !backend.apiKey) {
                announce({ type: 'batch.missing', id: row.id, host: row.host });
                report.push({ id: row.id, ready: false, status: 'the host is not known' });
                continue;
            }
            const channel = { call: (path, options = {}) => callBackend(backend, path, options) };
            const result = await fetchBatch({
                channel,
                id: row.id,
                pollMs: batchOptions.pollMs,
                waitMs: waitMs ?? batchOptions.waitMs,
                signal,
                onPoll: (info) => announce({ type: 'batch.poll', ...info }),
            });
            if (!result.ready) {
                announce({ type: 'batch.pending', id: row.id, status: result.status });
                report.push({ id: row.id, ready: false, status: result.status });
                continue;
            }
            let answers = 0;
            for (const request of row.requests ?? []) {
                const answer = result.results.get(request.customId);
                if (!answer) {
                    await journal.writeError(request.hash, 'the batch has no answer for this request');
                    continue;
                }
                if (!answer.ok) {
                    await journal.writeError(request.hash, answer.error ?? 'the request failed in the batch');
                    continue;
                }
                await journal.writeJson(request.hash, answer.body);
                answers += 1;
            }
            await journal.updateBatch(row.id, {
                done: true,
                status: 'completed',
                fetchedAt: new Date().toISOString(),
            });
            announce({
                type: 'batch.fetched',
                id: row.id,
                host: row.host,
                requests: (row.requests ?? []).length,
                answers,
            });
            report.push({ id: row.id, ready: true, answers });
        }
        return { ready: report.every((item) => item.ready), batches: report };
    }

    /**
     * The Responses API with a Chat Completions fallback for hosts without the route.
     *
     * A request that may be a part of a parallel round says so: `batchable` is true when the
     * request is the whole question of the role — one turn, no tool loop — and the stage runs
     * several of them at once. Those requests go into the batch instead of going out one by one.
     * @param {object} params
     * @param {{ noBatch?: boolean }} [options] `noBatch` keeps the request out of the queue
     * @returns {Promise<object>} the answer in the Responses shape
     */
    async function responsesCreate({
        model = null, instructions = null, input = null, parts = null, tools = null,
        schema = null, schemaName = 'response', strict = true, effort = null, summary = null,
        mode = null, maxOutputTokens = null, temperature = null, store = false, truncation = null,
        verbosity = null, stream = false, signal: callSignal = null, onEvent: callEvent = null,
        previousResponseId = null, toolChoice = null, parallelToolCalls = null,
        batchable = false,
    } = {}, { noBatch = false } = {}) {
        // The hosts are tried one after another inside `call`. When every one of them refuses
        // the model — no balance, no route — the next model of the fallback chain takes it.
        const wantedModel = model ?? config?.model ?? null;
        const chain = fallbackChain(config, wantedModel);
        const candidates = chain.length ? chain : [model];
        let lastError = null;
        for (const [index, candidate] of candidates.entries()) {
            // The body of the request without the stream: the hash of it is the name of the
            // request, and the body of a line of a batch is exactly this one.
            const canonical = buildResponsesBody({
                model: candidate, instructions, input, parts, tools, schema, schemaName, strict,
                effort, summary, mode, maxOutputTokens, temperature, store, truncation, verbosity,
                stream: false, previousResponseId, toolChoice, parallelToolCalls,
            });
            const hash = journal ? journal.hash(canonical) : null;
            if (hash) {
                // The answer of the same question is already known — it was paid for in an
                // earlier phase of the run.
                const cached = await journal.read(hash);
                if (cached) {
                    if (cached.kind === 'error') {
                        throw new ApiError(cached.value, {
                            code: 'BATCH_REQUEST_FAILED',
                            details: { hash },
                        });
                    }
                    announce({ type: 'journal.hit', hash });
                    return cached.value;
                }
            }
            if (batchMode && batchable && !noBatch && index === 0) {
                return await ensureBatcher().add({
                    model: candidate,
                    body: canonical,
                    hash,
                    params: {
                        model: candidate, instructions, input, parts, tools, schema, schemaName,
                        strict, effort, summary, mode, maxOutputTokens, temperature, store,
                        truncation, verbosity, stream, signal: callSignal, onEvent: callEvent,
                        previousResponseId, toolChoice, parallelToolCalls,
                    },
                });
            }
            try {
                const answer = await responsesCreateWith({
                    model: candidate,
                    instructions, input, parts, tools, schema, schemaName, strict, effort, summary, mode,
                    maxOutputTokens, temperature, store, truncation, verbosity, stream,
                    signal: callSignal, onEvent: callEvent, previousResponseId, toolChoice, parallelToolCalls,
                });
                if (hash) await journal.writeJson(hash, answer);
                return answer;
            } catch (error) {
                lastError = error;
                const next = candidates[index + 1];
                if (!next) throw error;
                announce({
                    type: 'model.fallback',
                    from: candidate,
                    to: next,
                    error: error?.message ?? String(error),
                });
            }
        }
        throw lastError ?? new ApiError('No model answered the request.', { code: 'NO_MODEL' });
    }

    /**
     * One request of the Responses API for one model: the route, and the transport under it.
     * @param {object} params
     * @returns {Promise<object>} the answer in the Responses shape
     */
    async function responsesCreateWith({
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
            // A host that serves the route but not as a stream: the same request without
            // the flag still answers, it just arrives in one piece.
            if (stream && streamUnsupported(error)) {
                announce({ type: 'transport.adjust', reason: 'the host does not serve the route as a stream' });
                const answer = await call('responses', {
                    method: 'POST', body, kind: 'text', model: wantedModel, signal: callSignal,
                    stream: false, onEvent: callEvent, supports: 'responses',
                });
                return answer;
            }
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
         * The batch route: two phases, two runs.
         *
         * The first phase submits the requests of a parallel round as one batch; the second phase
         * takes the answers of the submitted batches into the journal and lets the run go on.
         */
        batches: {
            /** The mode of this client: `off`, `submit` or `fetch`. */
            mode: batch?.mode ?? 'off',
            /** Is the batch route in use at all? */
            enabled: batchMode,
            /** The hosts that serve the batch route. */
            hosts: () => batchHosts().map((backend) => backend.baseURL),
            /** The second phase: take the answers of the submitted batches into the journal. */
            fetch: async (options = {}) => await fetchBatches(options),
            /** The queue of the requests of a parallel round; it is empty when the run is over. */
            pending: () => batcher?.size() ?? 0,
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
                const wanted = model ?? config?.imageModel ?? config?.model ?? null;
                // The hosts of `imagesBackends` are tried one after another inside `call`. When every
                // one of them refuses the model — no balance, no route — the next model of the
                // fallback chain gets the request.
                const chain = fallbackChain(config, wanted);
                let lastError = null;
                for (const [index, candidate] of chain.entries()) {
                    try {
                        const fields = imageSizeFields({ size, model: candidate, format, quality });
                        const body = { model: candidate, prompt, ...fields };
                        if (n) body.n = n;
                        const bg = backgroundValue({ model: candidate, format, background });
                        if (bg) body.background = bg;
                        const answer = await call('images/generations', {
                            method: 'POST', body, kind: 'images', model: candidate, signal: callSignal, supports: 'images',
                        });
                        return { images: await imageBytes(answer, callSignal), raw: answer, model: candidate };
                    } catch (error) {
                        lastError = error;
                        const next = chain[index + 1];
                        if (!next) throw error;
                        announce({
                            type: 'model.fallback',
                            from: candidate,
                            to: next,
                            error: error?.message ?? String(error),
                        });
                    }
                }
                throw lastError ?? new ApiError('No model answered the request.', { code: 'NO_MODEL' });
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
                const wanted = model ?? config?.imageModel ?? config?.model ?? null;
                const chain = fallbackChain(config, wanted);
                let lastError = null;
                for (const [index, candidate] of chain.entries()) {
                    const fields = imageSizeFields({ size, model: candidate, format, quality });
                    const bg = backgroundValue({ model: candidate, format, background });
                    const form = {
                        model: candidate,
                        prompt,
                        ...fields,
                        ...(n ? { n: String(n) } : {}),
                        ...(bg ? { background: bg } : {}),
                    };
                    // The name of the edit: the same fragment under the same instruction is the
                    // same edit, and an edit that is paid for twice is an edit that costs twice.
                    const key = journal ? journal.hash({
                        kind: 'images.edit',
                        model: candidate,
                        prompt,
                        fields,
                        background: bg,
                        n: n ?? null,
                        image: journal.hashBytes(image?.bytes ?? Buffer.alloc(0)),
                        mask: mask?.bytes ? journal.hashBytes(mask.bytes) : null,
                    }) : null;
                    if (key) {
                        const cached = await journal.read(key);
                        if (cached?.kind === 'bytes') {
                            const bytes = cached.value;
                            announce({ type: 'journal.hit', hash: key });
                            return {
                                images: [{ bytes, mime: sniffImage(bytes).mime }],
                                raw: null,
                                model: candidate,
                            };
                        }
                        if (cached?.kind === 'error') {
                            throw new ApiError(cached.value, {
                                code: 'BATCH_REQUEST_FAILED',
                                details: { hash: key },
                            });
                        }
                    }
                    try {
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
                            method: 'POST', rawBody, contentType, kind: 'images', model: candidate, signal: callSignal, supports: 'images',
                        });
                        const images = await imageBytes(answer, callSignal);
                        if (key && images[0]?.bytes) await journal.writeBytes(key, images[0].bytes);
                        return { images, raw: answer, model: candidate };
                    } catch (error) {
                        lastError = error;
                        const next = chain[index + 1];
                        if (!next) throw error;
                        announce({
                            type: 'model.fallback',
                            from: candidate,
                            to: next,
                            error: error?.message ?? String(error),
                        });
                    }
                }
                throw lastError ?? new ApiError('No model answered the request.', { code: 'NO_MODEL' });
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
         * @param {'text'|'images'|'layers'} kind
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
