/**
 * @file src/image/canvas.js
 * @module image/canvas
 * @purpose The node-canvas engine: the local raster fallback that works without native sharp.
 *
 *   node-canvas is the second engine of the chain (sharp is the first). It draws and encodes
 *   pictures in process, so a machine without the sharp binary can still crop, patch, pad and
 *   encode. The module is loaded once and cached: the import itself is the expensive part.
 *
 * @depends node:fs/promises
 * @usedBy image/raster
 * @exports canvasLib, createCanvas, loadImage, canvasAvailable
 * @ai.tags canvas, image, engine, fallback
 * @ai.hint io
 * @ai.hint legacy-0.2
 */

/** Cached module handle. null = not tried yet, false = unavailable, object = the module. */
let _canvas = null;

/**
 * Load node-canvas once, or null when the native build is missing.
 *
 * @returns {Promise<object|null>}
 * @exports
 * @ai.hint io
 */
export async function canvasLib() {
    if (_canvas === null) {
        try { _canvas = await import('canvas'); }
        catch { _canvas = false; }
    }
    return _canvas || null;
}

/**
 * Whether the canvas engine is usable in this process.
 *
 * @returns {Promise<boolean>}
 * @exports
 * @ai.hint io
 */
export async function canvasAvailable() {
    return Boolean(await canvasLib());
}

/**
 * Create a canvas of the given size.
 *
 * @param {number} width
 * @param {number} height
 * @returns {Promise<object|null>}
 * @exports
 * @ai.hint io
 */
export async function createCanvas(width, height) {
    const c = await canvasLib();
    return c?.createCanvas?.(width, height) ?? null;
}

/**
 * Load an image from a file path or a buffer.
 *
 * @param {string|Buffer} source
 * @returns {Promise<object|null>}
 * @exports
 * @ai.hint io
 */
export async function loadImage(source) {
    const c = await canvasLib();
    if (!c?.loadImage) return null;
    return c.loadImage(source);
}
