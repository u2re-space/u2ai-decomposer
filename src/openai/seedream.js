/**
 * @file src/openai/seedream.js
 * @module openai/seedream
 * @purpose API layer for the seedream-5-5 image model: layer decomposition, transparent
 *          generation, async task polling, and the layer geometry the vendor reports.
 * @depends node:timers/promises, openai/errors
 * @usedBy stages/resolve, openai/client
 * @exports SEEDREAM_MODEL, SEEDREAM_LAYER_SIZES, SEEDREAM_RATIOS, SEEDREAM_GENERATION_MIN_PIXELS,
 *   SEEDREAM_GENERATION_MAX_PIXELS, SEEDREAM_INPUT_MAX_BYTES, SEEDREAM_INPUT_MAX_PIXELS,
 *   isSeedream55, seedreamLayerSize, seedreamGenerationSize, layerDecompositionBody, generationBody,
 *   normalizeLayerBox, parseLayerDecomposition, taskImageSources, downloadImageBytes,
 *   decomposeLayers, generateImage
 * @ai.tags images, seedream, decomposition, layers
 * @ai.hint io
 *
 * Documented API: https://docs.apimart.ai/ru/api-reference/images/seedream-5-5/generation
 *
 * The decomposition mode differs from every other image route this program uses:
 *   - exactly one input image, and the `background` field must be absent entirely (not even `auto`);
 *   - `size` accepts only the tiers `1K` / `1.5K` / `2K` / `auto` — ratios and pixel frames are a
 *     synchronous HTTP 400, so this module must never reuse the generic frame ladder;
 *   - `n` must be 1; the number of outputs is `layer_decomposition_options.max_images`, counting
 *     the base image;
 *   - the reply is a task, not a picture: the caller polls until `completed` or `failed`.
 *
 * The layers come back as transparent PNGs with a bounding box in the coordinates of the base
 * image: `absolute` is `[left, top, right, bottom]` in base pixels, `normalized` is the same frame
 * on a 0–1000 scale. The file of a layer is not that frame — every layer is scaled on its own to
 * the chosen tier — so the file has to be brought to `w × h` of the box before it is placed at
 * `(x, y)` over the base. That correction belongs to the fetch, not to the reader of the JSON.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { ApiError } from './errors.js';

/** Default model id of the seedream-5.5 route. */
export const SEEDREAM_MODEL = 'seedream-5-5';

/** Frames the decomposition mode accepts. Anything else is a synchronous 400. */
export const SEEDREAM_LAYER_SIZES = Object.freeze(['1K', '1.5K', '2K', 'auto']);

/** Ratios the generation mode accepts (the vendor also reads `16x9` for `16:9`). */
export const SEEDREAM_RATIOS = Object.freeze(['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9', '2:1', '1:2']);

/** Pixel budget of one generation frame; an exact frame outside it is a synchronous 400. */
export const SEEDREAM_GENERATION_MIN_PIXELS = 921_600;
export const SEEDREAM_GENERATION_MAX_PIXELS = 4_624_220;

/** Limits of one input image: 30 MiB and 36 million pixels. */
export const SEEDREAM_INPUT_MAX_BYTES = 30 * 1024 * 1024;
export const SEEDREAM_INPUT_MAX_PIXELS = 36_000_000;

/** Task poll cadence the vendor recommends: 3 s for the first half-minute, 5 s afterwards. */
const POLL_FAST_MS = 3_000;
const POLL_SLOW_MS = 5_000;
const POLL_FAST_WINDOW_MS = 30_000;

/** The server itself waits at most 13 minutes; the client gives up shortly after that. */
const DEFAULT_TASK_TIMEOUT_MS = 14 * 60_000;

