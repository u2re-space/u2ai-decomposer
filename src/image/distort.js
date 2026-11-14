/**
 * @file src/image/distort.js
 * @module image/distort
 * @purpose Deterministic geometric rectification: a projective (homography) transform maps the four
 *          corners of a photographed or skewed screen onto an upright rectangle, pixel for pixel.
 *
 *   This exists because the alternative — asking a generation model to "remove the perspective" —
 *   is a draw from a bag. It re-renders the screen, so the text, the palette and the geometry come
 *   back wherever that sampling happened to land, and a screen that lands 3 % off is measured 3 %
 *   off. A homography is not a draw: the same four corners always produce the same rectangle, and
 *   every pixel of the source that survives the warp is the pixel that was already there.
 *
 *   The warp runs in this process: the homography is solved from the four corner pairs and the
 *   output is resampled with an inverse map and bilinear weights. No external program is started
 *   and no shell is involved, so the operation behaves the same on every machine.
 *
 *   The output is never rotated afterwards. A rotation on top of a homography is a second
 *   resampling, and its result is what the next corner guess would have to work from. The residual
 *   tilt of the output is measured instead (`image/skew`), so the caller reads the truth about the
 *   result instead of inferring it from the corners it typed in.
 *
 * @depends node:path, node:fs/promises, image/raster, image/skew
 * @usedBy image/rectify, agent/tools (correct_perspective)
 * @exports perspectiveRectify, quadToRect, solveQuadError, solveHomography, CORNER_ORDER
 * @ai.tags images, perspective, homography, decomposer, rectification
 * @ai.hint io
 * @ai.hint legacy-0.2
 *
 * The homography math and the corner checks come from the monolith (`src/shared/image-distort.js`);
 * the ImageMagick resampling was replaced with a local inverse-map resampler so the decomposer
 * needs no external binary for the rectify stage.
 */

import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { decodeRgba, encodeRgba } from './raster.js';
import { measureResidualSkewFromBytes } from './skew.js';

/**
 * The corner order this module speaks: top-left, top-right, bottom-left, bottom-right.
 * A quad in any other order describes a bow-tie, not a screen.
 */
export const CORNER_ORDER = Object.freeze(['top-left', 'top-right', 'bottom-left', 'bottom-right']);

/**
 * Is a four-point quad usable as a screen outline?
 *
 * The checks are the ones that actually catch a model's bad corner guesses: points far outside the
 * frame, a quad with no area, and a quad whose winding is inverted (which is a bow-tie, not a
 * rectangle seen at an angle). A screen can legitimately extend past the photo edge, so the slack
 * is generous (30 %); the real guard is the area and winding checks.
 *
 * @param {Array<{x:number,y:number}>} quad four points in CORNER_ORDER
 * @param {{ width: number, height: number }} frame the source image size
 * @returns {{ ok: boolean, reason: string }}
 * @exports
 * @ai.hint pure
 */
export function quadToRect(quad, frame) {
    if (!Array.isArray(quad) || quad.length !== 4) return { ok: false, reason: 'exactly four corners are required' };
    for (const point of quad) {
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
            return { ok: false, reason: 'every corner needs numeric x and y' };
        }
    }
    // A photographed screen often runs past the photo edge, so corners outside the frame are normal.
    const slack = 0.30 * Math.max(frame.width, frame.height);
    if (quad.some((p) => p.x < -slack || p.y < -slack || p.x > frame.width + slack || p.y > frame.height + slack)) {
        return { ok: false, reason: `a corner is far outside the ${frame.width}×${frame.height} frame` };
    }
    // Shoelace area: a real quad encloses area, a degenerate one does not.
    const [a, b, c, d] = quad;
    const area = Math.abs(
        (a.x * b.y - b.x * a.y) + (b.x * d.y - d.x * b.y) + (d.x * c.y - c.x * d.y) + (c.x * a.y - a.x * c.y),
    ) / 2;
    const frameArea = frame.width * frame.height;
    if (!(area > 0)) return { ok: false, reason: 'the four corners do not enclose an area' };
    if (area < 0.01 * frameArea) return { ok: false, reason: 'the four corners do not enclose an area' };
    // Winding: top edge must sit above the bottom edge on average, left of right on average.
    const topMid = (a.y + b.y) / 2;
    const bottomMid = (c.y + d.y) / 2;
    const leftMid = (a.x + c.x) / 2;
    const rightMid = (b.x + d.x) / 2;
    if (bottomMid <= topMid) return { ok: false, reason: 'the corners are swapped: the bottom side is above the top one' };
    if (rightMid <= leftMid) return { ok: false, reason: 'the corners are swapped: the right side is left of the left one' };
    return { ok: true, reason: '' };
}

