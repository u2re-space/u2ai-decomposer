/**
 * @file src/image/raster.js
 * @module image/raster
 * @purpose Local raster operations: sharp first, node-canvas as the fallback, ImageMagick as the
 *          last resort. Crops, box-patches, padding, trims, splits, alpha masks and SVG raster.
 * @depends node:path, node:fs/promises
 * @usedBy stages, agent/tools, image/skew
 * @exports rasterEngine, rasterInfo, rasterCompare, rasterApplyAlphaMask, rasterColorKeyAlpha, rasterLocalAlphaMatte, rasterDetectFakeTransparency, rasterCrop, rasterFitToBox, rasterPatch, rasterTrim, rasterSplit, rasterPadImageBytes, rasterRemoveImagePadding, rasterFitToSourceFrame, rasterizeSvg, decodeRgba, encodeRgba, rasterScale, fitBox
 * @ai.tags sharp, canvas, resvg, image, crop, svg
 * @ai.hint io
 * @ai.hint legacy-0.2
 *
 * Ported from the monolith (`src/shared/image-raster.js`): sharp reads the pixels directly and
 * node-canvas covers the same operations when the native binaries are unavailable. The comparison
 * sheet of the monolith is not needed here, so the sheet builder stayed behind; what the
 * decomposer needs is the pixel difference between two frames.
 */

import path from 'node:path';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { canvasLib } from './canvas.js';

/** Cached module handles. null = not tried yet, false = unavailable, object = the module. */
let _sharp = null;
let _resvg = null;

/**
 * Load sharp once. Returns the module or null when the native binary is missing.
 * @returns {Promise<object|null>}
 * @ai.hint io
 */
async function sharpLib() {
    if (_sharp === null) {
        try {
            const module = await import('sharp');
            _sharp = module.default ?? module;
        } catch { _sharp = false; }
    }
    return _sharp || null;
}

/**
 * Load the ReSVG renderer once. Returns the `Resvg` constructor or null when the native binary is
 * missing. ReSVG is the most faithful local SVG rasterizer here: it is a dedicated renderer, not a
 * side feature of a raster library.
 * @returns {Promise<object|null>}
 * @ai.hint io
 */
async function resvgLib() {
    if (_resvg === null) {
        try {
            const module = await import('@resvg/resvg-js');
            _resvg = module.Resvg ?? module.default?.Resvg ?? false;
        } catch { _resvg = false; }
    }
    return _resvg || null;
}

/**
 * True when the buffer is an SVG document rather than a raster picture.
 * @param {Buffer} bytes
 * @returns {boolean}
 * @ai.hint pure
 */
function isSvgBytes(bytes) {
    // A raster signature settles the question before any text scan.
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return false;
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return false;
    if (bytes.subarray(0, 4).toString('latin1') === 'RIFF') return false;
    if (bytes.subarray(0, 4).toString('latin1') === 'GIF8') return false;
    const head = bytes.subarray(0, 1024).toString('utf8').replace(/^\uFEFF/, '').trimStart();
    return head.startsWith('<') && /<svg[\s>]/i.test(head);
}

/**
 * Render SVG bytes to PNG bytes with ReSVG, optionally fitted into a box with the aspect ratio kept.
 * @param {Buffer} bytes
 * @param {{ width?: number|null, height?: number|null }} [options]
 * @returns {Promise<{ png: Buffer, width: number, height: number }|null>}
 * @ai.hint io
 */
async function resvgPng(bytes, { width = null, height = null } = {}) {
    const Resvg = await resvgLib();
    if (!Resvg) return null;
    const render = (options) => {
        const image = new Resvg(bytes, { background: 'rgba(0,0,0,0)', ...options }).render();
        return { png: Buffer.from(image.asPng()), width: image.width, height: image.height };
    };
    const base = render({});
    // One named side means "fit that side and keep the ratio", so the other side stays free.
    if (width && !height) return render({ fitTo: { mode: 'width', value: Math.max(1, Math.round(width)) } });
    if (height && !width) return render({ fitTo: { mode: 'height', value: Math.max(1, Math.round(height)) } });
    if (!width && !height) return base;
    const box = fitBox(base.width, base.height, width, height);
    if (box.width === base.width && box.height === base.height) return base;
    return render({ fitTo: { mode: 'zoom', value: box.scale } });
}

/**
 * Pick the preferred engine, falling back to the other native implementation.
 * @param {'auto'|'sharp'|'canvas'} preferred
 * @returns {Promise<{ name: 'sharp'|'canvas', lib: object }|null>}
 * @ai.hint io
 */
async function getEngine(preferred = 'auto') {
    if (preferred === 'canvas') {
        const canvas = await canvasLib();
        if (canvas) return { name: 'canvas', lib: canvas };
    }
    const sharp = await sharpLib();
    if (sharp) return { name: 'sharp', lib: sharp };
    const canvas = await canvasLib();
    return canvas ? { name: 'canvas', lib: canvas } : null;
}

/**
 * Which local raster engine this process has: 'sharp', 'canvas', or null for neither.
 * @returns {Promise<'sharp'|'canvas'|null>}
 * @exports
 * @ai.hint io
 */
export async function rasterEngine(preferred = 'auto') {
    const engine = await getEngine(preferred);
    return engine?.name ?? null;
}

/**
 * Resolve a project-relative or absolute path to an absolute one.
 * @param {string} cwd
 * @param {string} file
 * @returns {string}
 * @ai.hint pure
 */
function toAbs(cwd, file) { return path.isAbsolute(file) ? file : path.join(cwd, file); }

/**
 * Parse a padding color: 'transparent', a named color, or #rgb/#rrggbb.
 * @param {string} value
 * @returns {{ r: number, g: number, b: number, alpha: number }}
 * @ai.hint pure
 */
export function fitBox(sourceWidth, sourceHeight, cellWidth, cellHeight) {
    if (!(sourceWidth > 0) || !(sourceHeight > 0) || !(cellWidth > 0) || !(cellHeight > 0)) {
        return { x: 0, y: 0, width: Math.max(1, cellWidth), height: Math.max(1, cellHeight), scale: 1 };
    }
    const scale = Math.min(cellWidth / sourceWidth, cellHeight / sourceHeight);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    return { x: Math.round((cellWidth - width) / 2), y: Math.round((cellHeight - height) / 2), width, height, scale };
}
export async function rasterInfo(file, { cwd = process.cwd(), engine = 'auto' } = {}) {
    const abs = toAbs(cwd, file);
    const bytes = await readFile(abs);
    if (engine !== 'canvas' && isSvgBytes(bytes)) {
        const rendered = await resvgPng(bytes).catch(() => null);
        if (rendered) return { width: rendered.width, height: rendered.height, format: 'svg', hasAlpha: true };
    }
    const active = await getEngine(engine);
    if (active?.name === 'sharp') {
        const meta = await active.lib(bytes).metadata();
        const swap = [5, 6, 7, 8].includes(meta.orientation);
        return {
            width: (swap ? meta.height : meta.width) ?? 0,
            height: (swap ? meta.width : meta.height) ?? 0,
            format: meta.format ?? '',
            hasAlpha: Boolean(meta.hasAlpha),
        };
    }
    if (active?.name === 'canvas') {
        const image = await active.lib.loadImage(bytes);
        return { width: image.width ?? 0, height: image.height ?? 0, format: '', hasAlpha: true };
    }
    throw new Error('No local raster engine: install sharp or canvas.');
}