/**
 * Does this model id belong to the seedream-5.5 family?
 * @param {string|null|undefined} model
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isSeedream55(model) {
    return /seedream[-\s]?5[-\s]?5/i.test(String(model ?? '').trim());
}

/**
 * A tier the decomposition mode accepts, or `auto` for anything else.
 * A pixel frame or a ratio would be rejected by the gateway, and guessing a tier out of it would
 * silently change the resolution of every layer — `auto` keeps the source's own geometry.
 * @param {string|null|undefined} value
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function seedreamLayerSize(value) {
    const token = String(value ?? '').trim().toUpperCase();
    return SEEDREAM_LAYER_SIZES.includes(token) ? token : 'auto';
}

/**
 * A frame the generation mode accepts. Unlike decomposition, generation also takes ratios and
 * exact pixels, but a measurement crop is far below the vendor's minimum pixel budget, so an
 * exact frame of a small region is a synchronous HTTP 400. A tier is what a crop can actually ask
 * for, and `1K` is the cheap one; anything unusable becomes `1K` rather than a rejected frame.
 * @param {string|null|undefined} value
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function seedreamGenerationSize(value) {
    const token = String(value ?? '').trim();
    if (!token) return '1K';
    const upper = token.toUpperCase();
    if (SEEDREAM_LAYER_SIZES.includes(upper)) return upper;
    const match = /^(\d+)\s*[xх*]\s*(\d+)$/i.exec(token);
    if (match) {
        const pixels = Number(match[1]) * Number(match[2]);
        if (pixels >= SEEDREAM_GENERATION_MIN_PIXELS && pixels <= SEEDREAM_GENERATION_MAX_PIXELS) return `${match[1]}x${match[2]}`;
    }
    if (SEEDREAM_RATIOS.includes(token.replace(/x/i, ':'))) return token.replace(/x/i, ':');
    return '1K';
}

/**
 * A data URI for one picture, in the lowercase format name the gateway parses.
 * @param {Buffer} bytes
 * @param {string} mime
 * @returns {string}
 * @ai.hint pure
 */
function toDataUri(bytes, mime = 'image/png') {
    const format = String(mime).split('/').pop().toLowerCase().replace('jpeg', 'jpg');
    return `data:image/${format};base64,${Buffer.from(bytes).toString('base64')}`;
}

/**
 * Body for POST /images/generations in the layer-decomposition mode.
 * `background` is never present here — the vendor rejects even `auto` alongside
 * `layer_decomposition: true` — and `n` stays out because the mode answers exactly one task.
 * @param {{ model?: string, source: { bytes: Buffer, mime?: string }, prompt?: string|null,
 *   size?: string|null, maxImages?: number|null, textRecognition?: boolean }} options
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function layerDecompositionBody({ model = SEEDREAM_MODEL, source, prompt = null, size = 'auto', maxImages = null, textRecognition = true }) {
    if (!source?.bytes?.length) {
        throw new ApiError('The layer decomposition needs exactly one input image.', { code: 'INVALID_REQUEST' });
    }
    const body = {
        model,
        image_urls: [toDataUri(source.bytes, source.mime ?? 'image/png')],
        layer_decomposition: true,
        size: seedreamLayerSize(size),
    };
    const text = String(prompt ?? '').trim();
    if (text) body.prompt = text;
    // max_images covers the base and the layers, so a request for 16 layers asks for 17 outputs;
    // the gateway clamps to [2, 100] and rejects a non-integer outright.
    if (Number.isSafeInteger(maxImages) && maxImages >= 2 && maxImages <= 100) {
        body.layer_decomposition_options = { max_images: maxImages };
    }
    if (textRecognition === true) {
        body.layer_decomposition_options = { ...(body.layer_decomposition_options ?? {}), text_recognition: true };
    }
    return body;
}

/**
 * Body for POST /images/generations in the ordinary generation mode.
 * The reference travels in `image_urls` — this model does not read the `input_references` field
 * the generic images route uses — transparency needs `output_format: "png"`, and `n` stays out
 * because the mode answers exactly one task.
 * @param {{ model?: string, prompt: string, references?: string[]|null, size?: string|null,
 *   background?: string|null, format?: string|null }} options
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function generationBody({ model = SEEDREAM_MODEL, prompt, references = null, size = '1K', background = 'transparent', format = 'png' }) {
    const text = String(prompt ?? '').trim();
    // Unlike decomposition, generation cannot run without a prompt.
    if (!text) throw new ApiError('The seedream-5.5 generation needs a prompt.', { code: 'INVALID_REQUEST' });
    const images = (Array.isArray(references) ? references : []).filter((url) => typeof url === 'string' && url.trim());
    if (images.length > 10) {
        throw new ApiError('seedream-5.5 accepts at most 10 references.', { code: 'INVALID_REQUEST' });
    }
    const body = { model, prompt: text, size: seedreamGenerationSize(size) };
    if (images.length) body.image_urls = images;
    const imageFormat = String(format ?? '').trim().toLowerCase() === 'jpeg' ? 'jpeg' : 'png';
    body.output_format = imageFormat;
    // The vendor refuses transparent output combined with JPEG.
    const wanted = String(background ?? '').trim().toLowerCase();
    if (['transparent', 'opaque', 'auto'].includes(wanted) && !(wanted === 'transparent' && imageFormat === 'jpeg')) {
        body.background = wanted;
    }
    return body;
}

/**
 * Read one layer's box in base-image pixels, from either box shape the vendor sends.
 * `absolute` is `[left, top, right, bottom]` in the pixels of the base image; `normalized` is the
 * same frame on a 0–1000 scale, which becomes pixels through `baseFrame`:
 *
 *     x = left / 1000 * width      y = top / 1000 * height
 *     w = (right - left) / 1000 * width
 *     h = (bottom - top) / 1000 * height
 *
 * The base frame is the size of the base picture of the answer. The frame of the picture that was
 * sent is the fallback for the normalized boxes, because a task that does not report the base size
 * still knows the geometry of its input.
 * @param {object|null|undefined} box
 * @param {{ width: number, height: number }|null} baseFrame
 * @returns {{ x: number, y: number, width: number, height: number }|null}
 * @exports
 * @ai.hint pure
 */
