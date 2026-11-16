/**
 * @file test/matrix.test.js
 * @module test/matrix
 * @purpose Tests of the angles in degrees and of the projective matrix: the numbers the rectifier
 *          reads, the matrix it is given and the warp the harness runs on it.
 * @depends node:test, image/angles, image/matrix, image/distort
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import sharp from 'sharp';

import { matrixAngles, quadAngles } from '../src/image/angles.js';
import {
    invertHomography, matrixRectify, matrixToHomography, parseMatrix,
} from '../src/image/matrix.js';
import { applyHomography } from '../src/image/distort.js';

// ---------------------------------------------------------------------------
// The angles of a quad
// ---------------------------------------------------------------------------

/** The corners of a rectangle turned by the given angle, clockwise. */
const turnedQuad = (deg) => {
    const rad = (deg * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    return [
        { x: 0, y: 0 },
        { x: 100 * c, y: 100 * s },
        { x: -100 * s, y: 100 * c },
        { x: 100 * c - 100 * s, y: 100 * s + 100 * c },
    ];
};

test('a rectangle that is not turned has no angles', () => {
    const angles = quadAngles([
        { x: 10, y: 20 }, { x: 110, y: 20 }, { x: 10, y: 120 }, { x: 110, y: 120 },
    ]);
    assert.equal(angles.rotation, 0);
    assert.equal(angles.skew, 0);
    assert.equal(angles.keystone, 0);
});

test('the turn of a picture is read in degrees', () => {
    const angles = quadAngles(turnedQuad(10));
    assert.ok(Math.abs(angles.rotation - 10) < 0.01, `the rotation is ${angles.rotation}°`);
    assert.ok(Math.abs(angles.skew) < 0.01, `the skew is ${angles.skew}°`);
    assert.ok(Math.abs(angles.keystone) < 0.01, `the keystone is ${angles.keystone}°`);
    assert.ok(Math.abs(angles.top - 10) < 0.01, `the top edge is ${angles.top}°`);
});

test('the shear of a picture is the disagreement of its horizontal edges', () => {
    const rad = (deg) => (deg * Math.PI) / 180;
    const top = { x: 100 * Math.cos(rad(10)), y: 100 * Math.sin(rad(10)) };
    const bottom = { x: 100 * Math.cos(rad(4)), y: 100 * Math.sin(rad(4)) };
    const angles = quadAngles([
        { x: 0, y: 0 },
        top,
        { x: 0, y: 100 },
        { x: bottom.x, y: 100 + bottom.y },
    ]);
    assert.ok(Math.abs(angles.skew - 6) < 0.01, `the skew is ${angles.skew}°`);
    assert.ok(Math.abs(angles.rotation - 7) < 0.01, `the rotation is ${angles.rotation}°`);
});

test('the squeeze of the perspective is the disagreement of its vertical edges', () => {
    const angles = quadAngles([
        { x: 20, y: 0 }, { x: 80, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 },
    ]);
    assert.equal(angles.rotation, 0, 'a keystone does not turn the picture');
    assert.ok(Math.abs(angles.keystone - 22.62) < 0.1, `the keystone is ${angles.keystone}°`);
});

test('a quad that cannot be read has no angles', () => {
    assert.equal(quadAngles(null), null);
    assert.equal(quadAngles([{ x: 1, y: 1 }]), null);
    assert.equal(quadAngles([{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }, { x: 'x', y: 4 }]), null);
});

// ---------------------------------------------------------------------------
// The angles of a matrix
// ---------------------------------------------------------------------------

test('the turn of a matrix is read in degrees', () => {
    const rad = (10 * Math.PI) / 180;
    const angles = matrixAngles([
        Math.cos(rad), -Math.sin(rad), 0,
        Math.sin(rad), Math.cos(rad), 0,
        0, 0, 1,
    ]);
    assert.ok(Math.abs(angles.rotation - 10) < 0.01, `the rotation is ${angles.rotation}°`);
    assert.ok(Math.abs(angles.skew) < 0.01, `the skew is ${angles.skew}°`);
    assert.ok(Math.abs(angles.scaleX - 1) < 0.001);
    assert.ok(Math.abs(angles.scaleY - 1) < 0.001);
});

test('the shear of a matrix is the angle its axes lost', () => {
    const angles = matrixAngles([1, 0.5, 0, 0, 1, 0, 0, 0, 1]);
    assert.equal(angles.rotation, 0);
    assert.ok(Math.abs(angles.skew - 26.57) < 0.05, `the skew is ${angles.skew}°`);
});

test('a matrix that cannot be read has no angles', () => {
    assert.equal(matrixAngles(null), null);
    assert.equal(matrixAngles([1, 2, 3]), null);
    assert.equal(matrixAngles([0, 0, 0, 0, 0, 0, 0, 0, 0]), null);
});

// ---------------------------------------------------------------------------
// The matrix itself
// ---------------------------------------------------------------------------

test('a matrix is read in every shape it arrives in', () => {
    const flat = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    assert.deepEqual(parseMatrix(flat), { size: 3, values: flat });
    assert.deepEqual(parseMatrix([[1, 0, 0], [0, 1, 0], [0, 0, 1]]), { size: 3, values: flat });
    assert.deepEqual(parseMatrix('[1,0,0,0,1,0,0,0,1]'), { size: 3, values: flat });
    assert.deepEqual(parseMatrix('1 0 0 0 1 0 0 0 1'), { size: 3, values: flat });
    assert.deepEqual(parseMatrix('1, 0, 0; 0, 1, 0; 0, 0, 1'), { size: 3, values: flat });
    const sixteen = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    assert.deepEqual(parseMatrix(sixteen), { size: 4, values: sixteen });
});

test('a matrix that is not a matrix is refused', () => {
    assert.throws(() => parseMatrix('nonsense'), /9 or 16 numbers/);
    assert.throws(() => parseMatrix([1, 0, 0, 0, 1, 0, 0, 0]), /9 or 16 numbers/);
    assert.throws(() => parseMatrix(null), /9 or 16 numbers/);
});

test('a 4x4 matrix acts on (x, y, 0, 1)', () => {
    const h = matrixToHomography([1, 0, 0, 10, 0, 1, 0, 20, 0, 0, 1, 0, 0, 0, 0, 1]);
    const point = applyHomography(h, 5, 7);
    assert.equal(point.x, 15, 'the translation of the last column moves the point');
    assert.equal(point.y, 27);
});

test('a 3x3 matrix is its own homography', () => {
    const h = matrixToHomography([2, 0, 0, 0, 2, 0, 0, 0, 1]);
    assert.deepEqual(h, [[2, 0, 0], [0, 2, 0], [0, 0, 1]]);
});

test('the inverse of a matrix undoes it', () => {
    const h = [[2, 0.5, 10], [0.3, 1.5, 20], [0.001, 0.002, 1]];
    const inverse = invertHomography(h);
    const point = applyHomography(inverse, ...Object.values(applyHomography(h, 12, 9)));
    assert.ok(Math.abs(point.x - 12) < 1e-6, `the point came back as ${point.x}`);
    assert.ok(Math.abs(point.y - 9) < 1e-6, `the point came back as ${point.y}`);
    assert.throws(() => invertHomography([[0, 0, 0], [0, 0, 0], [0, 0, 0]]), /cannot be inverted/);
});

// ---------------------------------------------------------------------------
// The warp
// ---------------------------------------------------------------------------

/** A picture of horizontal stripes: the shape the skew measurement reads the tilt from. */
const stripes = async (width = 200, height = 150) => {
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        const on = Math.floor(y / 8) % 2 === 0;
        for (let x = 0; x < width; x++) {
            const at = (y * width + x) * 4;
            data[at] = on ? 240 : 20;
            data[at + 1] = on ? 240 : 20;
            data[at + 2] = on ? 240 : 20;
            data[at + 3] = 255;
        }
    }
    return await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
};