/**
 * Whether the image has a pixel with alpha below 255; an alpha-capable format alone is not enough.
 * @param {string} file Absolute path or a path inside `cwd`.
 * @param {{ cwd?: string, engine?: 'auto'|'sharp'|'canvas' }} [options]
 * @returns {Promise<boolean|null>}
 * @exports
 * @ai.hint io
 */
export async function rasterIsOpaque(file, { cwd = process.cwd(), engine = 'auto' } = {}) {
    try {
        const frame = await decodeRgba(await readFile(toAbs(cwd, file)), engine);
        for (let i = 3; i < frame.data.length; i += 4) if (frame.data[i] < 255) return false;
        return true;
    } catch {
        return null;
    }
}

/**
 * Cleared share of the frame: `1 - mean(alpha)`, the same measure `magickAlphaShare` reports.
 * A real cut-out removes a large part of the picture; a painted transparency plate leaves only a
 * thin fringe along the silhouette, which this measure reports as near zero.
 * @param {{ input: string, cwd?: string, engine?: string }} options
 * @returns {Promise<number|null>} 0..1, or null when the picture cannot be decoded
 * @exports
 * @ai.hint io
 */
export async function rasterAlphaShare({ input, cwd = process.cwd(), engine = 'auto' }) {
    try {
        const frame = await decodeRgba(await readFile(toAbs(cwd, input)), engine);
        const total = frame.width * frame.height;
        if (!total) return null;
        let sum = 0;
        for (let i = 3; i < frame.data.length; i += 4) sum += frame.data[i];
        return 1 - sum / (total * 255);
    } catch {
        return null;
    }
}

/**
 * Share of the frame whose alpha sits in the soft band (`4% <= alpha < 96%`) — the same measure
 * `magickAlphaSoftShare` reports. A tight anti-aliased cut-out scores a fraction of a percent;
 * a matte drawn with a wide glow scores a fifth of the frame, which reads as a halo.
 * @param {{ input: string, cwd?: string, engine?: string }} options
 * @returns {Promise<number|null>} 0..1, or null when the picture cannot be decoded
 * @exports
 * @ai.hint io
 */
export async function rasterAlphaSoftShare({ input, cwd = process.cwd(), engine = 'auto' }) {
    try {
        const frame = await decodeRgba(await readFile(toAbs(cwd, input)), engine);
        const total = frame.width * frame.height;
        if (!total) return null;
        let opaque = 0;
        let nonEmpty = 0;
        for (let i = 3; i < frame.data.length; i += 4) {
            const a = frame.data[i];
            if (a >= 245) opaque++;
            if (a >= 10) nonEmpty++;
        }
        return (nonEmpty - opaque) / total;
    } catch {
        return null;
    }
}

/**
 * Decode one picture into raw RGBA.
 * @param {Buffer} bytes
 * @param {string} [preferred='auto'] — raster engine preference
 * @param {number|null} [maxSide=null] — cap the longest side while decoding
 * @returns {Promise<{ width: number, height: number, channels: 4, data: Buffer }>}
 * @exports
 * @ai.hint io
 */
export async function decodeRgba(bytes, preferred = 'auto', maxSide = null) {
    // SVG is rendered by ReSVG first: a dedicated renderer keeps gradients, masks, and text metrics
    // closer to the document than a raster library's SVG side feature. node-canvas stays the fallback.
    if (preferred !== 'canvas' && isSvgBytes(bytes)) {
        const rendered = await resvgPng(bytes, { width: maxSide, height: maxSide }).catch(() => null);
        if (rendered) return await decodeRgba(rendered.png, preferred, null);
    }
    const active = await getEngine(preferred);
    if (active?.name === 'sharp') {
        let pipe = active.lib(bytes).rotate();
        if (maxSide) pipe = pipe.resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true });
        const { data, info } = await pipe.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        return { width: info.width, height: info.height, channels: 4, data };
    }
    if (active?.name !== 'canvas') throw new Error('No local raster engine: install sharp or canvas.');
    const image = await active.lib.loadImage(bytes);
    const scale = maxSide ? Math.min(1, maxSide / Math.max(image.width, image.height)) : 1;
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const surface = active.lib.createCanvas(width, height);
    const ctx = surface.getContext('2d');
    ctx.drawImage(image, 0, 0, width, height);
    const frame = ctx.getImageData(0, 0, width, height);
    return { width, height, channels: 4, data: Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.length) };
}

/**
 * Scale an RGBA buffer to a box with bilinear weights, keeping the pixels proportional.
 * @param {{ width: number, height: number, data: Buffer }} source
 * @param {number} width
 * @param {number} height
 * @returns {{ width: number, height: number, channels: 4, data: Buffer }}
 * @ai.hint pure
 */
async function scaleRgba(source, width, height, preferred = 'auto') {
    if (source.width === width && source.height === height) return source;
    const active = await getEngine(preferred);
    if (active?.name === 'sharp') {
        const { data } = await active.lib(source.data, { raw: { width: source.width, height: source.height, channels: 4 } })
            .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
            .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        return { width, height, channels: 4, data };
    }
    if (active?.name !== 'canvas') throw new Error('No local raster engine: install sharp or canvas.');
    const surface = active.lib.createCanvas(width, height);
    const ctx = surface.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const imageData = ctx.createImageData(source.width, source.height);
    imageData.data.set(source.data);
    const sourceCanvas = active.lib.createCanvas(source.width, source.height);
    sourceCanvas.getContext('2d').putImageData(imageData, 0, 0);
    ctx.drawImage(sourceCanvas, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height);
    return { width, height, channels: 4, data: Buffer.from(image.data.buffer, image.data.byteOffset, image.data.length) };
}

/**
 * Encode an RGBA frame as PNG bytes.
 * @param {{ width: number, height: number, data: Buffer }} frame
 * @returns {Promise<Buffer>}
 * @ai.hint io
 */
async function encodePng(frame, preferred = 'auto') {
    const active = await getEngine(preferred);
    if (active?.name === 'sharp') return await active.lib(frame.data, { raw: { width: frame.width, height: frame.height, channels: 4 } }).png().toBuffer();
    if (active?.name !== 'canvas') throw new Error('No local raster engine: install sharp or canvas.');
    const surface = active.lib.createCanvas(frame.width, frame.height);
    const ctx = surface.getContext('2d');
    const image = ctx.createImageData(frame.width, frame.height);
    image.data.set(frame.data);
    ctx.putImageData(image, 0, 0);
    return surface.toBuffer('image/png');
}

/**
 * Encode an RGBA frame as PNG bytes with the preferred engine.
 *
 * The counterpart of `decodeRgba`: the stages build their frames in memory (padding, warping,
 * compositing) and need the bytes back without touching the disk.
 *
 * @param {{ width: number, height: number, data: Buffer }} frame
 * @param {string} [preferred='auto']
 * @returns {Promise<Buffer>}
 * @exports
 * @ai.hint io
 */
export async function encodeRgba(frame, preferred = 'auto') {
    if (!frame?.width || !frame?.height) throw new Error('encodeRgba: the frame has no pixels.');
    return await encodePng(frame, preferred);
}

