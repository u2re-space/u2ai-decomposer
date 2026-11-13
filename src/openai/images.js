/**
 * @file src/openai/images.js
 * @module openai/images
 * @purpose Image API helpers: sizes, formats, multipart bodies, payload decoding.
 * @depends node:crypto
 * @usedBy openai/client, stages, agent/tools
 * @exports IMAGE_SIZES, parseImageSize, formatSize, paddedSizeToMinPixels, sniffImage, readImageSize, imageSizeFields, resolveImageFormat, backgroundValue, encodeMultipart, imagePayloads, imageSources, imageModelFor
 * @ai.tags images
 * @ai.hint pure
 */
import { randomBytes } from 'node:crypto';

/** Known image size presets of the image APIs. */
export const IMAGE_SIZES = Object.freeze(['1024x1024', '1024x1536', '1536x1024', '512x512', '256x256']);

/** Formats the image APIs accept. */
export const IMAGE_FORMATS = Object.freeze(['png', 'jpeg', 'webp']);

/**
 * Parse a `WIDTHxHEIGHT` size.
 * @param {string} value
 * @returns {{ width: number, height: number }|null}
 * @ai.hint pure
 */
export function parseImageSize(value) {
    const match = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i.exec(String(value ?? '').trim());
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return null;
    return { width, height };
}

/**
 * Format a size back into the `WIDTHxHEIGHT` spelling.
 * @param {{ width: number, height: number }} size
 * @returns {string}
 * @ai.hint pure
 */
export function formatSize(size) {
    return `${Math.round(size.width)}x${Math.round(size.height)}`;
}

/**
 * The size the model wants the frame to have: the nearest preset with the same aspect ratio.
 * @param {{ width: number, height: number }} size
 * @returns {string}
 * @ai.hint pure
 */
export function nearestPreset(size) {
    const ratio = size.width / size.height;
    let best = IMAGE_SIZES[0];
    let bestDelta = Infinity;
    for (const preset of IMAGE_SIZES) {
        const parsed = parseImageSize(preset);
        const delta = Math.abs(parsed.width / parsed.height - ratio);
        if (delta < bestDelta) { bestDelta = delta; best = preset; }
    }
    return best;
}

/**
 * Compute the padded target size to meet the model's minimum pixel floor.
 * @param {{ width: number, height: number }} size
 * @param {string|null} [model]
 * @returns {{ width: number, height: number }|null}
 */
export function paddedSizeToMinPixels(size, model = null) {
    const minPixels = 1048576; // 1024×1024 default floor
    const current = size.width * size.height;
    if (current >= minPixels) return null;
    const factor = Math.ceil(Math.sqrt(minPixels / current));
    return { width: size.width * factor, height: size.height * factor };
}

/**
 * Detect the image format from its bytes.
 * @param {Buffer|Uint8Array} bytes
 * @returns {{ mime: string, ext: string }}
 * @ai.hint pure
 */
export function sniffImage(bytes) {
    const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
    if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50) return { mime: 'image/png', ext: '.png' };
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
    if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') {
        return { mime: 'image/webp', ext: '.webp' };
    }
    if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return { mime: 'image/gif', ext: '.gif' };
    return { mime: 'image/png', ext: '.png' };
}

/**
 * Read the frame size of PNG, JPEG, WebP or GIF bytes without a raster engine.
 * @param {Buffer|Uint8Array} buffer
 * @returns {{ width: number, height: number }|null}
 * @ai.hint pure
 */
