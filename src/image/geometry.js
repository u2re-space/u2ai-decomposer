/**
 * @file src/image/geometry.js
 * @module image/geometry
 * @purpose The geometry correction of a restored screen: a small rotation and a small size
 *          correction, applied to the pixels without redrawing them.
 *
 *   The correction is not a drawing: the picture is resampled once, with an inverse map and
 *   bilinear weights, so every pixel of the result is a pixel that was already in the source.
 *   A generation model asked to "straighten this by three degrees" returns a new picture that
 *   happens to look straighter — and a new set of glyphs. The measurer then reads that drawing.
 *   So the numbers come from the role (it is the only one that can see the tilt), and the pixels
 *   are moved here.
 *
 *   The canvas grows to the bounding box of the corrected picture, so no content is cropped away:
 *   a screen that is straightened keeps every row it had. The wedges that a rotation opens at the
 *   corners are filled with the pixels of the nearest edge — the same surface the screen shows
 *   there — rather than with a black frame.
 *
 * @depends node:path, node:fs/promises, image/raster, image/skew
 * @usedBy stages/reconstruct
 * @exports applyGeometry
 * @ai.tags images, geometry, rotation, scale, restoration
 * @ai.hint io
 */

import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { decodeRgba, encodeRgba } from './raster.js';
import { measureResidualSkewFromBytes } from './skew.js';

const radians = (deg) => (deg * Math.PI) / 180;

/**
 * Sample one source pixel with bilinear weights, clamping to the edges of the frame.
 *
 * The clamp is what fills the wedge a rotation opens: the sample is taken from the nearest pixel
 * that exists, so the border of the screen continues into the corner instead of a black gap.
 * @param {{width:number,height:number,data:Buffer}} frame
 * @param {number} x source column (fractional)
 * @param {number} y source row (fractional)
 * @param {number[]} out four RGBA slots to fill
 * @ai.hint pure
 */
function sampleClamped(frame, x, y, out) {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    // The neighbours are clamped on both sides: a sample outside the frame reads the edge pixel,
    // and an index below zero would read nothing at all.
    const x1 = Math.max(0, Math.min(frame.width - 1, x0 + 1));
    const y1 = Math.max(0, Math.min(frame.height - 1, y0 + 1));
    const cx0 = Math.min(frame.width - 1, Math.max(0, x0));
    const cy0 = Math.min(frame.height - 1, Math.max(0, y0));
    for (let c = 0; c < 4; c++) {
        const p00 = frame.data[(cy0 * frame.width + cx0) * 4 + c];
        const p10 = frame.data[(cy0 * frame.width + x1) * 4 + c];
        const p01 = frame.data[(y1 * frame.width + cx0) * 4 + c];
        const p11 = frame.data[(y1 * frame.width + x1) * 4 + c];
        const top = p00 + (p10 - p00) * fx;
        const bottom = p01 + (p11 - p01) * fx;
        out[c] = Math.round(top + (bottom - top) * fy);
    }
}

/**
 * Apply a rotation and a size correction to a picture.
 *
 * `rotateDeg` is the tilt of the content, in the convention of `image/skew`: positive means the
 * content runs downhill to the right, and the picture is turned back by that amount. `scalePercent`
 * is the size of the content relative to the truth: 3 means the content is 3 % too small and has to
 * grow by that much, -3 means it is 3 % too large. Both corrections are applied about the centre of
 * the picture, and the canvas grows to whatever they need — nothing is cropped away.
 *
 * The tilt that is left in the result is measured before and after, so the caller reads the truth
 * about the correction instead of trusting the number it asked for.
 * @param {{ input: string, output: string, rotateDeg?: number, scalePercent?: number,
 *   cwd?: string, signal?: AbortSignal, engine?: string }} options
 * @returns {Promise<{ rel: string, bytes: number, width: number, height: number,
 *   rotateDeg: number, scalePercent: number, residualBefore: object, residualAfter: object }>}
 * @exports
 * @ai.hint io
 */
export async function applyGeometry({
    input, output, rotateDeg = 0, scalePercent = 0, cwd = process.cwd(), signal = null, engine = 'auto',
}) {
    const inputAbs = path.isAbsolute(input) ? input : path.join(cwd, input);
    const outputAbs = path.isAbsolute(output) ? output : path.join(cwd, output);
    const bytes = await readFile(inputAbs);
    signal?.throwIfAborted();
    const source = await decodeRgba(bytes, engine);
    if (!source.width || !source.height) throw new Error(`Cannot read the dimensions of: ${input}`);

    // The tilt is removed, so the picture is turned the other way.
    const theta = radians(-(Number(rotateDeg) || 0));
    const scale = 1 + (Number(scalePercent) || 0) / 100;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const halfW = source.width / 2;
    const halfH = source.height / 2;

    // The four corners of the content after the correction, in the space of the result.
    const corners = [[0, 0], [source.width, 0], [source.width, source.height], [0, source.height]]
        .map(([x, y]) => {
            const cx = x - halfW;
            const cy = y - halfH;
            return [(cx * cos - cy * sin) * scale, (cx * sin + cy * cos) * scale];
        });
    const xs = corners.map((point) => point[0]);
    const ys = corners.map((point) => point[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const outWidth = Math.max(1, Math.round(maxX - minX));
    const outHeight = Math.max(1, Math.round(maxY - minY));

    const out = { width: outWidth, height: outHeight, channels: 4, data: Buffer.alloc(outWidth * outHeight * 4) };
    const pixel = [0, 0, 0, 0];
    for (let y = 0; y < outHeight; y++) {
        signal?.throwIfAborted();
        for (let x = 0; x < outWidth; x++) {
            // The result pixel, in the space of the corrected content.
            const mx = x + 0.5 - outWidth / 2;
            const my = y + 0.5 - outHeight / 2;
            // Undo the scale and the rotation to find the source pixel.
            const ux = mx / scale;
            const uy = my / scale;
            const sx = ux * cos + uy * sin + halfW;
            const sy = -ux * sin + uy * cos + halfH;
            sampleClamped(source, sx - 0.5, sy - 0.5, pixel);
            const at = (y * outWidth + x) * 4;
            out.data[at] = pixel[0];
            out.data[at + 1] = pixel[1];
            out.data[at + 2] = pixel[2];
            out.data[at + 3] = pixel[3];
        }
    }

    const png = await encodeRgba(out, engine);
    await mkdir(path.dirname(outputAbs), { recursive: true });
    await writeFile(outputAbs, png);

    let residualBefore = { angleDeg: 0, confidence: 0, measured: false };
    let residualAfter = { angleDeg: 0, confidence: 0, measured: false };
    try {
        residualBefore = { ...await measureResidualSkewFromBytes(bytes, { engine }), measured: true };
        residualAfter = { ...await measureResidualSkewFromBytes(png, { engine }), measured: true };
    } catch {
        // The measurement is a courtesy: the correction itself already succeeded.
    }

    return {
        rel: output,
        bytes: png.length,
        width: outWidth,
        height: outHeight,
        rotateDeg: Number(rotateDeg) || 0,
        scalePercent: Number(scalePercent) || 0,
        residualBefore,
        residualAfter,
    };
}
