/**
 * @file src/image/crop.js
 * @module image/crop
 * @purpose Rect crops with the rectangle clamped to the frame.
 *
 *   The crop boxes in the pipeline come from a model that looked at a picture, so they are close
 *   but not exact: a box may hang over the edge, or start outside the frame. Clamping here means
 *   one bad coordinate produces a smaller crop instead of a failed operation.
 *
 * @depends node:fs/promises, image/raster
 * @usedBy agent/tools (crop_image), stages
 * @exports clampRect, cropRect, cropToBuffer, cropToFile
 * @ai.tags image, crop, rect, clamp
 * @ai.hint io
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { rasterCrop, rasterInfo } from './raster.js';

/**
 * Clamp a rectangle to the frame it is cut from.
 *
 * The origin is pulled inside the frame and the size is cut down to what is left, so the result is
 * always a rectangle that lies on the picture.
 *
 * @param {{ x?: number, y?: number, width?: number, height?: number }} rect
 * @param {{ width: number, height: number }} frame
 * @returns {{ x: number, y: number, width: number, height: number }}
 * @exports
 * @ai.hint pure
 */
export function clampRect(rect, frame) {
    const x = Math.max(0, Math.min(Math.round(rect.x ?? 0), Math.max(0, frame.width - 1)));
    const y = Math.max(0, Math.min(Math.round(rect.y ?? 0), Math.max(0, frame.height - 1)));
    const width = Math.max(1, Math.min(Math.round(rect.width ?? frame.width), frame.width - x));
    const height = Math.max(1, Math.min(Math.round(rect.height ?? frame.height), frame.height - y));
    return { x, y, width, height };
}

/**
 * Crop a rectangle of a picture, clamped to the frame.
 *
 * @param {{ input: string, output: string, rect: object, cwd?: string, engine?: string,
 *   signal?: AbortSignal }} options
 * @returns {Promise<{ rel: string, bytes: number, width: number, height: number,
 *   box: {x:number,y:number,width:number,height:number} }>}
 * @exports
 * @ai.hint io
 */
export async function cropRect({ input, output, rect, cwd = process.cwd(), engine = 'auto', signal = null }) {
    const info = await rasterInfo(input, { cwd, engine });
    const box = clampRect(rect, info);
    const result = await rasterCrop({ input, output, ...box, cwd, signal, engine });
    return { ...result, box };
}

/**
 * Crop a region and return the bytes instead of writing a file.
 *
 * @param {string} input path of the picture
 * @param {{ x: number, y: number, width: number, height: number, engine?: string }} rect
 * @returns {Promise<Buffer>}
 * @exports
 * @ai.hint io
 */
export async function cropToBuffer(input, { x, y, width, height, engine = 'auto' }) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-crop-'));
    const file = path.join(dir, 'crop.png');
    try {
        await rasterCrop({ input, output: file, x, y, width, height, engine });
        return await readFile(file);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

/**
 * Crop a region and write it to a file.
 *
 * @param {{ input: string, output: string, x?: number, y?: number, width?: number,
 *   height?: number, cwd?: string, engine?: string }} options
 * @returns {Promise<object>}
 * @exports
 * @ai.hint io
 */
export async function cropToFile(options) {
    return await rasterCrop(options);
}
