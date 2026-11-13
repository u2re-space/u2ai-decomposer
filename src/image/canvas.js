/**
 * @file src/image/canvas.js
 * @purpose Canvas abstraction: node-canvas wrapper for compositing.
 * @exports createCanvas, loadImage
 * @ai.hint keep
 */

/** @type {object|null} */
let _canvas = null;

async function load() {
    if (_canvas === null) {
        try { _canvas = await import('canvas'); }
        catch { _canvas = false; }
    }
    return _canvas || null;
}

/**
 * Create a canvas of given size.
 * @param {number} width
 * @param {number} height
 * @returns {Promise<object|null>}
 */
export async function createCanvas(width, height) {
    const c = await load();
    return c?.createCanvas?.(width, height) ?? null;
}

/**
 * Load an image from file path or buffer.
 * @param {string|Buffer} source
 * @returns {Promise<object|null>}
 */
export async function loadImage(source) {
    const c = await load();
    if (!c?.loadImage) return null;
    return c.loadImage(source);
}