export function normalizeLayerBox(box, baseFrame) {
    if (!box || typeof box !== 'object') return null;
    const absolute = Array.isArray(box.absolute) ? box.absolute.map(Number) : null;
    const normalized = Array.isArray(box.normalized) ? box.normalized.map(Number) : null;
    let left = null;
    let top = null;
    let right = null;
    let bottom = null;
    if (absolute && absolute.length === 4 && absolute.every((n) => Number.isFinite(n))) {
        [left, top, right, bottom] = absolute;
    } else if (normalized && normalized.length === 4 && normalized.every((n) => Number.isFinite(n))
        && baseFrame?.width && baseFrame?.height) {
        left = normalized[0] / 1000 * baseFrame.width;
        top = normalized[1] / 1000 * baseFrame.height;
        right = normalized[2] / 1000 * baseFrame.width;
        bottom = normalized[3] / 1000 * baseFrame.height;
    } else {
        return null;
    }
    const width = right - left;
    const height = bottom - top;
    if (!(width > 0) || !(height > 0)) return null;
    return { x: Math.round(left), y: Math.round(top), width: Math.round(width), height: Math.round(height) };
}

/**
 * The frames (`WxH`) the gateway reported for one result row, parsed into {width,height}.
 * @param {unknown} value
 * @returns {Array<{width:number|null,height:number|null}>}
 * @ai.hint pure
 */
function parseSizes(value) {
    if (!Array.isArray(value)) return [];
    return value.map((token) => {
        const match = /^(\d+)\s*[xх*]\s*(\d+)$/i.exec(String(token ?? '').trim());
        return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: null, height: null };
    });
}

/**
 * The OCR of one text layer, kept close to the shape the vendor sends.
 * `lines[].bounding_box` is a tight frame around the glyphs, while the layer's own box is padded
 * around the whole object, so the line frames are the only coordinates in this answer that hug the
 * content.
 * @param {object|null|undefined} recognition
 * @param {{ width: number, height: number }|null} baseFrame
 * @returns {{text:string, lines: object[]}|null}
 * @ai.hint pure
 */
function parseTextRecognition(recognition, baseFrame) {
    if (!recognition || typeof recognition !== 'object') return null;
    const lines = Array.isArray(recognition.lines) ? recognition.lines : [];
    return {
        text: String(recognition.text ?? ''),
        lines: lines.map((line) => ({
            text: String(line?.text ?? ''),
            box: normalizeLayerBox(line?.bounding_box, baseFrame),
            runs: (Array.isArray(line?.runs) ? line.runs : []).map((run) => ({
                text: String(run?.text ?? ''),
                style: run?.style && typeof run.style === 'object' ? run.style : null,
            })),
        })),
    };
}

