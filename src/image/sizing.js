/**
 * @file src/image/sizing.js
 * @module image/sizing
 * @purpose Output sizes and the downscale of the copies that go to the model.
 *
 *   The picture the pipeline works on and the picture the model sees are two different files. The
 *   pipeline keeps the original pixels; the model gets a copy that fits into the frame it accepts,
 *   because a 6000-pixel screenshot costs a fortune to send and buys nothing.
 *
 * @depends image/raster
 * @usedBy stages, agent/tools
 * @exports computeSize, fitBox, downscaleToMaxSide, NAMED_FRAMES
 * @ai.tags image, size, downscale, megapixels
 * @ai.hint io
 */

import { decodeRgba, encodeRgba, rasterScale } from './raster.js';

/** Named frames the pipeline can ask for. */
export const NAMED_FRAMES = {
    square: [1024, 1024],
    landscape: [1536, 1024],
    portrait: [1024, 1536],
    wide: [1920, 1080],
    tall: [1080, 1920],
};

/**
 * Compute the best output size for a given aspect and resolution.
 *
 * @param {string} aspect like "16:9"
 * @param {string} resolution like "1k", "2k"
 * @returns {{ width: number, height: number }}
 * @exports
 * @ai.hint pure
 */
export function computeSize(aspect = '1:1', resolution = '1k') {
    const [w, h] = aspect.split(':').map(Number);
    const base = resolution === '2k' ? 2048 : 1024;
    const ratio = w / h;
    if (ratio >= 1) return { width: base, height: Math.round(base / ratio) };
    return { width: Math.round(base * ratio), height: base };
}

/**
 * Fit a box within max dimensions, preserving aspect.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} maxW
 * @param {number} maxH
 * @returns {{ width: number, height: number }}
 * @exports
 * @ai.hint pure
 */
export function fitBox(width, height, maxW, maxH) {
    const scale = Math.min(maxW / width, maxH / height, 1);
    return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/**
 * Shrink a picture to the copy that goes to the model.
 *
 * The long side is capped at `maxSide`, and the decoded frame is refused when it is larger than
 * `maxMegapixels` — a decompression bomb is a real failure mode for a tool that reads whatever
 * file the user points it at, and refusing is cheaper than decoding it.
 *
 * @param {Buffer} bytes the original picture
 * @param {{ maxSide?: number|null, maxMegapixels?: number|null, engine?: string }} [options]
 * @returns {Promise<{ bytes: Buffer, width: number, height: number, scaled: boolean,
 *   originalWidth: number, originalHeight: number }>}
 * @exports
 * @ai.hint io
 */
export async function downscaleToMaxSide(bytes, { maxSide = null, maxMegapixels = null, engine = 'auto' } = {}) {
    const frame = await decodeRgba(bytes, engine);
    const originalWidth = frame.width;
    const originalHeight = frame.height;

    if (maxMegapixels && frame.width * frame.height > maxMegapixels * 1_000_000) {
        throw new Error(`The picture is ${(frame.width * frame.height / 1_000_000).toFixed(1)} MP, above the ${maxMegapixels} MP cap.`);
    }

    const target = maxSide ? fitBox(frame.width, frame.height, maxSide, maxSide) : { width: frame.width, height: frame.height };
    if (target.width === frame.width && target.height === frame.height) {
        return { bytes, width: frame.width, height: frame.height, scaled: false, originalWidth, originalHeight };
    }
    const scaled = await rasterScale(frame, target.width, target.height, engine);
    return {
        bytes: await encodeRgba(scaled, engine),
        width: scaled.width,
        height: scaled.height,
        scaled: true,
        originalWidth,
        originalHeight,
    };
}