/**
 * Scale an RGBA frame to an exact box, keeping the pixels proportional to the box.
 *
 * Exported because the stages build a picture in memory and then need it at the size the
 * downstream model expects; going through the disk for that would be a pointless round trip.
 *
 * @param {{ width: number, height: number, data: Buffer }} frame
 * @param {number} width
 * @param {number} height
 * @param {string} [preferred='auto']
 * @returns {Promise<{ width: number, height: number, channels: 4, data: Buffer }>}
 * @exports
 * @ai.hint io
 */
export async function rasterScale(frame, width, height, preferred = 'auto') {
    return await scaleRgba(frame, Math.max(1, Math.round(width)), Math.max(1, Math.round(height)), preferred);
}

/**
 * Mean gray level of a matte and the gray level of its top-left corner.
 * @param {{ width: number, height: number, data: Buffer }} matte
 * @returns {{ mean: number, corner: number }}
 * @ai.hint pure
 */
function matteProbe(matte) {
    let sum = 0;
    let seen = 0;
    const step = matte.width > 256 || matte.height > 256 ? 4 : 1;
    for (let y = 0; y < matte.height; y += step) {
        for (let x = 0; x < matte.width; x += step) {
            const at = (y * matte.width + x) * 4;
            sum += 0.2126 * matte.data[at] + 0.7152 * matte.data[at + 1] + 0.0722 * matte.data[at + 2];
            seen++;
        }
    }
    const corner = 0.2126 * matte.data[0] + 0.7152 * matte.data[1] + 0.0722 * matte.data[2];
    return { mean: seen ? sum / seen / 255 : 0, corner: corner / 255 };
}

/**
 * Turn a grayscale matte into an alpha channel and write the RGBA picture.
 * Mirrors `magickApplyAlphaMask`: an all-white or all-black matte is refused, a matte whose corner is
 * white is inverted, and `feather` smooths the transition band.
 * @param {{ input: string, mask: string, output?: string, cwd: string, signal?: AbortSignal, feather?: number }} options
 * @returns {Promise<{ changed: boolean, reason: string, inverted?: boolean, feathered?: number, width?: number, height?: number }>}
 * @exports
 * @ai.hint io
 */
export async function rasterApplyAlphaMask({ input, mask, output = input, cwd = process.cwd(), signal, feather = 1, engine = 'auto' }) {
    const inputBytes = await readFile(toAbs(cwd, input)).catch(() => null);
    if (!inputBytes) return { changed: false, reason: 'unreadable' };
    const base = await decodeRgba(inputBytes, engine).catch(() => null);
    if (!base?.width || !base.height) return { changed: false, reason: 'unreadable' };
    signal?.throwIfAborted();
    const matteBytes = await readFile(toAbs(cwd, mask)).catch(() => null);
    const matteSource = matteBytes && await decodeRgba(matteBytes, engine).catch(() => null);
    if (!matteSource?.width || !matteSource.height) return { changed: false, reason: 'unreadable' };
    const matte = await scaleRgba(matteSource, base.width, base.height, engine);
    const probe = matteProbe(matte);
    if (probe.mean <= 0.005) return { changed: false, reason: 'empty-mask' };
    if (probe.mean >= 0.995) return { changed: false, reason: 'full-mask' };
    const inverted = probe.corner > 0.5;
    const alpha = Buffer.alloc(matte.width * matte.height);
    for (let i = 0, p = 0; i < matte.data.length; i += 4, p++) alpha[p] = inverted ? 255 - matte.data[i] : matte.data[i];
    const smooth = Number.isFinite(feather) ? Math.max(0, Math.min(8, feather)) : 1;
    const blurred = smooth > 0 ? boxBlur(alpha, matte.width, matte.height, Math.max(1, Math.round(smooth))) : alpha;
    const rgba = Buffer.alloc(base.width * base.height * 4);
    for (let p = 0, i = 0; p < blurred.length; p++, i += 4) {
        rgba[i] = base.data[i];
        rgba[i + 1] = base.data[i + 1];
        rgba[i + 2] = base.data[i + 2];
        rgba[i + 3] = blurred[p];
    }
    const outAbs = toAbs(cwd, output);
    await mkdir(path.dirname(outAbs), { recursive: true });
    await writeFile(outAbs, await encodePng({ width: base.width, height: base.height, data: rgba }, engine));
    return { changed: true, reason: 'mask', inverted, feathered: smooth, width: base.width, height: base.height };
}

/**
 * Average a single channel over a square window: the transition band of a hard matte.
 * @param {Buffer} channel
 * @param {number} width
 * @param {number} height
 * @param {number} radius
 * @returns {Buffer}
 * @ai.hint pure
 */
function boxBlur(channel, width, height, radius) {
    if (radius <= 0) return channel;
    const horizontal = Buffer.alloc(channel.length);
    const out = Buffer.alloc(channel.length);
    for (let y = 0; y < height; y++) {
        let sum = 0;
        let count = 0;
        for (let x = 0; x < width; x++) {
            const enter = x === 0 ? radius : x + radius;
            const leave = x - radius - 1;
            if (x === 0) {
                for (let first = 0; first <= Math.min(radius, width - 1); first++) { sum += channel[y * width + first]; count++; }
            } else if (enter < width) { sum += channel[y * width + enter]; count++; }
            if (x > 0 && leave >= 0) { sum -= channel[y * width + leave]; count--; }
            horizontal[y * width + x] = Math.round(sum / Math.max(1, count));
        }
    }
    for (let x = 0; x < width; x++) {
        let sum = 0;
        let count = 0;
        for (let y = 0; y < height; y++) {
            const enter = y === 0 ? radius : y + radius;
            const leave = y - radius - 1;
            if (y === 0) {
                for (let first = 0; first <= Math.min(radius, height - 1); first++) { sum += horizontal[first * width + x]; count++; }
            } else if (enter < height) { sum += horizontal[enter * width + x]; count++; }
            if (y > 0 && leave >= 0) { sum -= horizontal[leave * width + x]; count--; }
            out[y * width + x] = Math.round(sum / Math.max(1, count));
        }
    }
    return out;
}

/**
 * Weighted distance of one pixel to a key color, normalized to 0..255.
 * Green carries most of the perceived detail, so it weighs double; the scale is chosen so that the
 * largest possible distance lands exactly on 255.
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {{ r: number, g: number, b: number }} key
 * @returns {number}
 * @ai.hint pure
 */
function keyDistance(r, g, b, key) {
    const dr = r - key.r;
    const dg = g - key.g;
    const db = b - key.b;
    return Math.round(Math.sqrt((2 * dr * dr + 4 * dg * dg + 2 * db * db) / 8));
}

/**
 * Read a key color from `#rrggbb`, `rrggbb`, an object, or a triple. Returns null when unparsable.
 * @param {string|{ r: number, g: number, b: number }|number[]|null|undefined} key
 * @returns {{ r: number, g: number, b: number }|null}
 * @ai.hint pure
 */