/**
 * `data` of a task answer, or null while the task is still running.
 * @param {object} result
 * @returns {{ status: string, error: string|null, reason: string|null, images: object[] }|null}
 * @ai.hint pure
 */
function taskData(result) {
    const data = result?.data ?? result ?? null;
    if (!data || typeof data !== 'object') return null;
    const status = String(data.status ?? '').trim().toLowerCase();
    if (!['pending', 'processing', 'completed', 'failed', 'canceled', 'cancelled'].includes(status)) return null;
    const error = typeof data.error === 'string' ? data.error : (data.error?.message ?? null);
    // `reason` is documented as the machine-readable cause and is the only part that tells a refused
    // picture apart from a timeout; the message alone reads the same for both.
    const reason = typeof data.error?.reason === 'string'
        ? data.error.reason.trim()
        : (typeof data.error?.code === 'string' ? data.error.code.trim() : null);
    return { status, error, reason, images: Array.isArray(data.result?.images) ? data.result.images : [] };
}

/**
 * Flatten one completed decomposition answer into layer records.
 * `url[]`, `sizes[]` and `layers[]` are index-aligned per the API contract; index 0 of `url` is
 * the base image and index 0 of `layers` carries its z_index (0). Metadata arrays may be absent
 * when their length does not match, so every row is read defensively and a missing box stays null
 * rather than becoming a fabricated measurement.
 *
 * The boxes are read on the canvas of the base picture: `baseFrame` when the caller knows it (the
 * size of the base file), otherwise the size the answer reports, and only then the frame of the
 * picture that was sent.
 * @param {object} result the task answer
 * @param {{ baseFrame?: { width: number, height: number }|null, coordinateFrame?: { width: number, height: number }|null }} [options]
 * @returns {{ base: {url:string,size:{width:number|null,height:number|null}}|null,
 *   layers: Array<{ index: number, z: number, name: string, description: string, url: string,
 *     size: {width:number|null,height:number|null}, background: string, box: object|null,
 *     text: {text:string,lines:object[]}|null }>, ocr: object[] }}
 * @exports
 * @ai.hint pure
 */
export function parseLayerDecomposition(result, { baseFrame = null, coordinateFrame = null } = {}) {
    const rows = taskData(result)?.images ?? [];
    const out = { base: null, layers: [], ocr: [] };
    for (const row of rows) {
        const urls = Array.isArray(row?.url) ? row.url.filter((u) => typeof u === 'string' && u.trim()) : [];
        if (!urls.length) continue;
        const sizes = parseSizes(row.sizes);
        const meta = Array.isArray(row.layers) && row.layers.length === urls.length ? row.layers : null;
        const reported = sizes[0]?.width && sizes[0]?.height ? { width: sizes[0].width, height: sizes[0].height } : null;
        const frame = (baseFrame?.width && baseFrame?.height)
            ? baseFrame
            : (reported ?? (coordinateFrame?.width && coordinateFrame?.height ? coordinateFrame : null));
        out.base ??= {
            url: urls[0],
            size: reported ?? { width: null, height: null },
        };
        for (let index = 1; index < urls.length; index++) {
            const layer = meta?.[index] ?? null;
            const textRecognition = parseTextRecognition(layer?.text_recognition, frame);
            out.layers.push({
                index,
                z: Number.isFinite(layer?.z_index) ? layer.z_index : index,
                name: String(layer?.name ?? '').trim(),
                description: String(layer?.description ?? '').trim(),
                url: urls[index],
                size: sizes[index] ?? { width: null, height: null },
                background: String(layer?.background ?? (Array.isArray(row.backgrounds) ? row.backgrounds[index] : '') ?? '').trim(),
                box: normalizeLayerBox(layer?.bounding_box, frame),
                text: textRecognition,
            });
            if (textRecognition) out.ocr.push({ layer: index, ...textRecognition });
        }
    }
    return out;
}

/**
 * The rows of an answer that may carry pictures: `data.result.images[]` of a task answer and
 * `data[]` of a synchronous one.
 * @param {object} result
 * @returns {object[]}
 * @ai.hint pure
 */
function resultRows(result) {
    const rows = [];
    const data = result?.data;
    if (Array.isArray(data?.result?.images)) rows.push(...data.result.images);
    if (Array.isArray(data)) rows.push(...data);
    if (!rows.length && Array.isArray(result?.data?.result?.images)) rows.push(...result.data.result.images);
    return rows;
}

