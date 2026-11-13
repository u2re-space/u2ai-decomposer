/**
 * @file test/image.test.js
 * @purpose Tests of the image layer: the raster round trip, the crop→patch cycle, the projective
 *          warp, the skew measurement and the model-bound downscale.
 * @ai.hint keep
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import {
    decodeRgba,
    encodeRgba,
    rasterCrop,
    rasterPatch,
    rasterCompare,
    rasterEngine,
    rasterInfo,
} from '../src/image/raster.js';
import { perspectiveRectify, quadToRect, solveHomography } from '../src/image/distort.js';
import { measureResidualSkewFromBytes } from '../src/image/skew.js';
import { padBand, detectPadding, padToSize, removePadding } from '../src/image/padding.js';
import { downscaleToMaxSide } from '../src/image/sizing.js';
import { clampRect } from '../src/image/crop.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = path.join(here, '..', 'examples', 'original.png');

const engine = await rasterEngine();
const needsEngine = { skip: engine ? false : 'no local raster engine (sharp or canvas) installed' };

/**
 * Compare two RGBA frames pixel by pixel.
 * @param {{width:number,height:number,data:Buffer}} a
 * @param {{width:number,height:number,data:Buffer}} b
 */
function assertSamePixels(a, b) {
    assert.equal(a.width, b.width);
    assert.equal(a.height, b.height);
    assert.equal(a.data.length, b.data.length);
    assert.ok(a.data.equals(b.data), 'the frames differ pixel by pixel');
}

/**
 * Build a picture of horizontal stripes: the shape the skew measurement looks for.
 * @param {number} width
 * @param {number} height
 * @returns {Buffer} PNG bytes
 */
function stripes(width, height) {
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
    return Buffer.from(data);
}

test('decode → encode keeps every pixel', needsEngine, async () => {
    const bytes = await readFile(EXAMPLE);
    const frame = await decodeRgba(bytes, engine);
    assert.ok(frame.width > 0 && frame.height > 0);
    const again = await decodeRgba(await encodeRgba(frame, engine), engine);
    assertSamePixels(frame, again);
});