function parseKeyColor(key) {
    if (!key) return null;
    if (Array.isArray(key) && key.length >= 3) return { r: Number(key[0]), g: Number(key[1]), b: Number(key[2]) };
    if (typeof key === 'object') {
        const { r, g, b } = key;
        return [r, g, b].every((v) => Number.isFinite(v)) ? { r, g, b } : null;
    }
    const match = /^#?([0-9a-f]{6})$/i.exec(String(key).trim());
    if (!match) return null;
    const value = parseInt(match[1], 16);
    return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

/**
 * Turn a flat background of a known color into a real alpha channel, without a model matte.
 *
 * The picture is keyed against the color its background was painted with: the distance map is
 * flooded inward from the four frame edges, so only background that is reachable from the border
 * becomes transparent, and an interior patch of the same color survives as part of the subject.
 * Pixels inside the `low..high` distance band get a smoothstep alpha, which is what keeps the rim
 * anti-aliased. Because the alpha is derived from the very pixels it is stored beside, the edge of
 * A cannot drift away from the edge of RGB — the stair-stepping a separately drawn matte leaves.
 *
 * `key-miss` is reported when the flood clears nothing: the painted background does not match the
 * key color, so the caller should fall back to a matte.
 * @param {{ input: string, output?: string, key: string|{ r: number, g: number, b: number }, cwd: string, signal?: AbortSignal, low?: number, high?: number, feather?: number, engine?: string }} options
 * @returns {Promise<{ changed: boolean, reason: string, width?: number, height?: number, cleared?: number, key?: { r: number, g: number, b: number } }>}
 * @exports
 * @ai.hint io
 */
export async function rasterColorKeyAlpha({ input, output = input, key, cwd = process.cwd(), signal, low = 16, high = 56, feather = 0, engine = 'auto' }) {
    const rgb = parseKeyColor(key);
    if (!rgb) return { changed: false, reason: 'bad-key' };
    const bytes = await readFile(toAbs(cwd, input)).catch(() => null);
    if (!bytes) return { changed: false, reason: 'unreadable' };
    const frame = await decodeRgba(bytes, engine).catch(() => null);
    if (!frame?.width || !frame.height) return { changed: false, reason: 'unreadable' };
    signal?.throwIfAborted();

    const { width, height, data } = frame;
    const total = width * height;
    // One byte per pixel keeps the map of a 4K frame in megabytes rather than tens of them.
    const dist = new Uint8Array(total);
    for (let i = 0, p = 0; i < total; i++, p += 4) dist[i] = keyDistance(data[p], data[p + 1], data[p + 2], rgb);

    const background = new Uint8Array(total);
    const stack = new Int32Array(total);
    let top = 0;
    const push = (idx) => {
        if (!background[idx] && dist[idx] <= high) {
            background[idx] = 1;
            stack[top++] = idx;
        }
    };
    for (let x = 0; x < width; x++) { push(x); push((height - 1) * width + x); }
    for (let y = 0; y < height; y++) { push(y * width); push(y * width + width - 1); }
    while (top > 0) {
        const idx = stack[--top];
        const x = idx % width;
        const y = (idx - x) / width;
        if (x > 0) push(idx - 1);
        if (x + 1 < width) push(idx + 1);
        if (y > 0) push(idx - width);
        if (y + 1 < height) push(idx + width);
    }

    const lo = Math.max(0, Math.min(254, low));
    const hi = Math.max(lo + 1, Math.min(255, high));
    let cleared = 0;
    for (let i = 0; i < total; i++) {
        let a;
        if (!background[i]) a = 255;
        else if (dist[i] <= lo) a = 0;
        else {
            const t = (dist[i] - lo) / (hi - lo);
            a = Math.round(255 * t * t * (3 - 2 * t));
        }
        data[i * 4 + 3] = a;
        if (a < 10) cleared++;
    }
    const share = cleared / total;
    // Nothing cleared means the frame does not carry the key color at its border: the paint pass
    // answered with something else, so a model matte is the better bet.
    if (share < 0.005) return { changed: false, reason: 'key-miss', width, height, cleared: Number(share.toFixed(4)), key: rgb };

    const smooth = Number.isFinite(feather) ? Math.max(0, Math.min(8, feather)) : 0;
    if (smooth > 0) {
        const alpha = Buffer.alloc(total);
        for (let i = 0; i < total; i++) alpha[i] = data[i * 4 + 3];
        const blurred = boxBlur(alpha, width, height, Math.round(smooth));
        for (let i = 0; i < total; i++) data[i * 4 + 3] = blurred[i];
    }

    const outAbs = toAbs(cwd, output);
    await mkdir(path.dirname(outAbs), { recursive: true });
    await writeFile(outAbs, await encodePng({ width, height, channels: 4, data }, engine));
    return { changed: true, reason: 'color-key', width, height, cleared: Number(share.toFixed(4)), key: rgb, feathered: smooth };
}

/**
 * Draw a local alpha matte from the picture itself, without a model or ImageMagick.
 *
 * `contour` floods the four corners with the corner color (within `fuzz`) and keeps the rest opaque.
 * `saturation` uses HSL saturation: colored pixels become the subject, neutral pixels become transparent.
 * Both return the same `{ changed, reason }` contract as `magickContourAlphaMask`/`magickSaturationAlphaMask`.
 * @param {{ input: string, output?: string, cwd: string, signal?: AbortSignal, mode: 'contour'|'saturation', fuzz?: number, threshold?: number }} options
 * @returns {Promise<{ changed: boolean, reason: string, width?: number, height?: number }>}
 * @exports
 * @ai.hint io
 */
export async function rasterLocalAlphaMatte({ input, output = input, cwd = process.cwd(), signal, mode, fuzz = 10, threshold = 15, engine = 'auto' }) {
    const base = await decodeRgba(await readFile(toAbs(cwd, input)), engine);
    if (!base.width || !base.height) return { changed: false, reason: 'unreadable' };
    signal?.throwIfAborted();
    let alpha = Buffer.alloc(base.width * base.height);
    if (mode === 'contour') {
        const corner = [base.data[0], base.data[1], base.data[2]];
        const tol = Math.max(0, Math.min(255, Math.round(fuzz * 2.55)));
        const queue = [];
        const push = (x, y) => { const p = y * base.width + x; if (!alpha[p]) { alpha[p] = 1; queue.push(p); } };
        push(0, 0); push(base.width - 1, 0); push(0, base.height - 1); push(base.width - 1, base.height - 1);
        for (let head = 0; head < queue.length; head++) {
            const p = queue[head];
            const x = p % base.width;
            const y = (p / base.width) | 0;
            const at = p * 4;
            const near = Math.abs(base.data[at] - corner[0]) <= tol
                && Math.abs(base.data[at + 1] - corner[1]) <= tol
                && Math.abs(base.data[at + 2] - corner[2]) <= tol;
            if (!near) { alpha[p] = 0; continue; }
            if (x > 0) push(x - 1, y);
            if (x + 1 < base.width) push(x + 1, y);
            if (y > 0) push(x, y - 1);
            if (y + 1 < base.height) push(x, y + 1);
        }
        for (let p = 0; p < alpha.length; p++) alpha[p] = alpha[p] ? 0 : 255;
    } else {
        for (let p = 0, i = 0; i < base.data.length; i += 4, p++) {
            const r = base.data[i] / 255, g = base.data[i + 1] / 255, b = base.data[i + 2] / 255;
            const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
            const sat = max === 0 ? 0 : delta / max;
            alpha[p] = sat * 100 >= threshold ? 255 : 0;
        }
    }
    // The matte is a grayscale picture: white keeps the subject, black cuts it. Writing the source
    // colors here would make `rasterApplyAlphaMask` read a color channel as alpha.
    const matteRgba = Buffer.alloc(alpha.length * 4);
    for (let p = 0, i = 0; p < alpha.length; p++, i += 4) {
        matteRgba[i] = alpha[p];
        matteRgba[i + 1] = alpha[p];
        matteRgba[i + 2] = alpha[p];
        matteRgba[i + 3] = 255;
    }
    const outAbs = toAbs(cwd, output);
    await mkdir(path.dirname(outAbs), { recursive: true });
    await writeFile(outAbs, await encodePng({ width: base.width, height: base.height, data: matteRgba }, engine));
    const probe = matteProbe({ width: base.width, height: base.height, data: matteRgba });
    if (probe.mean <= 0.005) return { changed: false, reason: 'empty-mask' };
    if (probe.mean >= 0.995) return { changed: false, reason: 'full-mask' };
    return { changed: true, reason: mode, width: base.width, height: base.height };
}

/**
 * Detect a painted transparency plate without ImageMagick: a checkerboard or a gray grid that an
 * image model draws instead of an alpha channel. Two corner patches are read; a fake plate holds a
 * handful of neutral tones (the color count does not change in grayscale), while a real background
 * is one flat color or a colored picture.
 * @param {{ input: string, cwd: string, signal?: AbortSignal, patch?: number, engine?: string }} options
 * @returns {Promise<{ fake: boolean, reason: string, colors: number|null, mean: number|null }>}
 * @exports
 * @ai.hint io
 */
export async function rasterDetectFakeTransparency({ input, cwd = process.cwd(), signal, patch = 16, engine = 'auto' }) {
    const bytes = await readFile(toAbs(cwd, input)).catch(() => null);
    if (!bytes) return { fake: false, reason: 'unreadable', colors: null, mean: null };
    const frame = await decodeRgba(bytes, engine).catch(() => null);
    if (!frame?.width || !frame.height) return { fake: false, reason: 'unreadable', colors: null, mean: null };
    signal?.throwIfAborted();
    const side = Math.max(4, Math.min(patch, frame.width, frame.height));
    const samples = [];
    for (const [x0, y0] of [[0, 0], [Math.max(0, frame.width - side), 0]]) {
        const colors = new Set();
        const grays = new Set();
        let neutral = true;
        let sum = 0;
        let count = 0;
        for (let y = y0; y < y0 + side; y++) {
            for (let x = x0; x < x0 + side; x++) {
                const at = (y * frame.width + x) * 4;
                if (frame.data[at + 3] < 255) return { fake: false, reason: 'already', colors: null, mean: null };
                const r = frame.data[at], g = frame.data[at + 1], b = frame.data[at + 2];
                colors.add(`${r},${g},${b}`);
                grays.add(Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b));
                if (Math.max(r, g, b) - Math.min(r, g, b) > 8) neutral = false;
                sum += (r + g + b) / 3;
                count++;
            }
        }
        samples.push({ colors: colors.size, grayColors: grays.size, mean: count ? sum / count / 255 : 0, neutral });
    }
    const hit = (item) => item.neutral && item.colors >= 2 && item.colors <= 16
        && item.colors === item.grayColors && item.mean >= 0.2 && item.mean <= 0.97;
    const hits = samples.filter(hit);
    const first = samples[0];
    if (hits.length === samples.length) return { fake: true, reason: 'checkerboard', colors: first.colors, mean: first.mean };
    return { fake: false, reason: hits.length ? 'partly-neutral' : 'plain', colors: first.colors, mean: first.mean };
}