/**
 * Picture sources of a completed answer, in response order.
 * A task answer keeps them in `data.result.images[].url[]` — an array per row, index-aligned with
 * `sizes` and `layers` — while a synchronous gateway may answer the OpenAI shape `data[].url` or
 * `data[].b64_json`, so all three shapes are read.
 * @param {object} result
 * @returns {Array<{ kind: 'b64'|'url', value: string }>}
 * @exports
 * @ai.hint pure
 */
export function taskImageSources(result) {
    const out = [];
    const push = (value, kind) => {
        const text = String(value ?? '').trim();
        if (text) out.push({ kind, value: text });
    };
    for (const row of resultRows(result)) {
        if (!row || typeof row !== 'object') continue;
        if (Array.isArray(row.url)) row.url.forEach((item) => push(item, 'url'));
        else if (typeof row.url === 'string') push(row.url, 'url');
        if (Array.isArray(row.b64_json)) row.b64_json.forEach((item) => push(item, 'b64'));
        else if (typeof row.b64_json === 'string') push(row.b64_json, 'b64');
    }
    return out;
}

/**
 * Bytes of one answer picture. A CDN link is fetched; a data URI is decoded, because `fetch` does
 * not speak that scheme and a gateway is free to answer inline.
 * @param {string} url
 * @param {AbortSignal} [signal]
 * @returns {Promise<Buffer|null>}
 * @exports
 * @ai.hint io
 */
export async function downloadImageBytes(url, signal) {
    try {
        const text = String(url ?? '').trim();
        if (/^data:/i.test(text)) {
            const comma = text.indexOf(',');
            const header = text.slice(0, comma);
            if (!/;base64/i.test(header)) return null;
            return Buffer.from(text.slice(comma + 1), 'base64');
        }
        const res = await fetch(text, { signal, redirect: 'follow' });
        if (!res.ok) return null;
        return Buffer.from(await res.arrayBuffer());
    } catch {
        return null;
    }
}

/**
 * Did the host refuse the model rather than the request?
 * A host that does not serve seedream is not a broken host: the next one in the chain is tried.
 * @param {unknown} error
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isHostUnavailable(error) {
    if (!error) return false;
    if (error?.code === 'ABORTED' || error?.name === 'AbortError') return false;
    const status = error?.status;
    if (status === 404 || status === 502 || status === 503 || status === 504) return true;
    const text = String(error?.message ?? '').toLowerCase();
    return /model not found|model_not_found|no such model|unknown model|not available|service unavailable|bad gateway|gateway timeout|econnrefused|fetch failed|network error/.test(text);
}

/**
 * The channels to walk: the ones the client handed over.
 * @param {Array<{ call: Function }>|null} channels
 * @param {string} what Route name, for the error text.
 * @returns {Array<{ call: Function, label?: string }>}
 * @ai.hint pure
 */
function channelChain(channels, what) {
    const chain = (Array.isArray(channels) ? channels : []).filter((channel) => typeof channel?.call === 'function');
    if (!chain.length) {
        throw new ApiError(`${what}: no image backend is configured for the seedream route.`, { code: 'NO_BACKEND' });
    }
    return chain;
}

/**
 * Poll one task until it reaches a final state.
 * The channel owns the transport, the retries and the auth, so this loop owns only the schedule:
 * 3 s inside the first half-minute, then 5 s, and giving up after `timeoutMs` (the server itself
 * stops at 13 min).
 * @param {{ call: Function }} channel
 * @param {string} taskId
 * @param {{ signal?: AbortSignal, timeoutMs?: number, onPoll?: Function, pollIntervalMs?: number|null }} options
 * @returns {Promise<object>} the completed task answer
 * @ai.hint io
 */