test('a matrix turns the picture and the result says by how much', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-matrix-'));
    try {
        const source = path.join(root, 'source.png');
        await sharp(await stripes()).toFile(source);
        const rad = (5 * Math.PI) / 180;
        const output = path.join(root, 'warped.png');
        const result = await matrixRectify({
            input: source,
            output,
            matrix: [
                Math.cos(rad), -Math.sin(rad), 0,
                Math.sin(rad), Math.cos(rad), 0,
                0, 0, 1,
            ],
            cwd: root,
            engine: 'sharp',
        });
        assert.equal(result.matrix.size, 3);
        assert.ok(result.width > 200 && result.height > 150, 'the turn opens the frame');
        assert.ok(Math.abs(result.angles.rotation - 5) < 0.01, `the turn is ${result.angles.rotation}°`);
        assert.ok(Math.abs(result.residual.angleDeg - 5) < 1,
            `the tilt left in the pixels is ${result.residual.angleDeg}°`);
        const meta = await sharp(output).metadata();
        assert.deepEqual([meta.width, meta.height], [result.width, result.height]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a matrix scales the picture and keeps its pixels', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-matrix-'));
    try {
        const source = path.join(root, 'source.png');
        await sharp(await stripes(100, 80)).toFile(source);
        const result = await matrixRectify({
            input: source,
            output: path.join(root, 'scaled.png'),
            matrix: [2, 0, 0, 0, 2, 0, 0, 0, 1],
            cwd: root,
            engine: 'sharp',
        });
        assert.deepEqual([result.width, result.height], [200, 160]);
        assert.ok(Math.abs(result.angles.scaleX - 2) < 0.001);
        assert.ok(Math.abs(result.residual.angleDeg) < 0.5, 'a level picture stays level');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a matrix that cannot be used is refused', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-matrix-'));
    try {
        const source = path.join(root, 'source.png');
        await sharp(await stripes()).toFile(source);
        await assert.rejects(() => matrixRectify({
            input: source,
            output: path.join(root, 'bad.png'),
            matrix: [1, 2, 3],
            cwd: root,
            engine: 'sharp',
        }), /9 or 16 numbers/);
        await assert.rejects(() => matrixRectify({
            input: source,
            output: path.join(root, 'bad.png'),
            matrix: [0, 0, 0, 0, 0, 0, 0, 0, 0],
            cwd: root,
            engine: 'sharp',
        }), /cannot be inverted/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
