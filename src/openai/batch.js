/**
 * @file src/openai/batch.js
 * @module openai/batch
 * @purpose The batch route of the OpenAI-compatible hosts: a file of requests, one batch, and
 *          later — in another run — the file of the answers.
 *
 *   The batch route is two-phase by nature. The first phase uploads the file of the requests and
 *   creates the batch; the host works on it in the background, up to a day. The second phase asks
 *   the host how the batch is doing and, when it is done, downloads the file of the answers. The
 *   answers are named by `custom_id`, and that name is the only way back to the question: the
 *   order of the lines of the result file is not the order of the questions.
 *
 *   A batch costs half the price of the same requests one by one, and a request that fails inside
 *   a batch does not spoil the others.
 *
 * @depends node:timers/promises, openai/errors, openai/images
 * @usedBy openai/client
 * @exports BATCH_ENDPOINT, BATCH_WINDOW, BATCH_SUBMITTED, batchEndpointFor, buildBatchJsonl,
 *          parseBatchResults, submitBatch, fetchBatch, runBatch, createBatcher, batchSubmittedError
 * @ai.tags openai, batch, api
 * @ai.hint io
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { ApiError } from './errors.js';
import { encodeMultipart } from './images.js';

/** The route the batch speaks: the same one the requests inside it use. */
export const BATCH_ENDPOINT = '/v1/responses';

/** The window the hosts serve: a day is the only one they know. */
export const BATCH_WINDOW = '24h';

/** The code of the error that says: the batch is out, the answers are not here yet. */
export const BATCH_SUBMITTED = 'BATCH_SUBMITTED';

/** How often the state of the batch is asked for. */
const DEFAULT_POLL_MS = 5000;

/** How long the client waits for the batch before it gives up. */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** The states a batch does not come out of. */
const FINAL_STATUS = new Set(['failed', 'expired', 'cancelled']);

/**
 * The error that stops the run: the batch is submitted, the answers are not here yet.
 * @param {{ batchId?: string|null, requests?: number }} [details]
 * @returns {ApiError}
 * @ai.hint pure
 */
export function batchSubmittedError({ batchId = null, requests = 0 } = {}) {
    return new ApiError(
        `The batch ${batchId ?? ''} was submitted (${requests} request(s)); the answers are not here yet.`,
        { code: BATCH_SUBMITTED, details: { batchId, requests } },
    );
}

/**
 * The route of the batch for one host.
 *
 * The line of a request names the route it goes to, and the route of the batch has to be the
 * same one. The base URL of a host ends with the prefix of the API (`/v1`), so the route is that
 * prefix and the name of the API.
 * @param {string} baseURL the base URL of the host
 * @param {string} [route] the name of the API
 * @returns {string} the path of the route, e.g. `/v1/responses`
 * @ai.hint pure
 */
export function batchEndpointFor(baseURL, route = 'responses') {
    let pathname = '/v1';
    try {
        pathname = new URL(String(baseURL)).pathname.replace(/\/+$/, '');
    } catch {
        pathname = '/v1';
    }
    if (!pathname) pathname = '/v1';
    if (!pathname.endsWith('/v1')) pathname = `${pathname}/v1`;
    return `${pathname}/${route}`;
}

/**
 * The file of a batch: one request per line, no commas between the lines.
 *
 * Every line names the request by `custom_id`, and that name is the only way back to the answer:
 * the order of the lines of the result file is not the order of the questions.
 * @param {Array<{ customId: string, url?: string, method?: string, body?: object }>} requests
 * @returns {Buffer} the file
 * @ai.hint pure
 */