/**
 * Cut a box out of a picture.
 * @param {{ input: string, output: string, x: number, y: number, width: number, height: number, cwd: string, signal?: AbortSignal }} options
 * @returns {Promise<{ rel: string, bytes: number, width: number, height: number }>}
 * @exports
 * @ai.hint io
 */
export async function rasterCrop({ input, output, x = 0, y = 0, width, height, cwd = process.cwd(), signal, engine = 'auto' }) {
    const bytes = await readFile(toAbs(cwd, input));
    signal?.throwIfAborted();
    const left = Math.max(0, Math.round(x));
    const top = Math.max(0, Math.round(y));
    const cropWidth = Math.max(1, Math.round(width));
    const cropHeight = Math.max(1, Math.round(height));
    const active = await getEngine(engine);
    const outAbs = toAbs(cwd, output);
    await mkdir(path.dirname(outAbs), { recursive: true });
    if (active?.name === 'sharp') {
        const info = await active.lib(bytes).metadata();
        const box = {
            left: Math.min(left, Math.max(0, info.width - 1)),
            top: Math.min(top, Math.max(0, info.height - 1)),
            width: Math.min(cropWidth, info.width - Math.min(left, Math.max(0, info.width - 1))),
            height: Math.min(cropHeight, info.height - Math.min(top, Math.max(0, info.height - 1))),
        };
        const png = await active.lib(bytes).rotate().extract(box).png().toBuffer();
        await writeFile(outAbs, png);
        return { rel: String(output).split(path.sep).join('/'), bytes: png.length, width: box.width, height: box.height };
    }
    const source = await decodeRgba(bytes, engine);
    const box = { left: Math.min(left, source.width - 1), top: Math.min(top, source.height - 1) };
    box.width = Math.min(cropWidth, source.width - box.left);
    box.height = Math.min(cropHeight, source.height - box.top);
    const data = Buffer.alloc(box.width * box.height * 4);
    for (let row = 0; row < box.height; row++) {
        source.data.copy(data, row * box.width * 4, ((box.top + row) * source.width + box.left) * 4, ((box.top + row) * source.width + box.left) * 4 + box.width * 4);
    }
    const png = await encodePng({ width: box.width, height: box.height, data }, engine);
    await writeFile(outAbs, png);
    return { rel: String(output).split(path.sep).join('/'), bytes: png.length, width: box.width, height: box.height };
}

/**
 * Bring one layer file to the size of its box.
 *
 * The vendor scales every layer on its own to the chosen tier, so the file of a layer is not the
 * frame of its box: "each layer is scaled separately at the chosen level, so the file size may
 * differ from the bounding_box. When assembling, bring the layer to `w × h` and place it at
 * `(x, y)`." The pixels of the layer file are therefore not the coordinates of the base.
 *
 * The resize is exact, because the layer canvas carries the aspect of its box; a file whose aspect
 * differs from the box is reported, so a distortion never passes unnoticed.
 * @param {{ input: string, output: string, width: number, height: number, cwd?: string, signal?: AbortSignal, engine?: 'auto'|'sharp'|'canvas' }} options
 * @returns {Promise<{ rel: string, bytes: number, width: number, height: number, aspectDiff: number }>}
 * @exports
 * @ai.hint io
 */
