/**
 * @file src/image/crop.js
 * @purpose Crop operations: extract regions from images.
 * @exports cropToBuffer, cropToFile
 * @ai.hint keep
 */
import { rasterCrop } from './raster.js';

export async function cropToBuffer(input, { x, y, width, height, engine = 'auto' }) {
    const { writeFile, readFile, unlink } = await import('node:fs/promises');
    const path = await import('node:path');
    const os = await import('node:os');
    const tmp = path.join(os.tmpdir(), `crop-${Date.now()}.png`);
    await rasterCrop({ input, output: tmp, x, y, width, height, engine });
    const buf = await readFile(tmp);
    await unlink(tmp).catch(() => {});
    return buf;
}

export async function cropToFile(opts) {
    return rasterCrop(opts);
}