/**
 * How far a quad is from being a rectangle, as the honest confidence number for the sheet.
 *
 * This describes the *source* outline: how far the photographed screen deviated from a rectangle
 * before the warp. It is not a statement about the output, and it must never be used to decide
 * whether the output needs another rotation — the homography has already removed exactly this.
 *
 * @param {Array<{x:number,y:number}>} quad four points in CORNER_ORDER
 * @returns {{ aspectError: number, skewError: number, sizeRatio: number }}
 * @exports
 * @ai.hint pure
 */
export function solveQuadError(quad) {
    const [a, b, c, d] = quad;
    const edge = (p, q) => Math.hypot(q.x - p.x, q.y - p.y);
    const top = edge(a, b);
    const bottom = edge(c, d);
    const left = edge(a, c);
    const right = edge(b, d);
    const widthRatio = Math.max(top, bottom) > 0 ? Math.min(top, bottom) / Math.max(top, bottom) : 0;
    const heightRatio = Math.max(left, right) > 0 ? Math.min(left, right) / Math.max(left, right) : 0;
    const aspectError = 1 - Math.min(widthRatio, heightRatio);
    // Skew: how far the two diagonals disagree with the mid-line lengths of a rectangle.
    const midHorizontal = edge({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 });
    const midVertical = edge({ x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 }, { x: (b.x + d.x) / 2, y: (b.y + d.y) / 2 });
    const skewError = Math.max(midHorizontal, midVertical) > 0
        ? 1 - Math.min(midHorizontal, midVertical) / Math.max(midHorizontal, midVertical)
        : 1;
    const rectArea = Math.max(top, bottom) * Math.max(left, right);
    const [p, q, r, s] = [a, b, d, c];
    const quadArea = Math.abs(
        (p.x * q.y - q.x * p.y) + (q.x * s.y - s.x * q.y) + (s.x * r.y - r.x * s.y) + (r.x * p.y - p.x * r.y),
    ) / 2;
    const sizeRatio = rectArea > 0 ? quadArea / rectArea : 0;
    return {
        aspectError: Number(aspectError.toFixed(4)),
        skewError: Number(skewError.toFixed(4)),
        sizeRatio: Number(sizeRatio.toFixed(4)),
    };
}

/**
 * Solve the 3×3 homography that maps four source points onto four destination points.
 *
 * The eight free parameters are solved from the linear system
 *
 *   u·(h₆x + h₇y + 1) = h₀x + h₁y + h₂
 *   v·(h₆x + h₇y + 1) = h₃x + h₄y + h₅
 *
 * with h₈ pinned to 1, by Gaussian elimination with partial pivoting.
 *
 * @param {Array<{x:number,y:number}>} src four source points
 * @param {Array<{x:number,y:number}>} dst four destination points, same order
 * @returns {number[][]} the 3×3 matrix, row major
 * @exports
 * @ai.hint pure
 */
export function solveHomography(src, dst) {
    const rows = [];
    for (let i = 0; i < 4; i++) {
        const { x, y } = src[i];
        const { x: u, y: v } = dst[i];
        rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
        rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
    }
    // Gaussian elimination with partial pivoting on the 8×9 augmented matrix.
    const size = 8;
    for (let col = 0; col < size; col++) {
        let pivot = col;
        for (let row = col + 1; row < size; row++) {
            if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row;
        }
        if (Math.abs(rows[pivot][col]) < 1e-12) throw new Error('solveHomography: the corners are degenerate.');
        if (pivot !== col) { const tmp = rows[pivot]; rows[pivot] = rows[col]; rows[col] = tmp; }
        const head = rows[col][col];
        for (let k = col; k <= size; k++) rows[col][k] /= head;
        for (let row = 0; row < size; row++) {
            if (row === col) continue;
            const factor = rows[row][col];
            if (!factor) continue;
            for (let k = col; k <= size; k++) rows[row][k] -= factor * rows[col][k];
        }
    }
    const h = rows.map((row) => row[size]);
    return [
        [h[0], h[1], h[2]],
        [h[3], h[4], h[5]],
        [h[6], h[7], 1],
    ];
}

/**
 * Apply a homography to one point.
 * @param {number[][]} h
 * @param {number} x
 * @param {number} y
 * @returns {{ x: number, y: number }}
 * @exports
 * @ai.hint pure
 */
export function applyHomography(h, x, y) {
    const w = h[2][0] * x + h[2][1] * y + h[2][2];
    if (!w) return { x: Number.NaN, y: Number.NaN };
    return {
        x: (h[0][0] * x + h[0][1] * y + h[0][2]) / w,
        y: (h[1][0] * x + h[1][1] * y + h[1][2]) / w,
    };
}