test('crop → patch returns the picture it started from', needsEngine, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-image-'));
    try {
        const source = path.join(dir, 'source.png');
        const crop = path.join(dir, 'crop.png');
        const patched = path.join(dir, 'patched.png');
        await writeFile(source, await readFile(EXAMPLE));

        const info = await rasterInfo(source, { engine });
        const box = { x: 100, y: 80, width: 200, height: 150 };

        await rasterCrop({ input: source, output: crop, ...box, engine });
        await rasterPatch({ input: source, patch: crop, output: patched, ...box, engine });

        const before = await decodeRgba(await readFile(source), engine);
        const after = await decodeRgba(await readFile(patched), engine);
        assertSamePixels(before, after);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('a patch that does not fit the frame is refused', needsEngine, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-image-'));
    try {
        const source = path.join(dir, 'source.png');
        const crop = path.join(dir, 'crop.png');
        await writeFile(source, await readFile(EXAMPLE));
        await rasterCrop({ input: source, output: crop, x: 0, y: 0, width: 400, height: 300, engine });
        await assert.rejects(
            () => rasterPatch({ input: source, patch: crop, output: path.join(dir, 'out.png'), x: 900, y: 700, engine }),
            /does not fit/,
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('rasterCompare reports no change for the same picture', needsEngine, async () => {
    const bytes = await readFile(EXAMPLE);
    const same = await rasterCompare({ before: bytes, after: bytes, engine });
    assert.equal(same.meanDelta, 0);
    assert.equal(same.changedShare, 0);
});

test('the homography maps the corners onto the corners', () => {
    const h = solveHomography(
        [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 20 }, { x: 10, y: 20 }],
        [{ x: 0, y: 0 }, { x: 30, y: 5 }, { x: 2, y: 25 }, { x: 32, y: 30 }],
    );
    const map = (x, y) => {
        const w = h[2][0] * x + h[2][1] * y + h[2][2];
        return {
            x: (h[0][0] * x + h[0][1] * y + h[0][2]) / w,
            y: (h[1][0] * x + h[1][1] * y + h[1][2]) / w,
        };
    };
    const expected = [{ x: 0, y: 0 }, { x: 30, y: 5 }, { x: 2, y: 25 }, { x: 32, y: 30 }];
    const corners = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 20 }, { x: 10, y: 20 }];
    corners.forEach((corner, index) => {
        const point = map(corner.x, corner.y);
        assert.ok(Math.abs(point.x - expected[index].x) < 1e-6, `corner ${index} x`);
        assert.ok(Math.abs(point.y - expected[index].y) < 1e-6, `corner ${index} y`);
    });
});

test('a quad with swapped corners is refused', () => {
    const frame = { width: 100, height: 100 };
    const good = quadToRect([{ x: 10, y: 10 }, { x: 90, y: 12 }, { x: 12, y: 88 }, { x: 88, y: 90 }], frame);
    assert.equal(good.ok, true);
    // The lower corners sit above the upper ones: the quad encloses an area but is upside down.
    const swapped = quadToRect([{ x: 10, y: 80 }, { x: 90, y: 80 }, { x: 12, y: 10 }, { x: 88, y: 10 }], frame);
    assert.equal(swapped.ok, false);
    assert.match(swapped.reason, /swapped/);
});

test('perspectiveRectify on the whole frame keeps the picture', needsEngine, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-image-'));
    try {
        const source = path.join(dir, 'source.png');
        const output = path.join(dir, 'rectified.png');
        await writeFile(source, await readFile(EXAMPLE));
        const info = await rasterInfo(source, { engine });

        const result = await perspectiveRectify({
            input: source,
            output,
            quad: [
                { x: 0, y: 0 },
                { x: info.width, y: 0 },
                { x: 0, y: info.height },
                { x: info.width, y: info.height },
            ],
            engine,
        });

        assert.equal(result.width, info.width);
        assert.equal(result.height, info.height);
        const before = await decodeRgba(await readFile(source), engine);
        const after = await decodeRgba(await readFile(output), engine);
        // The warp resamples, so the pixels are close but not necessarily identical.
        const delta = await rasterCompare({ before: await readFile(source), after: await readFile(output), engine });
        assert.ok(delta.meanDelta < 3, `mean delta ${delta.meanDelta}`);
        assert.ok(before.width === after.width);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('the skew measurement finds no tilt in level rows', needsEngine, async () => {
    const bytes = await encodeRgba({ width: 320, height: 240, data: stripes(320, 240) }, engine);
    const result = await measureResidualSkewFromBytes(bytes, { engine });
    assert.ok(Math.abs(result.angleDeg) <= 0.5, `angle ${result.angleDeg}`);
});

test('the band padding is transparent and measurable', needsEngine, async () => {
    const bytes = await readFile(EXAMPLE);
    const padded = await padBand(bytes, { fraction: 0.1, engine });
    assert.ok(padded.width > 0 && padded.height > 0);
    const frame = await decodeRgba(padded.bytes, engine);
    assert.equal(frame.width, padded.width);
    // The first row of the band has to be transparent: the model must see empty canvas.
    assert.equal(frame.data[3], 0);
    const borders = await detectPadding(padded.bytes, { engine });
    assert.ok(borders.top > 0);
});

test('the model-bound copy is scaled down and keeps its aspect', needsEngine, async () => {
    const bytes = await readFile(EXAMPLE);
    const scaled = await downscaleToMaxSide(bytes, { maxSide: 256, engine });
    assert.ok(scaled.scaled);
    assert.ok(scaled.width <= 256 && scaled.height <= 256);
    const source = await decodeRgba(bytes, engine);
    const target = await decodeRgba(scaled.bytes, engine);
    const sourceRatio = source.width / source.height;
    const targetRatio = target.width / target.height;
    assert.ok(Math.abs(sourceRatio - targetRatio) < 0.02);
});

test('a picture above the megapixel cap is refused', needsEngine, async () => {
    const bytes = await readFile(EXAMPLE);
    await assert.rejects(
        () => downscaleToMaxSide(bytes, { maxMegapixels: 0.01, engine }),
        /MP cap/,
    );
});

test('a crop rectangle is clamped to the frame', () => {
    const frame = { width: 100, height: 80 };
    assert.deepEqual(clampRect({ x: -10, y: -5, width: 40, height: 30 }, frame), { x: 0, y: 0, width: 40, height: 30 });
    assert.deepEqual(clampRect({ x: 90, y: 70, width: 40, height: 30 }, frame), { x: 90, y: 70, width: 10, height: 10 });
});

test('the pad grows the frame and the unpad takes it back', needsEngine, async () => {
    const bytes = await readFile(EXAMPLE);
    const padded = await padToSize(bytes, { targetWidth: 1200, targetHeight: 900, engine });
    assert.ok(padded.padded);
    assert.equal(padded.originalWidth, 1024);
    assert.ok(padded.width >= 1200 && padded.height >= 900);
    // The source pixels stay where they were: the band is empty canvas.
    const source = await decodeRgba(bytes, engine);
    const grown = await decodeRgba(padded.bytes, engine);
    for (let row = 0; row < source.height; row++) {
        const from = row * source.width * 4;
        const to = row * grown.width * 4;
        const taken = grown.data.subarray(to, to + source.width * 4);
        assert.ok(source.data.subarray(from, from + source.width * 4).equals(taken), `row ${row} moved`);
    }
    const restored = await removePadding(padded.bytes, {
        width: padded.width,
        height: padded.height,
        originalWidth: padded.originalWidth,
        originalHeight: padded.originalHeight,
        engine,
    });
    const back = await decodeRgba(restored, engine);
    assert.equal(back.width, source.width);
    assert.equal(back.height, source.height);
});
