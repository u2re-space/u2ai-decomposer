/**
 * @file src/image/padding.js
 * @module image/padding
 * @purpose Grow a canvas with a transparent band and measure the padding that can be taken off.
 *
 *   The extension stage works by making the canvas bigger and asking the model to draw only into
 *   the empty part. The band has to be transparent rather than white: the model has to see that
 *   there is nothing there yet, and a white band is a picture the model tries to continue.
 *
 * @depends image/raster
 * @usedBy stages/extension
 * @exports padToSize, padBand, detectPadding, removePadding
 * @ai.tags image, padding, canvas, band
 * @ai.hint io
 */

import { decodeRgba, encodeRgba, rasterPadImageBytes, rasterRemoveImagePadding } from './raster.js';

/**
 * Pad a picture to the target size with a transparent band on the right and the bottom.
 *
 * @param {Buffer} bytes
 * @param {{ targetWidth?: number|null, targetHeight?: number|null, engine?: string }} [options]
 * @returns {Promise<{ bytes: Buffer, width: number, height: number, originalWidth: number,
 *   originalHeight: number, padded: boolean }>}
 * @exports
 * @ai.hint io
 */
export async function padToSize(bytes, { targetWidth = null, targetHeight = null, engine = 'auto' } = {}) {
    return await rasterPadImageBytes({ bytes, engine, targetWidth, targetHeight });
}

/**
 * Grow the canvas by a fraction of its long side, with a transparent band all around.
 *
 * @param {Buffer} bytes
 * @param {{ fraction?: number, engine?: string, alphaThreshold?: number }} [options]
 *   `fraction` is a share of the long side; 0.125 adds an eighth-frame around the art.
 * @returns {Promise<{ bytes: Buffer, width: number, height: number, band: number }>}
 * @exports
 * @ai.hint io
 */
export async function padBand(bytes, { fraction = 0.125, engine = 'auto', alphaThreshold = 0.05 } = {}) {
    const frame = await decodeRgba(bytes, engine);
    const band = Math.max(1, Math.round(Math.max(frame.width, frame.height) * Math.max(0, fraction)));
    const width = frame.width + band * 2;
    const height = frame.height + band * 2;
    const data = Buffer.alloc(width * height * 4);
    for (let row = 0; row < frame.height; row++) {
        frame.data.copy(
            data,
            ((row + band) * width + band) * 4,
            row * frame.width * 4,
            (row + 1) * frame.width * 4,
        );
    }
    return { bytes: await encodeRgba({ width, height, data }, engine), width, height, band };
}

/**
 * Measure the transparent border of a picture.
 *
 * @param {Buffer} bytes
 * @param {{ engine?: string, alphaThreshold?: number }} [options]
 * @returns {Promise<{ top: number, bottom: number, left: number, right: number,
 *   width: number, height: number }>}
 * @exports
 * @ai.hint io
 */
export async function detectPadding(bytes, { engine = 'auto', alphaThreshold = 0.05 } = {}) {
    const decoded = await decodeRgba(bytes, engine);
    const cut = Math.max(1, Math.round(decoded.width * Math.max(0, Math.min(1, alphaThreshold)) * 255));
    const transparentRow = (y) => {
        for (let x = 0; x < decoded.width; x++) {
            if (decoded.data[(y * decoded.width + x) * 4 + 3] > cut) return false;
        }
        return true;
    };
    const transparentColumn = (x) => {
        for (let y = 0; y < decoded.height; y++) {
            if (decoded.data[(y * decoded.width + x) * 4 + 3] > cut) return false;
        }
        return true;
    };
    let top = 0;
    while (top < decoded.height && transparentRow(top)) top++;
    let bottom = 0;
    while (bottom < decoded.height - top && transparentRow(decoded.height - 1 - bottom)) bottom++;
    let left = 0;
    while (left < decoded.width && transparentColumn(left)) left++;
    let right = 0;
    while (right < decoded.width - left && transparentColumn(decoded.width - 1 - right)) right++;
    return { top, bottom, left, right, width: decoded.width, height: decoded.height };
}

/**
 * Cut the known padding off a padded picture.
 *
 * @param {Buffer} bytes
 * @param {{ width: number, height: number, originalWidth: number, originalHeight: number,
 *   engine?: string, normalized?: boolean }} options
 * @returns {Promise<Buffer>}
 * @exports
 * @ai.hint io
 */
export async function removePadding(bytes, { width, height, originalWidth, originalHeight, engine = 'auto', normalized = false }) {
    return await rasterRemoveImagePadding({ bytes, width, height, originalWidth, originalHeight, engine, normalized });
}
