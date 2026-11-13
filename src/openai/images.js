/**
 * @file src/openai/images.js
 * @purpose Image generation/editing helpers: size resolution, padding, format.
 * @exports IMAGE_SIZES, paddedSizeToMinPixels, sniffImage, imageModelFor
 * @ai.hint keep
 */

/** Known image size presets. */
export const IMAGE_SIZES = ['1024x1024', '1024x1536', '1536x1024', '512x512', '256x256'];

/**
 * Compute the padded target size to meet the model's minimum pixel floor.
 * @param {{ width: number, height: number }} size
 * @param {string|null} model
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
 * Detect image format from bytes.
 * @param {Buffer} bytes
 * @returns {{ mime: string, ext: string }}
 */
export function sniffImage(bytes) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return { mime: 'image/png', ext: '.png' };
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return { mime: 'image/jpeg', ext: '.jpg' };
    if (bytes.subarray(0, 4).toString('latin1') === 'RIFF') return { mime: 'image/webp', ext: '.webp' };
    if (bytes.subarray(0, 6).toString('latin1') === 'GIF89a' || bytes.subarray(0, 6).toString('latin1') === 'GIF87a') return { mime: 'image/gif', ext: '.gif' };
    return { mime: 'image/png', ext: '.png' };
}

/**
 * Resolve the image editing/generation model from config.
 * @param {object} config
 * @param {{ hasImage?: boolean }} [opts]
 * @returns {string|null}
 */
export function imageModelFor(config, { hasImage = false } = {}) {
    if (config?.imageModel) return config.imageModel;
    if (hasImage && config?.model) return config.model;
    return null;
}