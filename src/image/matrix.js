/**
 * @file src/image/matrix.js
 * @module image/matrix
 * @purpose Warp a picture with a projective matrix: 3×3 or 4×4, row major.
 *
 *   The four corners of a screen are one way of saying how a picture is crooked. A matrix is
 *   another, and a stronger one: a corner says where four points go, a matrix says where every
 *   point goes. When the whole picture is turned, squeezed or scaled — not one screen out of a
 *   collage — the corners have nothing to say, and the matrix says it in nine numbers.
 *
 *   The matrix is read as source → destination: it maps the pixels of the source onto the
 *   result. The warp is done with the inverse of that matrix, so every pixel of the output asks
 *   the source where it came from and the source is sampled once, with bilinear weights — the
 *   same honest resampling the projection of a quad uses.
 *
 *   A 4×4 matrix acts on the column (x, y, 0, 1): the third coordinate is zero and the fourth is
 *   one, and the point of the result is (q₀/q₃, q₁/q₃). The 4×4 matrix is therefore the 3×3
 *   homography with the translation in the last column, and the conversion is exact.
 *
 * @depends node:path, node:fs/promises, image/raster, image/skew, image/distort, image/angles
 * @usedBy image/rectify, agent/tools (apply_matrix), stages/rectify
 * @exports parseMatrix, matrixToHomography, invertHomography, matrixRectify
 * @ai.tags images, matrix, homography, warp, decomposer
 * @ai.hint io
 */

import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { decodeRgba, encodeRgba } from './raster.js';
import { measureResidualSkewFromBytes } from './skew.js';
import { applyHomography, warpByHomography } from './distort.js';
import { matrixAngles } from './angles.js';

/**
 * The numbers of a matrix, however they were written.
 *
 * A matrix may arrive as an array of numbers, as an array of rows, as a JSON string or as a
 * string of numbers separated by spaces or commas. Everything that can be read is read; what
 * cannot be read is refused.
 * @param {unknown} value
 * @returns {number[]|null} the flat numbers, or null when the value is not a matrix
 * @ai.hint pure
 */
function matrixNumbers(value) {
    if (Array.isArray(value)) {
        if (value.every((item) => typeof item === 'number' && Number.isFinite(item))) return [...value];
        const flat = [];
        for (const row of value) {
            if (!Array.isArray(row)) return null;
            const numbers = row.map(Number);
            if (!numbers.every((item) => Number.isFinite(item))) return null;
            flat.push(...numbers);
        }
        return flat;
    }
    if (typeof value === 'string') {
        const text = value.trim();
        if (!text) return null;
        if (text.startsWith('[') || text.startsWith('{')) {
            try {
                return matrixNumbers(JSON.parse(text));
            } catch {
                // Not JSON after all: fall through to the plain list of numbers.
            }
        }
        const numbers = text.split(/[\s,;]+/).filter(Boolean).map(Number);
        if (!numbers.length || !numbers.every((item) => Number.isFinite(item))) return null;
        return numbers;
    }
    return null;
}

/**
 * Read a matrix and say how big it is.
 * @param {unknown} value the matrix: 9 or 16 numbers, in rows or flat, as numbers or as a string
 * @returns {{ size: 3|4, values: number[] }}
 * @throws {Error} when the value is not a matrix of 9 or 16 numbers
 * @exports
 * @ai.hint pure
 */
export function parseMatrix(value) {
    const values = matrixNumbers(value);
    if (!values) throw new Error('A matrix needs 9 or 16 numbers.');
    if (values.length !== 9 && values.length !== 16) {
        throw new Error(`A matrix needs 9 or 16 numbers, got ${values.length}.`);
    }
    return { size: values.length === 9 ? 3 : 4, values };
}

/**
 * The homography of a matrix: the 3×3 that maps the same points.
 *
 * A 4×4 matrix acts on (x, y, 0, 1), so the third coordinate of the column is zero and the
 * fourth is one: the result is (q₀/q₃, q₁/q₃), and the same numbers in a 3×3 matrix say exactly
 * the same thing.
 * @param {{ size: number, values: number[] }|unknown} matrix the parsed matrix, or a raw one
 * @returns {number[][]} the 3×3 matrix, row major
 * @exports
 * @ai.hint pure
 */