export async function rasterFitToBox({ input, output, width, height, cwd = process.cwd(), signal, engine = 'auto' }) {
    const targetWidth = Math.max(1, Math.round(width));
    const targetHeight = Math.max(1, Math.round(height));
    const bytes = await readFile(toAbs(cwd, input));
    signal?.throwIfAborted();
    const frame = await decodeRgba(bytes, engine);
    const aspectDiff = frame.height
        ? Math.abs((frame.width / frame.height) - (targetWidth / targetHeight)) / (targetWidth / targetHeight)
        : 0;
    const scaled = frame.width === targetWidth && frame.height === targetHeight
        ? frame
        : await scaleRgba(frame, targetWidth, targetHeight, engine);
    const png = await encodePng(scaled, engine);
    const outAbs = toAbs(cwd, output);
    await mkdir(path.dirname(outAbs), { recursive: true });
    await writeFile(outAbs, png);
    return {
        rel: String(output).split(path.sep).join('/'),
        bytes: png.length,
        width: targetWidth,
        height: targetHeight,
        aspectDiff,
    };
}

/**
 * Stitch a repaired fragment back into its picture at the exact box it was cut from.
 *
 * The counterpart of `rasterCrop`, and the reason a generative repair can be called targeted: the
 * model never sees or returns the whole screen, only the box, and every pixel outside that box is
 * copied from the untouched source file rather than resampled. A model that returns a different
 * frame size (the families that round to their own grid) is scaled back onto the box, so the patch
 * always lands where the crop was taken and the screen keeps its original dimensions.
 * @param {{ input: string, patch: string, output: string, x: number, y: number, width?: number|null, height?: number|null, cwd: string, signal?: AbortSignal, engine?: string, blend?: boolean }} options
 *   `width`/`height` override the box the patch is stretched to; by default the patch keeps its own
 *   size, which is the crop size when it comes back unchanged.
 *   `blend` composites the patch over the base by its alpha; without it the patch replaces the box.
 * @returns {Promise<{ rel: string, bytes: number, width: number, height: number, box: {x:number,y:number,width:number,height:number}, resized: boolean }>}
 * @exports
 * @ai.hint io
 */
export async function rasterPatch({
    input, patch, output, x = 0, y = 0, width = null, height = null, cwd = process.cwd(), signal, engine = 'auto', blend = false,
}) {
    const baseBytes = await readFile(toAbs(cwd, input));
    const patchBytes = await readFile(toAbs(cwd, patch));
    signal?.throwIfAborted();
    const base = await decodeRgba(baseBytes, engine);
    let frame = await decodeRgba(patchBytes, engine);
    signal?.throwIfAborted();

    const box = {
        x: Math.max(0, Math.round(x)),
        y: Math.max(0, Math.round(y)),
        width: Math.max(1, Math.round(width ?? frame.width)),
        height: Math.max(1, Math.round(height ?? frame.height)),
    };
    // A patch wider or taller than the frame cannot be placed honestly; refusing is better than
    // silently clipping the repair into a corner of the screen.
    if (box.x + box.width > base.width || box.y + box.height > base.height) {
        throw new Error(`rasterPatch: patch ${box.width}×${box.height} at (${box.x},${box.y}) does not fit into the ${base.width}×${base.height} frame.`);
    }
    const resized = frame.width !== box.width || frame.height !== box.height;
    if (resized) frame = await scaleRgba(frame, box.width, box.height, engine);

    // Copy, not blit: the repair replaces what was there, and an alpha the model returned must not
    // let the damaged pixel show through underneath. The source row is counted from the top of the
    // patch — `box.y` belongs to the base frame only. Reading the patch at `box.y + row` offsets the
    // copy by the box position and runs past a patch that is shorter than the base, so every stitch
    // below row 0 used to fail with a buffer-range error. `blend` is the opt-in exception used by
    // the extension seam: a feathered patch is composited over the untouched source.
    for (let row = 0; row < box.height; row++) {
        const from = (row * box.width) * 4;
        const to = ((box.y + row) * base.width + box.x) * 4;
        if (!blend) {
            frame.data.copy(base.data, to, from, from + box.width * 4);
            continue;
        }
        for (let column = 0; column < box.width; column++) {
            const sourceAt = from + column * 4;
            const targetAt = to + column * 4;
            const alpha = frame.data[sourceAt + 3] / 255;
            if (alpha >= 1) {
                frame.data.copy(base.data, targetAt, sourceAt, sourceAt + 4);
            } else if (alpha > 0) {
                for (let channel = 0; channel < 3; channel++) {
                    base.data[targetAt + channel] = Math.round(
                        frame.data[sourceAt + channel] * alpha
                        + base.data[targetAt + channel] * (1 - alpha),
                    );
                }
                base.data[targetAt + 3] = Math.round(
                    frame.data[sourceAt + 3] * alpha
                    + base.data[targetAt + 3] * (1 - alpha),
                );
            }
        }
    }

    const png = await encodePng(base, engine);
    const outAbs = toAbs(cwd, output);
    await mkdir(path.dirname(outAbs), { recursive: true });
    await writeFile(outAbs, png);
    return {
        rel: String(output).split(path.sep).join('/'),
        bytes: png.length, width: base.width, height: base.height, box, resized,
    };
}

/**
 * Cover the target frame from the reply's pixels and center-crop the 16-grid rounding
 * residual. This is the correction for a model that returns a larger frame than requested
 * (its own pipeline upscales and rounds to a 16-pixel grid): the entire picture is scaled
 * uniformly so the target box is covered, and the small remainder is cropped from the
 * centre. When the aspect mismatch is too large (more than 1/16 of either side) the function falls
 * back to `inside` so no content is destroyed.
 * @param {{ bytes: Buffer, width: number, height: number, engine?: 'auto'|'sharp'|'canvas'|'magick' }} options
 * @returns {Promise<Buffer|null>} the rescaled PNG, or null when no engine is available
 * @exports
 * @ai.hint io
 */
export async function rasterFitToSourceFrame({ bytes, width, height, engine = 'auto' }) {
    const active = await getEngine(engine);
    if (!active) return null;
    if (active.name === 'sharp') {
        const info = await active.lib(bytes).metadata();
        if (!info.width || !info.height) return null;
        // Cover scale: max of per-side ratios.  Compute the crop fraction so we can fall back
        // to inside when the two frames differ in aspect beyond a small rounding residual.
        const scale = Math.max(width / info.width, height / info.height);
        const cropX = (info.width * scale - width) / (info.width * scale);
        const cropY = (info.height * scale - height) / (info.height * scale);
        const badCrop = cropX > 1 / 16 || cropY > 1 / 16;
        return await active.lib(bytes).rotate()
            .resize(width, height, badCrop
                ? { fit: 'inside', kernel: 'lanczos3' }
                : { fit: 'cover', position: 'centre', kernel: 'lanczos3' })
            .png().toBuffer();
    }
    const source = await decodeRgba(bytes, active.name);
    if (!source.width || !source.height) return null;
    const scale = Math.max(width / source.width, height / source.height);
    const scaledW = Math.round(source.width * scale);
    const scaledH = Math.round(source.height * scale);
    const cropX = (scaledW - width) / scaledW;
    const cropY = (scaledH - height) / scaledH;
    const badCrop = cropX > 1 / 16 || cropY > 1 / 16;
    if (badCrop) {
        const s = Math.min(width / source.width, height / source.height);
        const outW = Math.max(1, Math.round(source.width * s));
        const outH = Math.max(1, Math.round(source.height * s));
        const out = { width: outW, height: outH, channels: 4, data: Buffer.alloc(outW * outH * 4) };
        for (let row = 0; row < outH; row++) {
            const srcRow = Math.min(source.height - 1, Math.floor(row / s));
            for (let col = 0; col < outW; col++) {
                const srcCol = Math.min(source.width - 1, Math.floor(col / s));
                const from = (srcRow * source.width + srcCol) * 4;
                const to = (row * outW + col) * 4;
                out.data[to] = source.data[from];
                out.data[to + 1] = source.data[from + 1];
                out.data[to + 2] = source.data[from + 2];
                out.data[to + 3] = source.data[from + 3];
            }
        }
        return await encodePng(out, active.name);
    }
    // Cover + center-crop via canvas drawImage.
    const offsetX = Math.round((width - scaledW) / 2);
    const offsetY = Math.round((height - scaledH) / 2);
    const surface = active.lib.createCanvas(width, height);
    const ctx = surface.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const srcSurface = active.lib.createCanvas(source.width, source.height);
    const srcCtx = srcSurface.getContext('2d');
    const srcImage = srcCtx.createImageData(source.width, source.height);
    srcImage.data.set(source.data);
    srcCtx.putImageData(srcImage, 0, 0);
    ctx.drawImage(srcSurface, offsetX, offsetY, scaledW, scaledH);
    const image = ctx.getImageData(0, 0, width, height);
    return await encodePng({ width, height, channels: 4, data: Buffer.from(image.data.buffer, image.data.byteOffset, image.data.length) }, active.name);
}