async function pollTask(channel, taskId, { signal, timeoutMs = DEFAULT_TASK_TIMEOUT_MS, onPoll = null, pollIntervalMs = null } = {}) {
    const startedAt = Date.now();
    let polls = 0;
    for (;;) {
        signal?.throwIfAborted();
        const result = await channel.call(`tasks/${encodeURIComponent(taskId)}`, { method: 'GET', signal });
        const data = taskData(result);
        polls += 1;
        try { onPoll?.({ taskId, status: data?.status ?? 'unknown', polls, elapsedMs: Date.now() - startedAt }); } catch { /* observer */ }
        if (data?.status === 'completed') return result;
        if (data?.status === 'failed' || data?.status === 'canceled' || data?.status === 'cancelled') {
            throw new ApiError(`The seedream-5.5 task ended with the status "${data.status}"${data.error ? `: ${data.error}` : ''}.`, {
                // `reason` is carried on the error itself: it is what tells a refused picture apart
                // from a timeout, and the caller has to be able to ask without parsing prose.
                code: 'TASK_FAILED',
                apiCode: data.reason,
                details: { taskId, status: data.status, reason: data.error, code: data.reason ?? null },
            });
        }
        if (Date.now() - startedAt > timeoutMs) {
            throw new ApiError(`The seedream-5.5 task did not finish within ${Math.round(timeoutMs / 60_000)} min (task ${taskId}).`, {
                code: 'TASK_TIMEOUT', details: { taskId, polls },
            });
        }
        const wait = pollIntervalMs != null
            ? pollIntervalMs
            : (Date.now() - startedAt < POLL_FAST_WINDOW_MS ? POLL_FAST_MS : POLL_SLOW_MS);
        if (wait > 0) {
            await sleep(wait, undefined, { signal }).catch(() => {
                throw new ApiError('Waiting for the seedream-5.5 task was interrupted.', { code: 'ABORTED' });
            });
        }
    }
}

/**
 * Post one seedream-5.5 body and wait for its task, walking the host chain.
 * Both modes of this model are asynchronous — generation answers a task id exactly like
 * decomposition does — so the schedule and the host walk belong here rather than in each caller.
 * The task is polled on the host that created it, because a task id means nothing to the others.
 * @param {{ channels: Array<{ call: Function, label?: string }>, model: string, body: object,
 *   signal?: AbortSignal, timeoutMs?: number, onPoll?: Function, onWarn?: Function, what: string,
 *   noResult: string, pollIntervalMs?: number|null }} options
 * @returns {Promise<{ raw: object, taskId: string|null, host: string|null }>}
 * @ai.hint io
 */
async function runSeedreamTask({ channels, model, body, signal, timeoutMs, onPoll = null, onWarn = null,
    what = 'The seedream-5.5 task', noResult = 'The seedream-5.5 answer carries neither a task id nor a result.',
    pollIntervalMs = null }) {
    const chain = channelChain(channels, what);
    let lastError = null;
    for (const [index, channel] of chain.entries()) {
        try {
            const created = await channel.call('images/generations', { method: 'POST', body: { ...body, model }, signal });
            if (taskData(created)?.status === 'completed') {
                return { raw: created, taskId: null, host: channel.label ?? null };
            }
            const taskId = String(created?.data?.[0]?.task_id ?? created?.data?.task_id ?? created?.task_id ?? '').trim();
            if (!taskId) {
                if (taskImageSources(created).length) return { raw: created, taskId: null, host: channel.label ?? null };
                throw new ApiError(noResult, { code: 'INVALID_RESPONSE', details: { keys: Object.keys(created ?? {}) } });
            }
            const settled = await pollTask(channel, taskId, { signal, timeoutMs, onPoll, pollIntervalMs });
            return { raw: settled, taskId, host: channel.label ?? null };
        } catch (error) {
            // A host that does not serve the model is that host's answer, not the route's: the next
            // one is tried. Everything else is the caller's problem at once.
            if (!isHostUnavailable(error)) throw error;
            lastError = error;
            if (index < chain.length - 1) {
                try {
                    onWarn?.(`${what} did not run on ${channel.label || 'this backend'} (${error.message ?? error}); trying the next host.`);
                } catch { /* observer */ }
            }
        }
    }
    throw lastError ?? new ApiError(`No backend ran ${what.toLowerCase()}.`, { code: 'NO_PROVIDER' });
}

