/**
 * @file src/image/sizing.js
 * @purpose Image size calculation: presets, aspect ratios, model floors.
 * @exports computeSize, fitBox, NAMED_FRAMES
 * @ai.hint keep
 */

export const NAMED_FRAMES = {
    square: [1024, 1024],
    landscape: [1536, 1024],
    portrait: [1024, 1536],
    wide: [1920, 1080],
    tall: [1080, 1920],
};

/**
 * Compute the best output size for a given aspect and resolution.
 * @param {string} aspect like "16:9"
 * @param {string} resolution like "1k", "2k"
 * @returns {{ width: number, height: number }}
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
 * @param {number} width
 * @param {number} height
 * @param {number} maxW
 * @param {number} maxH
 * @returns {{ width: number, height: number }}
 */
export function fitBox(width, height, maxW, maxH) {
    const scale = Math.min(maxW / width, maxH / height, 1);
    return { width: Math.round(width * scale), height: Math.round(height * scale) };
}