/**
 * Cut uniform or transparent padding off all four edges.
 * @param {{ input: string, output?: string, cwd: string, signal?: AbortSignal, fuzz?: number|null }} options
 * @returns {Promise<{ changed: boolean, reason: string, before?: {width:number,height:number}, after?: {width:number,height:number} }>}
 * @exports
 * @ai.hint io
 */
export async function rasterTrim({ input, output = input, cwd = process.cwd(), signal, fuzz = 6, engine = 'auto', transparentOnly = false }) {
    const before = await rasterInfo(input, { cwd, engine }).catch(() => null);
    if (!before?.width || !before.height) return { changed: false, reason: 'unreadable' };
    const frame = await decodeRgba(await readFile(toAbs(cwd, input)), engine);
    signal?.throwIfAborted();
    const tolerance = Math.max(0, Math.min(255, Math.round((Number.isFinite(fuzz) ? fuzz : 6) * 2.55)));
    const edge = { r: frame.data[0], g: frame.data[1], b: frame.data[2], a: frame.data[3] };
    const matches = (index) => {
        const a = frame.data[index + 3];
        if (transparentOnly) return a === 0;
        if (edge.a === 0 || a === 0) return a === edge.a || (a <= tolerance && edge.a <= tolerance);
        return Math.abs(frame.data[index] - edge.r) <= tolerance
            && Math.abs(frame.data[index + 1] - edge.g) <= tolerance
            && Math.abs(frame.data[index + 2] - edge.b) <= tolerance;
    };
    const rowUniform = (y) => {
        for (let x = 0; x < frame.width; x++) if (!matches((y * frame.width + x) * 4)) return false;
        return true;
    };
    const columnUniform = (x) => {
        for (let y = 0; y < frame.height; y++) if (!matches((y * frame.width + x) * 4)) return false;
        return true;
    };
    let top = 0;
    let bottom = frame.height - 1;
    let left = 0;
    let right = frame.width - 1;
    while (top < bottom && rowUniform(top)) top++;
    while (bottom > top && rowUniform(bottom)) bottom--;
    while (left < right && columnUniform(left)) left++;
    while (right > left && columnUniform(right)) right--;
    const box = { width: right - left + 1, height: bottom - top + 1 };
    if (box.width === frame.width && box.height === frame.height) return { changed: false, reason: 'no-padding', before, after: before };
    if (box.width < frame.width * 0.1 || box.height < frame.height * 0.1) return { changed: false, reason: 'too-small', before, after: box };
    const result = await rasterCrop({ input, output, x: left, y: top, width: box.width, height: box.height, cwd, signal, engine });
    return { changed: true, reason: 'trimmed', before, after: { width: result.width, height: result.height } };
}

/**
 * Cut a picture into a rows×cols grid, the same tile geometry as `magickSplit`.
 * @param {{ input: string, outputDir: string, rows: number, cols: number, cwd: string, signal?: AbortSignal, baseName?: string }} options
 * @returns {Promise<Array<{ rel: string, row: number, col: number, x: number, y: number, width: number, height: number, bytes: number }>>}
 * @exports
 * @ai.hint io
 */
export async function rasterSplit({ input, outputDir, rows, cols, cwd = process.cwd(), signal, baseName = 'tile', engine = 'auto' }) {
    const info = await rasterInfo(input, { cwd, engine });
    if (!info.width || !info.height) throw new Error(`Cannot read the dimensions of: ${input}`);
    const tileW = Math.floor(info.width / cols);
    const tileH = Math.floor(info.height / rows);
    const tiles = [];
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const x = col * tileW;
            const y = row * tileH;
            const width = col === cols - 1 ? info.width - x : tileW;
            const height = row === rows - 1 ? info.height - y : tileH;
            const rel = `${outputDir}/${baseName}_r${row + 1}c${col + 1}.png`;
            const cut = await rasterCrop({ input, output: rel, x, y, width, height, cwd, signal, engine });
            tiles.push({ rel, row: row + 1, col: col + 1, x, y, width, height, bytes: cut.bytes });
        }
    }
    return tiles;
}

/**
 * Pad an image with transparent pixels until both sides are multiples of 16, without scaling the
 * source pixels. Providers that reject other sizes get a valid frame and the original box is
 * restored from the returned padding.
 * `targetWidth`/`targetHeight` raise that floor to a frame the model requires — the smallest canvas
 * a megapixel-class model accepts, for instance. `offsetX`/`offsetY` put the source pixels away
 * from the top-left corner, so a band may be grown on the top or on the left as well. The source
 * pixels keep their own size and their own place, only empty space is added around them.
 * @param {{ bytes: Buffer, engine?: 'auto'|'sharp'|'canvas'|'magick', targetWidth?: number|null, targetHeight?: number|null, offsetX?: number, offsetY?: number }} options
 * @returns {Promise<{ bytes: Buffer, width: number, height: number, originalWidth: number, originalHeight: number, offsetX: number, offsetY: number, padded: boolean, engine: string }|null>}
 * @exports
 * @ai.hint io
 */