export function readImageSize(buffer) {
    if (!buffer || buffer.length < 10) return null;
    const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const tag = (at) => (b.length >= at + 4 ? b.toString('latin1', at, at + 4) : '');
    const u16be = (at) => (b[at] << 8) | b[at + 1];
    const u32be = (at) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
    const u32le = (at) => b[at] + (b[at + 1] << 8) + (b[at + 2] << 16) + (b[at + 3] << 24);
    const frame = (width, height) => (width > 0 && height > 0 ? { width, height } : null);

    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
        if (b.length < 24 || tag(12) !== 'IHDR') return null;
        return frame(u32be(16), u32be(20));
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
        let offset = 2;
        while (offset + 9 < b.length) {
            if (b[offset] !== 0xff) { offset++; continue; }
            const marker = b[offset + 1];
            if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
            const length = u16be(offset + 2);
            if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
                return frame(u16be(offset + 7), u16be(offset + 5));
            }
            offset += 2 + length;
        }
        return null;
    }
    if (tag(0) === 'RIFF' && tag(8) === 'WEBP') {
        if (tag(12) === 'VP8X') return frame(1 + u32le(24), 1 + u32le(27));
        if (tag(12) === 'VP8 ') return frame(u16be(26) & 0x3fff, u16be(28) & 0x3fff);
        if (tag(12) === 'VP8L') {
            const bits = u32le(21);
            return frame((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
        }
        return null;
    }
    if (tag(0) === 'GIF8') return frame(u16be(6), u16be(8));
    return null;
}

/**
 * The format the model answers in.
 * @param {{ model?: string|null, format?: string|null }} params
 * @returns {string} one of png | jpeg | webp
 * @ai.hint pure
 */
export function resolveImageFormat({ model = null, format = null } = {}) {
    const asked = String(format ?? '').trim().toLowerCase();
    if (asked === 'jpg') return 'jpeg';
    if (IMAGE_FORMATS.includes(asked)) return asked;
    return 'png';
}

/**
 * Models of the gpt-image family speak `output_format`; the older ones speak `response_format`.
 * @param {string|null} model
 * @returns {boolean}
 * @ai.hint pure
 */
export function usesOutputFormat(model) {
    const name = String(model ?? '').toLowerCase();
    return name.includes('gpt-image') || name.includes('sunburst') || name.includes('nano-banana');
}

/**
 * Fields of the image request that carry the size, the format and the quality.
 * @param {{ size?: string|null, model?: string|null, format?: string|null, quality?: string|null }} params
 * @returns {Record<string, string>}
 * @ai.hint pure
 */
export function imageSizeFields({ size = null, model = null, format = null, quality = null } = {}) {
    const fields = {};
    const asked = String(size ?? '').trim();
    if (asked && asked !== 'auto') {
        const parsed = parseImageSize(asked);
        fields.size = parsed ? formatSize(parsed) : nearestPreset({ width: 1024, height: 1024 });
    }
    const resolved = resolveImageFormat({ model, format });
    if (usesOutputFormat(model)) fields.output_format = resolved;
    else fields.response_format = 'b64_json';
    const level = String(quality ?? '').trim().toLowerCase();
    if (level && ['low', 'medium', 'high', 'auto'].includes(level)) fields.quality = level;
    return fields;
}

/**
 * The background field of the image request; only models with native alpha take it.
 * @param {{ model?: string|null, format?: string|null, background?: string|null }} params
 * @returns {string|null}
 * @ai.hint pure
 */
export function backgroundValue({ model = null, format = null, background = null } = {}) {
    const asked = String(background ?? '').trim().toLowerCase();
    if (asked !== 'transparent') return null;
    if (!usesOutputFormat(model)) return null;
    if (resolveImageFormat({ model, format }) === 'jpeg') return null;
    return 'transparent';
}

/**
 * Build a multipart/form-data body.
 * @param {{ fields?: Record<string, string|number|undefined|null>, files?: Array<{ field?: string, filename: string, mime: string, bytes: Buffer }> }} params
 * @returns {{ body: Buffer, contentType: string }}
 * @ai.hint pure
 */
export function encodeMultipart({ fields = {}, files = [] } = {}) {
    const boundary = `aid${randomBytes(12).toString('hex')}`;
    const chunks = [];
    for (const [name, value] of Object.entries(fields)) {
        if (value === undefined || value === null) continue;
        chunks.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        ));
    }
    for (const file of files) {
        const filename = String(file.filename ?? 'image.png').replace(/["\r\n]/g, '');
        const field = String(file.field ?? 'image');
        chunks.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${file.mime ?? 'image/png'}\r\n\r\n`,
        ));
        chunks.push(Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(file.bytes ?? []));
        chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * Base64 payloads of an image API answer.
 * @param {object} body
 * @returns {string[]}
 * @ai.hint pure
 */
export function imagePayloads(body) {
    const rows = Array.isArray(body?.data) ? body.data : [];
    return rows.map((row) => row?.b64_json).filter((value) => typeof value === 'string' && value);
}

/**
 * Image sources of an API answer: inline base64 or a URL, in response order.
 * @param {object} body
 * @returns {Array<{ kind: 'b64'|'url', value: string }>}
 * @ai.hint pure
 */
export function imageSources(body) {
    const rows = Array.isArray(body?.data) ? body.data : [];
    const out = [];
    for (const row of rows) {
        if (typeof row?.b64_json === 'string' && row.b64_json.trim()) out.push({ kind: 'b64', value: row.b64_json.trim() });
        else if (typeof row?.url === 'string' && row.url.trim()) out.push({ kind: 'url', value: row.url.trim() });
    }
    return out;
}

/**
 * The image model of the config: the picture model, or the text model when it can see images.
 * @param {object} config
 * @param {{ hasImage?: boolean }} [opts]
 * @returns {string|null}
 */
export function imageModelFor(config, { hasImage = false } = {}) {
    if (config?.imageModel) return config.imageModel;
    if (hasImage && config?.model) return config.model;
    return null;
}