export function matrixToHomography(matrix) {
    const parsed = matrix && typeof matrix === 'object' && Array.isArray(matrix.values)
        ? matrix
        : parseMatrix(matrix);
    const { size, values } = parsed;
    if (size === 3) {
        return [
            [values[0], values[1], values[2]],
            [values[3], values[4], values[5]],
            [values[6], values[7], values[8]],
        ];
    }
    return [
        [values[0], values[1], values[3]],
        [values[4], values[5], values[7]],
        [values[12], values[13], values[15]],
    ];
}

/**
 * The inverse of a homography.
 * @param {number[][]} h the 3×3 matrix, row major
 * @returns {number[][]} the inverse, row major
 * @throws {Error} when the matrix cannot be inverted
 * @exports
 * @ai.hint pure
 */
export function invertHomography(h) {
    const [[a, b, c], [d, e, f], [g, h2, i]] = h;
    const det = a * (e * i - f * h2) - b * (d * i - f * g) + c * (d * h2 - e * g);
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
        throw new Error('The matrix cannot be inverted.');
    }
    return [
        [(e * i - f * h2) / det, (c * h2 - b * i) / det, (b * f - c * e) / det],
        [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
        [(d * h2 - e * g) / det, (b * g - a * h2) / det, (a * e - b * d) / det],
    ];
}

/**
 * Warp a picture with a matrix and write the result.
 *
 * The frame of the result is the frame the matrix gives the picture: the corners of the source,
 * mapped through the matrix, and the picture framed on what it becomes. A turn therefore leaves
 * the empty corners of the turn transparent, and a scale grows the picture as the matrix says.
 *
 * @param {{ input: string, output: string, matrix: unknown, cwd?: string, signal?: AbortSignal,
 *   outputSize?: {width:number,height:number}|null, measure?: boolean, engine?: string }} options
 * @returns {Promise<{ rel: string, bytes: number, width: number, height: number, engine: string,
 *   matrix: { size: number, values: number[] }, homography: number[][],
 *   source: {width:number,height:number}, angles: object|null, residual: object }>}
 * @exports
 * @ai.hint io
 */
export async function matrixRectify({
    input, output, matrix, cwd = process.cwd(), signal = null,
    outputSize = null, measure = true, engine = 'auto',
}) {
    const inputAbs = path.isAbsolute(input) ? input : path.join(cwd, input);
    const outputAbs = path.isAbsolute(output) ? output : path.join(cwd, output);
    const parsed = parseMatrix(matrix);
    const h = matrixToHomography(parsed);
    const inverse = invertHomography(h);

    const bytes = await readFile(inputAbs);
    signal?.throwIfAborted();
    const source = await decodeRgba(bytes, engine);
    if (!source.width || !source.height) throw new Error(`Cannot read the dimensions of: ${input}`);

    // The frame of the result: the corners of the source, mapped by the matrix. The matrix is
    // read as source → destination, so the picture is framed on what it becomes.
    const corners = [
        { x: 0, y: 0 },
        { x: source.width, y: 0 },
        { x: source.width, y: source.height },
        { x: 0, y: source.height },
    ].map((point) => applyHomography(h, point.x, point.y));
    if (corners.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
        throw new Error('The matrix maps the picture outside of the frame.');
    }
    const xs = corners.map((point) => point.x);
    const ys = corners.map((point) => point.y);
    const origin = { x: Math.min(...xs), y: Math.min(...ys) };
    const width = Math.max(1, Math.round(outputSize?.width || Math.max(...xs) - origin.x));
    const height = Math.max(1, Math.round(outputSize?.height || Math.max(...ys) - origin.y));

    const out = warpByHomography({ source, h: inverse, width, height, origin, signal });
    const png = await encodeRgba(out, engine);
    await mkdir(path.dirname(outputAbs), { recursive: true });
    await writeFile(outputAbs, png);

    // The tilt that is left in the pixels is measured, not guessed: the corners the matrix came
    // with describe the source, and only the result says what the picture looks like now.
    let residual = { angleDeg: 0, confidence: 0, best: 0, flat: 0, measured: false };
    if (measure) {
        try {
            residual = { ...await measureResidualSkewFromBytes(png, { engine }), measured: true };
        } catch {
            // Measurement is a courtesy; the warp already succeeded.
        }
    }

    return {
        rel: output,
        bytes: png.length,
        width,
        height,
        engine: 'local',
        matrix: { size: parsed.size, values: parsed.values },
        homography: h,
        source: { width: source.width, height: source.height },
        angles: matrixAngles(h),
        residual,
    };
}
