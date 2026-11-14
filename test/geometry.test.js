/**
 * @file test/geometry.test.js
 * @purpose Tests of the geometry correction: the rotation and the size correction of a picture,
 *          and the measurement that judges whether the correction helped.
 * @depends node:test, image/geometry, image/skew
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import sharp from 'sharp';

import { applyGeometry } from '../src/image/geometry.js';
import { measureResidualSkewFromBytes } from '../src/image/skew.js';

/** A picture of horizontal stripes: the shape the measurer reads the tilt from. */
const stripes = async (width, height, period = 12) => {
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        const on = Math.floor(y / period) % 2 === 0;
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

/** The same stripes, tilted by the given angle, with the wedge of the rotation cut away. */
const tilted = async (width, height, deg) => {
    const pad = 40;
    const level = await stripes(width + pad * 2, height + pad * 2);
    const rotated = await sharp(level).rotate(deg).png().toBuffer();
    const meta = await sharp(rotated).metadata();
    const left = Math.floor((meta.width - width) / 2);
    const top = Math.floor((meta.height - height) / 2);
    return await sharp(rotated).extract({ left, top, width, height }).png().toBuffer();
};

const withFile = async (bytes, name) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-geometry-'));
    const file = path.join(dir, name);
    await sharp(bytes).toFile(file);
    return { dir, file };
};

test('the rotation of the content is measured, removed and the picture is not cropped', async () => {
    const source = await tilted(400, 400, 3);
    const { dir, file } = await withFile(source, 'tilted.png');
    try {
        const before = await measureResidualSkewFromBytes(await readFile(file));
        assert.ok(before.angleDeg > 2.5 && before.angleDeg < 3.5, `the tilt was measured as ${before.angleDeg}°`);

        const out = path.join(dir, 'straight.png');
        const result = await applyGeometry({ input: file, output: out, rotateDeg: 3 });
        assert.ok(result.residualBefore.angleDeg > 2.5);
        assert.ok(result.residualAfter.angleDeg < 1, `the tilt left is ${result.residualAfter.angleDeg}°`);
        assert.ok(result.width > 400 && result.height > 400, 'the canvas grew instead of cutting the screen');

        const meta = await sharp(out).metadata();
        assert.deepEqual([meta.width, meta.height], [result.width, result.height]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('a correction of the wrong sign makes the picture worse, and the measurement says so', async () => {
    const source = await tilted(400, 400, 3);
    const { dir, file } = await withFile(source, 'tilted.png');
    try {
        const result = await applyGeometry({
            input: file,
            output: path.join(dir, 'wrong.png'),
            rotateDeg: -3,
        });
        assert.ok(result.residualAfter.angleDeg > result.residualBefore.angleDeg,
            `the tilt went from ${result.residualBefore.angleDeg}° to ${result.residualAfter.angleDeg}°`);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('the size correction grows the content and keeps it inside the canvas', async () => {
    const level = await stripes(300, 300);
    const { dir, file } = await withFile(level, 'level.png');
    try {
        const result = await applyGeometry({
            input: file,
            output: path.join(dir, 'grown.png'),
            scalePercent: 5,
        });
        assert.ok(result.width > 300 && result.height > 300, 'the canvas grew');
        assert.ok(Math.abs(result.width - 315) <= 2, `the width is ${result.width}`);
        assert.equal(result.residualAfter.angleDeg, 0, 'a level screen stays level');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('the wedge a rotation opens is filled with the picture, not with black', async () => {
    const source = await tilted(300, 300, 4);
    const { dir, file } = await withFile(source, 'tilted.png');
    try {
        const out = path.join(dir, 'straight.png');
        await applyGeometry({ input: file, output: out, rotateDeg: 4 });
        const { data, info } = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const corner = (x, y) => data[(y * info.width + x) * 4 + 3];
        assert.equal(corner(0, 0), 255, 'the corner is opaque');
        assert.equal(corner(info.width - 1, info.height - 1), 255, 'the corner is opaque');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