export function buildBatchJsonl(requests = []) {
    const lines = [];
    for (const request of requests) {
        if (!request?.customId) continue;
        lines.push(JSON.stringify({
            custom_id: String(request.customId),
            method: String(request.method ?? 'POST'),
            url: String(request.url ?? BATCH_ENDPOINT),
            body: request.body ?? {},
        }));
    }
    return Buffer.from(lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
}

/**
 * The answers of a batch: the file of the result, one answer per line.
 *
 * A request that failed has an `error` of its own and does not spoil the others: the line is
 * read as a failure, not as the end of the file.
 * @param {string} text the result file
 * @returns {Map<string, { ok: boolean, body?: object, status?: number, error?: string }>}
 * @ai.hint pure
 */
export function parseBatchResults(text) {
    const out = new Map();
    for (const line of String(text ?? '').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let row = null;
        try { row = JSON.parse(trimmed); } catch { continue; }
        const customId = String(row?.custom_id ?? '').trim();
        if (!customId) continue;
        const status = Number(row?.response?.status_code ?? 0);
        if (row?.error) {
            const reason = row.error?.message ?? row.error?.code ?? 'the request failed';
            out.set(customId, { ok: false, error: String(reason) });
            continue;
        }
        if (row?.response?.body === undefined || row?.response?.body === null) {
            out.set(customId, { ok: false, error: `the answer has no body (status ${status || 'unknown'})` });
            continue;
        }
        out.set(customId, { ok: true, body: row.response.body, status });
    }
    return out;
}

/**
 * Upload the file of the requests.
 * @param {{ call: Function }} channel the host the batch belongs to
 * @param {Buffer} jsonl the file
 * @param {{ filename?: string, signal?: AbortSignal|null }} [options]
 * @returns {Promise<string>} the id of the file
 * @ai.hint io
 */
async function uploadBatchFile(channel, jsonl, { filename = 'batch.jsonl', signal = null } = {}) {
    const { body, contentType } = encodeMultipart({
        fields: { purpose: 'batch' },
        files: [{ field: 'file', filename, mime: 'application/jsonl', bytes: jsonl }],
    });
    const answer = await channel.call('files', { method: 'POST', rawBody: body, contentType, signal });
    const id = String(answer?.id ?? '').trim();
    if (!id) {
        throw new ApiError('The host did not return the id of the batch file.', {
            code: 'INVALID_RESPONSE',
            details: { keys: Object.keys(answer ?? {}) },
        });
    }
    return id;
}

/**
 * Create the batch of the uploaded file.
 * @param {{ call: Function }} channel the host the batch belongs to
 * @param {{ inputFileId: string, endpoint?: string, window?: string, signal?: AbortSignal|null }} options
 * @returns {Promise<{ id: string, status: string, raw: object }>}
 * @ai.hint io
 */
async function createBatch(channel, {
    inputFileId, endpoint = BATCH_ENDPOINT, window = BATCH_WINDOW, signal = null,
} = {}) {
    const answer = await channel.call('batches', {
        method: 'POST',
        body: { input_file_id: inputFileId, endpoint, completion_window: window },
        signal,
    });
    const id = String(answer?.id ?? '').trim();
    if (!id) {
        throw new ApiError('The host did not return the id of the batch.', {
            code: 'INVALID_RESPONSE',
            details: { keys: Object.keys(answer ?? {}) },
        });
    }
    return { id, status: String(answer?.status ?? 'unknown'), raw: answer };
}

/**
 * Wait for the batch to be done.
 * @param {{ call: Function }} channel the host the batch belongs to
 * @param {string} id the id of the batch
 * @param {{ signal?: AbortSignal|null, timeoutMs?: number, pollMs?: number, onPoll?: Function|null }} [options]
 * @returns {Promise<object>} the answer of the host
 * @ai.hint io
 */
async function waitBatch(channel, id, {
    signal = null, timeoutMs = DEFAULT_TIMEOUT_MS, pollMs = DEFAULT_POLL_MS, onPoll = null,
} = {}) {
    const startedAt = Date.now();
    let polls = 0;
    for (;;) {
        signal?.throwIfAborted();
        const answer = await channel.call(`batches/${encodeURIComponent(id)}`, { method: 'GET', signal });
        polls += 1;
        const status = String(answer?.status ?? 'unknown');
        try { onPoll?.({ id, status, polls, elapsedMs: Date.now() - startedAt }); } catch { /* observer */ }
        if (status === 'completed') return answer;
        if (FINAL_STATUS.has(status)) {
            throw new ApiError(`The batch ended with the status "${status}".`, {
                code: 'BATCH_FAILED',
                details: { id, status, errors: answer?.errors ?? null },
            });
        }
        if (Date.now() - startedAt > timeoutMs) {
            throw new ApiError(`The batch did not finish within ${Math.round(timeoutMs / 60_000)} min (batch ${id}).`, {
                code: 'BATCH_TIMEOUT',
                details: { id, polls },
            });
        }
        await sleep(pollMs, undefined, { signal }).catch(() => {
            throw new ApiError('Waiting for the batch was interrupted.', { code: 'ABORTED' });
        });
    }
}

/**
 * Download the file of the answers.
 * @param {{ call: Function }} channel the host the batch belongs to
 * @param {string} fileId the id of the output file
 * @param {{ signal?: AbortSignal|null }} [options]
 * @returns {Promise<string>} the file
 * @ai.hint io
 */
async function downloadBatchFile(channel, fileId, { signal = null } = {}) {
    const answer = await channel.call(`files/${encodeURIComponent(fileId)}/content`, {
        method: 'GET',
        signal,
        raw: true,
    });
    if (typeof answer === 'string') return answer;
    return String(answer?.body ?? '');
}

/**
 * The first phase of the batch: the file goes out, the batch is created, the run waits.
 *
 * The host works on the batch in the background — up to a day — and the answers come in another
 * run, when the client asks for them.
 * @param {{ channel: { call: Function }, requests: Array<{ customId: string, url?: string, body?: object }>,
 *   endpoint?: string, window?: string, signal?: AbortSignal|null }} options
 * @returns {Promise<{ id: string, status: string, inputFileId: string, raw: object }>}
 * @ai.hint io
 */
export async function submitBatch({
    channel, requests = [], endpoint = BATCH_ENDPOINT, window = BATCH_WINDOW, signal = null,
} = {}) {
    if (!channel || typeof channel.call !== 'function') {
        throw new ApiError('The batch has no host to run on.', { code: 'NO_BACKEND' });
    }
    const jsonl = buildBatchJsonl(requests);
    if (!jsonl.length) {
        throw new ApiError('The batch has no requests.', { code: 'INVALID_RESPONSE' });
    }
    const inputFileId = await uploadBatchFile(channel, jsonl, { signal });
    const batch = await createBatch(channel, { inputFileId, endpoint, window, signal });
    return { ...batch, inputFileId };
}

/**
 * The second phase of the batch: ask how it is doing and, when it is done, take the answers.
 *
 * The wait is short by default: the batch may need hours, and a run that waits for it would
 * look like a hung one. The answer says whether the batch is ready — the caller decides what to
 * do with a batch that is not.
 * @param {{ channel: { call: Function }, id: string, pollMs?: number, waitMs?: number,
 *   signal?: AbortSignal|null, onPoll?: Function|null }} options
 * @returns {Promise<{ ready: boolean, id: string, status: string, results: Map<string, object>, raw: object }>}
 * @ai.hint io
 */
export async function fetchBatch({
    channel, id, pollMs = DEFAULT_POLL_MS, waitMs = 0, signal = null, onPoll = null,
} = {}) {
    if (!channel || typeof channel.call !== 'function') {
        throw new ApiError('The batch has no host to ask.', { code: 'NO_BACKEND' });
    }
    const deadline = Date.now() + Math.max(0, waitMs);
    for (;;) {
        signal?.throwIfAborted();
        const answer = await channel.call(`batches/${encodeURIComponent(id)}`, { method: 'GET', signal });
        const status = String(answer?.status ?? 'unknown');
        try { onPoll?.({ id, status }); } catch { /* observer */ }
        if (status === 'completed') {
            const outputFileId = String(answer?.output_file_id ?? '').trim();
            if (!outputFileId) {
                throw new ApiError('The batch is done, but it has no file of answers.', {
                    code: 'INVALID_RESPONSE',
                    details: { id },
                });
            }
            const text = await downloadBatchFile(channel, outputFileId, { signal });
            return { ready: true, id, status, results: parseBatchResults(text), raw: answer };
        }
        if (FINAL_STATUS.has(status)) {
            throw new ApiError(`The batch ended with the status "${status}".`, {
                code: 'BATCH_FAILED',
                details: { id, status, errors: answer?.errors ?? null },
            });
        }
        if (Date.now() >= deadline) {
            return { ready: false, id, status, results: new Map(), raw: answer };
        }
        await sleep(pollMs, undefined, { signal }).catch(() => {
            throw new ApiError('Waiting for the batch was interrupted.', { code: 'ABORTED' });
        });
    }
}

/**
 * Run the requests as one batch and wait for the answers: upload, create, wait, download.
 *
 * The two-phase client does not use it — it submits in one run and fetches in another — but the
 * hosts that answer quickly are served by it, and it is the shortest way to check the route.
 * @param {{ channel: { call: Function }, requests: Array<{ customId: string, url?: string, body?: object }>,
 *   endpoint?: string, window?: string, pollMs?: number, timeoutMs?: number,
 *   signal?: AbortSignal|null, onPoll?: Function|null }} options
 * @returns {Promise<{ id: string, results: Map<string, object>, raw: object }>}
 * @ai.hint io
 */
export async function runBatch({
    channel, requests = [], endpoint = BATCH_ENDPOINT, window = BATCH_WINDOW,
    pollMs = DEFAULT_POLL_MS, timeoutMs = DEFAULT_TIMEOUT_MS, signal = null, onPoll = null,
} = {}) {
    const batch = await submitBatch({ channel, requests, endpoint, window, signal });
    const done = await waitBatch(channel, batch.id, { signal, timeoutMs, pollMs, onPoll });
    const outputFileId = String(done?.output_file_id ?? '').trim();
    if (!outputFileId) {
        throw new ApiError('The batch is done, but it has no file of answers.', {
            code: 'INVALID_RESPONSE',
            details: { id: batch.id },
        });
    }
    const text = await downloadBatchFile(channel, outputFileId, { signal });
    return { id: batch.id, results: parseBatchResults(text), raw: done };
}

/**
 * The queue of the requests that wait for each other.
 *
 * The client puts every request of a parallel round here instead of sending it at once, and the
 * queue is sent when the round is over: one request goes the usual way, several go as one batch.
 *
 * The queue answers in one of two ways. In the blocking mode the answers come back and the
 * round continues. In the two-phase mode the batch is only submitted — the answers are not here
 * yet — and every request of the round is refused with the error that stops the run.
 *
 * @param {{ send: Function, run: Function, collectMs?: number, maxRequests?: number,
 *   announce?: Function|null }} options
 *   `send` sends one request the usual way, `run` sends a group of them as a batch.
 * @returns {{ add: Function, flush: Function, size: Function }}
 * @ai.hint io
 */
export function createBatcher({
    send, run, collectMs = 1500, maxRequests = 64, announce = null,
} = {}) {
    const queue = [];
    let timer = null;
    let firstAt = 0;
    let busy = null;
    let counter = 0;

    /**
     * Plan the sending of the queue.
     *
     * The queue waits for the last request of the round: every request that comes in pushes the
     * sending a little further away. The wait is bounded, though — a round that never ends must
     * not hold the requests forever.
     * @returns {void}
     * @ai.hint io
     */
    const schedule = () => {
        if (queue.length >= maxRequests) return;
        if (!firstAt) firstAt = Date.now();
        if (timer) clearTimeout(timer);
        const limit = firstAt + Math.max(collectMs * 4, 1000);
        const wait = Math.max(0, Math.min(collectMs, limit - Date.now()));
        timer = setTimeout(() => {
            timer = null;
            firstAt = 0;
            void flush();
        }, wait);
    };

    /**
     * Send everything that is in the queue.
     * @returns {Promise<void>}
     * @ai.hint io
     */
    async function flush() {
        if (busy) {
            await busy;
            return;
        }
        if (!queue.length) return;
        const items = queue.splice(0, queue.length);
        busy = (async () => {
            // The run is over: the batch is out and the answers are not here yet.
            let stopped = false;
            // One model per batch: the hosts take the model of the request, but a batch that
            // mixes them is harder to account for than a batch that does not.
            const groups = new Map();
            for (const item of items) {
                const key = String(item.model ?? '');
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(item);
            }
            for (const group of groups.values()) {
                if (group.length === 1) {
                    // One request is not a batch: it goes the usual way, with the stream and the
                    // rotation over the hosts.
                    const item = group[0];
                    try { item.resolve(await send(item.params)); } catch (error) { item.reject(error); }
                    continue;
                }
                let outcome = null;
                try {
                    outcome = await run(group);
                } catch (error) {
                    if (error?.code === BATCH_SUBMITTED) {
                        for (const item of group) item.reject(error);
                        stopped = true;
                        break;
                    }
                    // The batch did not work out: the requests go the usual way after all.
                    try {
                        announce?.({
                            type: 'batch.failed',
                            error: error?.message ?? String(error),
                            requests: group.length,
                        });
                    } catch { /* observer */ }
                    for (const item of group) {
                        try { item.resolve(await send(item.params)); } catch (fallbackError) { item.reject(fallbackError); }
                    }
                    continue;
                }
                if (outcome?.pending) {
                    // The two-phase mode: the batch is out, the answers are not here yet.
                    const error = batchSubmittedError({ batchId: outcome.batchId ?? null, requests: group.length });
                    for (const item of group) item.reject(error);
                    stopped = true;
                    break;
                }
                for (const item of group) {
                    const answer = outcome?.get?.(item.customId);
                    if (answer?.ok) {
                        item.resolve(answer.body);
                    } else if (answer) {
                        item.reject(new ApiError(answer.error ?? 'the request failed in the batch', {
                            code: 'BATCH_REQUEST_FAILED',
                            details: { customId: item.customId },
                        }));
                    } else {
                        item.reject(new ApiError('The batch has no answer for this request.', {
                            code: 'BATCH_REQUEST_MISSING',
                            details: { customId: item.customId },
                        }));
                    }
                }
            }
            // The requests that are still in the queue will never be answered: the run is over.
            if (stopped) {
                for (const item of queue.splice(0, queue.length)) {
                    item.reject(batchSubmittedError({ requests: 1 }));
                }
            }
        })();
        try {
            await busy;
        } finally {
            busy = null;
        }
        if (queue.length) schedule();
    }

    return {
        /**
         * Put one request into the queue.
         * @param {object} params the parameters of the request
         * @returns {Promise<object>} the answer
         */
        add(params) {
            return new Promise((resolve, reject) => {
                counter += 1;
                queue.push({
                    customId: params?.customId ?? `req-${counter}`,
                    model: params?.model ?? null,
                    params,
                    resolve,
                    reject,
                });
                if (queue.length >= maxRequests) {
                    if (timer) { clearTimeout(timer); timer = null; firstAt = 0; }
                    void flush();
                    return;
                }
                schedule();
            });
        },
        flush,
        size: () => queue.length,
    };
}