export async function rasterPadImageBytes({
    bytes, engine = 'auto', targetWidth = null, targetHeight = null, offsetX = 0, offsetY = 0,
}) {
    const active = await getEngine(engine);
    if (!active) return null;
    const info = await rasterInfoFromBytes(bytes, active);
    if (!info.width || !info.height) throw new Error('Cannot read the dimensions of the input image.');
    const left = Math.max(0, Math.round(Number(offsetX) || 0));
    const top = Math.max(0, Math.round(Number(offsetY) || 0));
    const width = Math.max(
        Math.ceil((info.width + left) / 16) * 16,
        Math.ceil(Math.max(1, Number(targetWidth) || 1) / 16) * 16,
    );
    const height = Math.max(
        Math.ceil((info.height + top) / 16) * 16,
        Math.ceil(Math.max(1, Number(targetHeight) || 1) / 16) * 16,
    );
    const right = width - info.width - left;
    const bottom = height - info.height - top;
    const padded = width !== info.width || height !== info.height;
    const frame = await decodeRgba(bytes, active.name);
    if (!padded) {
        return {
            bytes, width, height, originalWidth: frame.width, originalHeight: frame.height,
            offsetX: left, offsetY: top, padded: false, engine: active.name,
        };
    }
    if (active.name === 'sharp') {
        const output = await active.lib(bytes).rotate()
            .extend({ left, top, right, bottom, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
        return {
            bytes: output, width, height, originalWidth: frame.width, originalHeight: frame.height,
            offsetX: left, offsetY: top, padded: true, engine: active.name,
        };
    }
    const output = { width, height, channels: 4, data: Buffer.alloc(width * height * 4) };
    for (let row = 0; row < frame.height; row++) {
        frame.data.copy(
            output.data,
            ((row + top) * width + left) * 4,
            row * frame.width * 4,
            (row + 1) * frame.width * 4,
        );
    }
    return {
        bytes: await encodePng(output, active.name), width, height,
        originalWidth: frame.width, originalHeight: frame.height,
        offsetX: left, offsetY: top, padded: true, engine: active.name,
    };
}

/**
 * Restore the exact original top-left frame after a provider returns a padded frame.
 * @param {{ bytes: Buffer, width: number, height: number, originalWidth: number, originalHeight: number, engine?: 'auto'|'sharp'|'canvas' }} options
 * @returns {Promise<Buffer>}
 * @exports
 * @ai.hint io
 */
export async function rasterRemoveImagePadding({ bytes, width, height, originalWidth, originalHeight, engine = 'auto', normalized = false }) {
    if (width === originalWidth && height === originalHeight) return bytes;
    const active = await getEngine(engine);
    if (!active) return null;
    const info = await rasterInfoFromBytes(bytes, active);
    if ((!normalized && (info.width !== width || info.height !== height))
        || !info.width || !info.height || originalWidth > width || originalHeight > height) return bytes;
    const cropWidth = normalized ? Math.round(info.width * originalWidth / width) : originalWidth;
    const cropHeight = normalized ? Math.round(info.height * originalHeight / height) : originalHeight;
    if (!cropWidth || !cropHeight || cropWidth > info.width || cropHeight > info.height) return bytes;
    if (active.name === 'sharp') {
        return await active.lib(bytes).extract({ left: 0, top: 0, width: cropWidth, height: cropHeight }).png().toBuffer();
    }
    const frame = await decodeRgba(bytes, active.name);
    const data = Buffer.alloc(cropWidth * cropHeight * 4);
    for (let row = 0; row < cropHeight; row++) frame.data.copy(data, row * cropWidth * 4, row * info.width * 4, row * info.width * 4 + cropWidth * 4);
    return await encodePng({ width: cropWidth, height: cropHeight, data }, active.name);
}

/** Metadata of a buffer using an already-selected native engine. */
async function rasterInfoFromBytes(bytes, active) {
    if (active.name === 'sharp') {
        const info = await active.lib(bytes).metadata();
        const swap = [5, 6, 7, 8].includes(info.orientation);
        return { width: (swap ? info.height : info.width) ?? 0, height: (swap ? info.width : info.height) ?? 0 };
    }
    const image = await active.lib.loadImage(bytes);
    return { width: image.width ?? 0, height: image.height ?? 0 };
}

/**
 * Rasterize an SVG document locally: ReSVG first, then librsvg through sharp, then node-canvas.
 * No browser is started.
 * @param {{ input: string, output: string, width?: number|null, height?: number|null, cwd: string, signal?: AbortSignal, engine?: 'auto'|'sharp'|'canvas'|'magick' }} options
 * @returns {Promise<{ rel: string, bytes: number, width: number, height: number, engine: string }>}
 * @exports
 * @ai.hint io
 */
export async function rasterizeSvg({ input, output, width = null, height = null, cwd = process.cwd(), signal, engine = 'auto' }) {
    const bytes = await readFile(toAbs(cwd, input));
    signal?.throwIfAborted();
    const outAbs = toAbs(cwd, output);
    await mkdir(path.dirname(outAbs), { recursive: true });
    if (engine !== 'canvas') {
        const rendered = await resvgPng(bytes, { width, height }).catch(() => null);
        if (rendered) {
            await writeFile(outAbs, rendered.png);
            return { rel: String(output).split(path.sep).join('/'), bytes: rendered.png.length, width: rendered.width, height: rendered.height, engine: 'resvg' };
        }
    }
    const active = await getEngine(engine);
    if (active?.name === 'sharp') {
        let pipe = active.lib(bytes, { density: 96 });
        if (width || height) pipe = pipe.resize(width || undefined, height || undefined, { fit: 'inside' });
        await pipe.png().toFile(outAbs);
        const info = await active.lib(await readFile(outAbs)).metadata();
        return { rel: String(output).split(path.sep).join('/'), bytes: (await stat(outAbs)).size, width: info.width, height: info.height, engine: 'sharp' };
    }
    if (active?.name !== 'canvas') throw new Error('No local raster engine: install sharp, canvas or @resvg/resvg-js.');
    const image = await active.lib.loadImage(bytes);
    const box = width || height
        ? fitBox(image.width, image.height, width ?? image.width, height ?? image.height)
        : { width: image.width, height: image.height };
    const surface = active.lib.createCanvas(box.width, box.height);
    surface.getContext('2d').drawImage(image, 0, 0, box.width, box.height);
    const png = surface.toBuffer('image/png');
    await writeFile(outAbs, png);
    return { rel: String(output).split(path.sep).join('/'), bytes: png.length, width: box.width, height: box.height, engine: 'canvas' };
}

/**
 * Compare two frames pixel by pixel.
 *
 * The stages use this to decide whether a picture really changed: the seam of an extended frame
 * must stay put, and a restored fragment must not repaint the rest of the screen.
 * @param {{ before: Buffer|Uint8Array, after: Buffer|Uint8Array, engine?: string, threshold?: number }} options
 * @returns {Promise<{ meanDelta: number, changedShare: number, width: number, height: number }>}
 * @exports
 * @ai.hint io
 */
export async function rasterCompare({ before, after, engine = 'auto', threshold = 12 }) {
    const a = await decodeRgba(before, engine);
    const b = await decodeRgba(after, engine);
    const width = Math.min(a.width, b.width);
    const height = Math.min(a.height, b.height);
    if (!width || !height) return { meanDelta: Infinity, changedShare: 1, width, height };

    let sum = 0;
    let changed = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const from = (y * a.width + x) * 4;
            const to = (y * b.width + x) * 4;
            const delta = (Math.abs(a.data[from] - b.data[to])
                + Math.abs(a.data[from + 1] - b.data[to + 1])
                + Math.abs(a.data[from + 2] - b.data[to + 2])) / 3;
            sum += delta;
            if (delta > threshold) changed++;
        }
    }
    const seen = width * height;
    return {
        meanDelta: sum / seen,
        changedShare: changed / seen,
        width,
        height,
    };
}
