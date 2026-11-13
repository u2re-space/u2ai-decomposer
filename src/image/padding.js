/**
 * @file src/image/padding.js
 * @purpose Image padding operations: grow canvas with transparent border.
 * @exports padToSize, removePadding
 * @ai.hint keep
 */
import { rasterPadImageBytes, decodeRgba } from './raster.js';

/**
 * Pad image to target dimensions.
 */
export async function padToSize(bytes, { targetWidth, targetHeight, engine = 'auto' }) {
    return rasterPadImageBytes({ bytes, engine, targetWidth, targetHeight });
}

/**
 * Detect and report padding that can be removed.
 */
export async function detectPadding(bytes, { engine = 'auto' } = {}) {
    const decoded = await decodeRgba(bytes, { engine });
    let top = 0, bottom = 0, left = 0, right = 0;
    // Scan from edges for fully transparent rows/columns.
    for (let y = 0; y < decoded.height; y++) {
        let transparent = true;
        for (let x = 0; x < decoded.width; x++) {
            if (decoded.data[(y * decoded.width + x) * 4 + 3] > 0) { transparent = false; break; }
        }
        if (!transparent) break;
        top = y + 1;
    }
    return { top, bottom, left, right, width: decoded.width, height: decoded.height };
}