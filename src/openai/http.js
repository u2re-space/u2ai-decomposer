/**
 * @file src/openai/http.js
 * @module openai/http
 * @purpose HTTPS transport with an explicit idle timeout, plus a capped body reader.
 * @depends node:http, node:https, openai/errors
 * @usedBy openai/client
 * @exports createHttp, readBody, transientNetwork
 * @ai.tags http
 * @ai.hint io
 */
import http from 'node:http';
import https from 'node:https';
import { ApiError } from './errors.js';

/** Socket errors that mean "try again", not "this host is broken". */
const TRANSIENT_NETWORK = new Set([
    'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE',
    'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'ENETRESET', 'ECONNABORTED', 'EHOSTDOWN',
]);

/**
 * True when the socket error is a timeout or a route change, not a permanent refusal.
 * @param {{ code?: string, message?: string }} error
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function transientNetwork(error) {
    if (TRANSIENT_NETWORK.has(error?.code)) return true;
    return /network changed|ENETRESET|EAI_AGAIN|ETIMEDOUT|ECONNRESET/i.test(String(error?.message ?? ''));
}

/**
 * Minimal HTTP transport on node:http(s).
 *
 * Why not global fetch: Node's bundled undici applies a hidden ~5 minute body timeout
 * and exposes no public way to tune it without the undici package. Long reasoning runs
 * can be silent for longer than that, so we drive sockets directly and apply an explicit
 * idle timeout.
 *
 * `request()` resolves as soon as response headers arrive. `body` is an async iterable
 * of Buffers; our own timeout / abort errors are rethrown from the iterator.
 * @param {{ connectTimeoutMs?: number, idleTimeoutMs?: number, keepAlive?: boolean, userAgent?: string }} [options]
 * @returns {{ request: Function, close: Function }}
 */
export function createHttp({
    connectTimeoutMs = 30_000, idleTimeoutMs = 600_000, keepAlive = true,
    userAgent = 'ai-decompose/0.3 (node)',
} = {}) {
    const agents = {
        'https:': new https.Agent({ keepAlive, maxSockets: 8 }),
        'http:': new http.Agent({ keepAlive, maxSockets: 8 }),
    };

    /**
     * `https` for normal hosts. `http` only for localhost.
     * @param {URL} url
     * @returns {typeof import('node:http')|typeof import('node:https')}
     * @ai.hint pure
     */
    function moduleFor(url) {
        if (url.protocol === 'https:') return https;
        if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return http;
        throw new TypeError('Only HTTPS addresses are allowed (HTTP is for localhost only).');
    }

    /**
     * Send one request and resolve when response headers arrive. The body is an async iterable.
     * @param {{ url: URL|string, method?: string, headers?: object, body?: string|Buffer, signal?: AbortSignal, idleTimeout?: number }} options
     * @returns {Promise<{ status: number, headers: object, body: AsyncGenerator<Buffer>, destroy: () => void }>}
     * @ai.hint io
     */
    function request({ url, method = 'GET', headers = {}, body, signal, idleTimeout = idleTimeoutMs }) {
        const target = url instanceof URL ? url : new URL(url);
        const transport = moduleFor(target);
        signal?.throwIfAborted();
        return new Promise((resolve, reject) => {
            let settled = false;
            let failure = null;
            const req = transport.request(target, {
                method,
                agent: agents[target.protocol],
                headers: {
                    'User-Agent': userAgent,
                    Accept: 'application/json',
                    ...headers,
                    ...(body !== undefined ? { 'Content-Length': Buffer.byteLength(body) } : {}),
                },
            });
            /**
             * Record the first failure, destroy the request, and reject if headers have not arrived.
             * @param {Error} error
             * @returns {void}
             * @ai.hint io
             */
            const fail = (error) => {
                failure ??= error;
                req.destroy(error);
                if (!settled) { settled = true; cleanup(); reject(error); }
            };
            /**
             * Turn the abort signal into the first failure.
             * @returns {void}
             * @ai.hint io
             */
            const onAbort = () => fail(signal.reason instanceof Error ? signal.reason
                : new ApiError('Request cancelled.', { code: 'ABORTED' }));
            const connectTimer = setTimeout(() => fail(new ApiError(
                `Could not connect to ${target.host} within ${connectTimeoutMs} ms.`,
                { code: 'CONNECT_TIMEOUT', retryable: true })), connectTimeoutMs);
            /**
             * Clear the connect timer and drop the abort listener.
             * @returns {void}
             * @ai.hint io
             */
            function cleanup() {
                clearTimeout(connectTimer);
                signal?.removeEventListener('abort', onAbort);
            }
            signal?.addEventListener('abort', onAbort, { once: true });
            req.setTimeout(idleTimeout, () => fail(new ApiError(
                `No data from the server for ${Math.round(idleTimeout / 1000)} s.`, { code: 'TIMEOUT', retryable: true })));
            req.once('socket', (socket) => {
                if (socket.connecting) socket.once('connect', () => clearTimeout(connectTimer));
                else clearTimeout(connectTimer);
            });
            req.once('error', (error) => {
                if (failure) return; // Our own timeout / abort was already reported.
                fail(new ApiError(`Network error: ${error.message}`,
                    { code: 'NETWORK_ERROR', retryable: transientNetwork(error), cause: error }));
            });
            req.once('response', (res) => {
                clearTimeout(connectTimer);
                settled = true;
                res.once('error', () => { /* surfaced via the async iterator below */ });
                /**
                 * Yield response chunks. A short body or a later socket error becomes an ApiError.
                 * @returns {AsyncGenerator<Buffer>}
                 * @ai.hint io
                 */
                async function* iterate() {
                    try {
                        for await (const chunk of res) yield chunk;
                        if (!res.complete) throw failure ?? new ApiError('Connection closed before the end of the response.',
                            { code: 'NETWORK_ERROR', retryable: true });
                    } catch (error) {
                        throw failure ?? (error instanceof ApiError ? error
                            : new ApiError(`Error reading the response: ${error.message}`,
                                { code: 'NETWORK_ERROR', retryable: transientNetwork(error), cause: error }));
                    } finally {
                        signal?.removeEventListener('abort', onAbort);
                    }
                }
                resolve({
                    status: res.statusCode, headers: res.headers, body: iterate(),
                    destroy: () => { req.destroy(); res.destroy(); signal?.removeEventListener('abort', onAbort); },
                });
            });
            if (body !== undefined) req.write(body);
            req.end();
        });
    }

    /**
     * Destroy the keep-alive agents.
     * @returns {void}
     * @ai.hint io
     */
    function close() {
        for (const agent of Object.values(agents)) agent.destroy();
    }

    return { request, close };
}

/**
 * Read a whole body with a byte cap.
 * @param {AsyncIterable<Buffer>} body
 * @param {number} maxBytes
 * @param {{ truncate?: boolean }} [options]
 * @returns {Promise<Buffer>}
 * @ai.hint io
 */
export async function readBody(body, maxBytes, { truncate = false } = {}) {
    const chunks = [];
    let total = 0;
    for await (const chunk of body) {
        if (total + chunk.length > maxBytes) {
            if (!truncate) throw new ApiError('The server response exceeds the allowed size.', { code: 'RESPONSE_LIMIT' });
            chunks.push(chunk.subarray(0, Math.max(0, maxBytes - total)));
            total = maxBytes;
            break;
        }
        chunks.push(chunk);
        total += chunk.length;
    }
    return Buffer.concat(chunks, total);
}