/**
 * Split one picture into a base image and transparent PNG layers with seedream-5.5.
 * Returns normalized records: the base frame, one entry per layer (z-order, name, box in base
 * pixels, optional OCR text), and the raw parsed answer under `raw`.
 *
 * `channels` are the sticky channels of the client (`client.channels('images', model)`): the host
 * that serves seedream is rarely the primary one, and a task id means nothing to the other hosts,
 * so the walk over hosts and the polling of the task happen here.
 * @param {{ channels: Array<{ call: Function, label?: string }>, source: { bytes: Buffer, mime?: string },
 *   model?: string, prompt?: string|null, size?: string|null, maxImages?: number|null,
 *   textRecognition?: boolean, coordinateFrame?: { width: number, height: number }|null,
 *   signal?: AbortSignal, timeoutMs?: number, onPoll?: Function, onWarn?: Function,
 *   pollIntervalMs?: number|null }} options
 * @returns {Promise<{ base: object|null, layers: object[], ocr: object[], raw: object, taskId: string|null, host: string|null }>}
 * @exports
 * @ai.hint io
 */
export async function decomposeLayers({ channels, source, model = SEEDREAM_MODEL, prompt = null,
    size = 'auto', maxImages = null, textRecognition = true, coordinateFrame = null, signal, timeoutMs,
    onPoll = null, onWarn = null, pollIntervalMs = null }) {
    if (Buffer.byteLength(source?.bytes ?? '') > SEEDREAM_INPUT_MAX_BYTES) {
        throw new ApiError(`The decomposition input is larger than ${SEEDREAM_INPUT_MAX_BYTES} bytes — shrink the image.`, { code: 'IMAGE_TOO_LARGE' });
    }
    const body = layerDecompositionBody({ model, source, prompt, size, maxImages, textRecognition });
    const { raw, taskId, host } = await runSeedreamTask({
        channels, model, body, signal, timeoutMs, onPoll, onWarn, pollIntervalMs,
        what: 'The layer decomposition',
        noResult: 'The seedream-5.5 answer carries neither a task id nor a decomposition result.',
    });
    return { ...parseLayerDecomposition(raw, { coordinateFrame }), raw, taskId, host };
}

/**
 * Generate one image with seedream-5.5 and return its bytes.
 *
 * This is the generation mode, not the decomposition one: `background: transparent` is legal here.
 * It is still an asynchronous task — the gateway answers `data[0].task_id` for every seedream-5.5
 * call, generation included, and the picture only appears on `GET /tasks/{id}` under
 * `data.result.images[].url[]`.
 * @param {{ channels: Array<{ call: Function, label?: string }>, model?: string, prompt: string,
 *   source?: { bytes: Buffer, mime?: string }|null, references?: string[]|null, size?: string|null,
 *   background?: string|null, format?: string|null, signal?: AbortSignal, timeoutMs?: number,
 *   onPoll?: Function, onWarn?: Function, pollIntervalMs?: number|null }} options
 * @returns {Promise<{ images: Array<{ bytes: Buffer, mime: string }>, raw: object, taskId: string|null }>}
 * @exports
 * @ai.hint io
 */
export async function generateImage({ channels, model = SEEDREAM_MODEL, prompt, source = null, references = null,
    size = '1K', background = 'transparent', format = 'png', signal, timeoutMs, onPoll = null, onWarn = null,
    pollIntervalMs = null }) {
    const urls = Array.isArray(references) && references.length
        ? references
        : (source?.bytes?.length ? [toDataUri(source.bytes, source.mime ?? 'image/png')] : []);
    const body = generationBody({ model, prompt, references: urls, size, background, format });
    const { raw, taskId } = await runSeedreamTask({
        channels, model, body, signal, timeoutMs, onPoll, onWarn, pollIntervalMs,
        what: 'The seedream-5.5 generation',
        noResult: 'The seedream-5.5 answer carries neither a task id nor a picture.',
    });
    const images = [];
    for (const picture of taskImageSources(raw)) {
        if (picture.kind === 'b64') {
            images.push({ bytes: Buffer.from(picture.value, 'base64'), mime: 'image/png' });
            continue;
        }
        const bytes = await downloadImageBytes(picture.value, signal);
        if (bytes) images.push({ bytes, mime: 'image/png' });
    }
    if (!images.length) {
        throw new ApiError('The seedream-5.5 task finished without a picture.', { code: 'INVALID_RESPONSE' });
    }
    return { images, raw, taskId };
}