/**
 * Sample one source pixel with bilinear weights.
 * @param {{width:number,height:number,data:Buffer}} frame
 * @param {number} x source column (fractional)
 * @param {number} y source row (fractional)
 * @param {number[]} out four RGBA slots to fill
 * @ai.hint pure
 */
function sampleBilinear(frame, x, y, out) {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const x1 = Math.min(frame.width - 1, x0 + 1);
    const y1 = Math.min(frame.height - 1, y0 + 1);
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
 * Rectify a quadrilateral region of an image into an upright rectangle.
 *
 * The homography is solved from the four corner pairs and the output is resampled with an inverse
 * map, so the picture is sampled exactly once. The output frame is the measured rectangle of the
 * quad, so a screen photographed at an angle comes back at its own proportions rather than the
 * photo's.
 *
 * @param {{ input: string, output: string, quad: Array<{x:number,y:number}>, cwd?: string,
 *   signal?: AbortSignal, outputSize?: {width:number,height:number}|null, measure?: boolean,
 *   engine?: string }} options
 * @returns {Promise<{ rel: string, bytes: number, width: number, height: number,
 *   quadError: object, source: {width:number,height:number}, quadUsed: Array<{x:number,y:number}>,
 *   residual: object }>}
 * @exports
 * @ai.hint io
 */
export async function perspectiveRectify({
    input, output, quad, cwd = process.cwd(), signal = null,
    outputSize = null, measure = true, engine = 'auto',
}) {
    const inputAbs = path.isAbsolute(input) ? input : path.join(cwd, input);
    const outputAbs = path.isAbsolute(output) ? output : path.join(cwd, output);
    const bytes = await readFile(inputAbs);
    signal?.throwIfAborted();

    const source = await decodeRgba(bytes, engine);
    if (!source.width || !source.height) throw new Error(`Cannot read the dimensions of: ${input}`);

    const check = quadToRect(quad, source);
    if (!check.ok) throw new Error(`Invalid quadrilateral: ${check.reason}`);

    const [a, b, c, d] = quad;
    // Destination rectangle: the quad's own measured extent, unless the caller fixed the size.
    const destWidth = Math.max(1, Math.round(outputSize?.width || Math.max(
        Math.hypot(b.x - a.x, b.y - a.y),
        Math.hypot(d.x - c.x, d.y - c.y),
    )));
    const destHeight = Math.max(1, Math.round(outputSize?.height || Math.max(
        Math.hypot(c.x - a.x, c.y - a.y),
        Math.hypot(d.x - b.x, d.y - b.y),
    )));

    // The homography maps the destination rectangle back onto the source quad, so every output
    // pixel can ask the source where it came from.
    const h = solveHomography(
        [{ x: 0, y: 0 }, { x: destWidth, y: 0 }, { x: 0, y: destHeight }, { x: destWidth, y: destHeight }],
        [{ x: a.x, y: a.y }, { x: b.x, y: b.y }, { x: c.x, y: c.y }, { x: d.x, y: d.y }],
    );

    const out = { width: destWidth, height: destHeight, channels: 4, data: Buffer.alloc(destWidth * destHeight * 4) };
    const pixel = [0, 0, 0, 0];
    for (let y = 0; y < destHeight; y++) {
        signal?.throwIfAborted();
        for (let x = 0; x < destWidth; x++) {
            const at = (y * destWidth + x) * 4;
            const point = applyHomography(h, x, y);
            if (!Number.isFinite(point.x) || !Number.isFinite(point.y)
                || point.x < -0.5 || point.y < -0.5
                || point.x > source.width - 0.5 || point.y > source.height - 0.5) {
                // Outside the source: transparent, the same way ImageMagick's transparent virtual
                // pixel behaved — the caller sees what the quad did not cover.
                continue;
            }
            sampleBilinear(source, point.x, point.y, pixel);
            out.data[at] = pixel[0];
            out.data[at + 1] = pixel[1];
            out.data[at + 2] = pixel[2];
            out.data[at + 3] = pixel[3];
        }
    }

    const png = await encodeRgba(out, engine);
    await mkdir(path.dirname(outputAbs), { recursive: true });
    await writeFile(outputAbs, png);

    // Measure the result so the caller reads the truth about the output instead of reasoning about
    // the corners it typed in. Report-only: this module never rotates the picture.
    let residual = { angleDeg: 0, confidence: 0, best: 0, flat: 0, measured: false };
    if (measure) {
        try {
            residual = { ...await measureResidualSkewFromBytes(png, { engine }), measured: true };
        } catch {
            // Measurement is a courtesy; the rectification already succeeded.
        }
    }

    return {
        rel: output,
        bytes: png.length,
        width: destWidth,
        height: destHeight,
        engine: 'local',
        quadError: solveQuadError(quad),
        source: { width: source.width, height: source.height },
        quadUsed: quad,
        residual,
    };
}
