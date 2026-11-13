/**
 * @file test/extension.test.js
 * @purpose Tests of the extension stage: local padding, seam acceptance, retries and band stitch.
 * @depends node:test, stages/extension
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

import {
    bandFillShare,
    bandInnerSide,
    bandRects,
    edgeList,
    extensionTarget,
    runExtension,
    seamDelta,
} from '../src/stages/extension.js';
import { rasterPadImageBytes } from '../src/image/raster.js';

const rgbaFrame = (width, height, fill) => {
    const data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        data[i * 4] = fill[0];
        data[i * 4 + 1] = fill[1];
        data[i * 4 + 2] = fill[2];
        data[i * 4 + 3] = 255;
    }
    return { width, height, data };
};

const sourcePng = (width, height, fill) => {
    const data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        data[i * 4] = fill[0];
        data[i * 4 + 1] = fill[1];
        data[i * 4 + 2] = fill[2];
        data[i * 4 + 3] = 255;
    }
    return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
};

const growthPng = async (width, height, sourceHeight, source, band) => {
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        const fill = y < sourceHeight ? source : band;
        for (let x = 0; x < width; x++) {
            const at = (y * width + x) * 4;
            data[at] = fill[0];
            data[at + 1] = fill[1];
            data[at + 2] = fill[2];
            data[at + 3] = 255;
        }
    }
    return await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
};

const growthRightPng = async (width, height, sourceWidth, source, band) => {
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const fill = x < sourceWidth ? source : band;
            const at = (y * width + x) * 4;
            data[at] = fill[0];
            data[at + 1] = fill[1];
            data[at + 2] = fill[2];
            data[at + 3] = 255;
        }
    }
    return await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
};

const growthTopPng = async (width, height, sourceTop, source, band) => {
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        const fill = y < sourceTop || y >= sourceTop + 16 ? band : source;
        for (let x = 0; x < width; x++) {
            const at = (y * width + x) * 4;
            data[at] = fill[0];
            data[at + 1] = fill[1];
            data[at + 2] = fill[2];
            data[at + 3] = 255;
        }
    }
    return await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
};

const growthLeftPng = async (width, height, sourceLeft, source, band) => {
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const fill = x < sourceLeft || x >= sourceLeft + 16 ? band : source;
            const at = (y * width + x) * 4;
            data[at] = fill[0];
            data[at + 1] = fill[1];
            data[at + 2] = fill[2];
            data[at + 3] = 255;
        }
    }
    return await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
};

const stateFor = (root, roles, client) => ({
    root,
    images: ['mockup.png'],
    workDir: 'decomposition',
    config: {
        imageModel: 'vendor/editor',
        image: { format: 'png', quality: 'high', background: 'auto', seamDeltaMin: 0.25, seamBandFraction: 0.1 },
        raster: { engine: 'sharp' },
        stages: { extend: { padFraction: 0.5, maxAttempts: 2 } },
    },
    client,
    roles,
    model: 'vendor/vision',
    effort: null,
    imageModel: 'vendor/editor',
    warnings: [],
    extended: [],
    canvas: [],
});

const plan = {
    status: 'completed',
    data: {
        verdict: 'extend',
        assessment: 'The last row is cut off.',
        edge: 'bottom',
        prompt: 'Continue the list rows in the same grey with the same separators.',
    },
};

test('the extension canvas grows by a fraction of the long edge', () => {
    assert.deepEqual(extensionTarget({ width: 32, height: 16 }, 0.5, 'bottom'), {
        width: 32, height: 32, band: 16,
        offsets: { top: 0, right: 0, bottom: 16, left: 0 },
    });
    assert.deepEqual(extensionTarget({ width: 16, height: 32 }, 0.25, 'right'), {
        width: 24, height: 32, band: 8,
        offsets: { top: 0, right: 8, bottom: 0, left: 0 },
    });
    assert.equal(extensionTarget({ width: 32, height: 16 }, 0, 'bottom'), null);
    assert.equal(extensionTarget({ width: 32, height: 16 }, 0.5, ''), null);
});

test('every edge of the picture may be grown', () => {
    assert.deepEqual(extensionTarget({ width: 16, height: 16 }, 0.5, 'top').offsets, {
        top: 8, right: 0, bottom: 0, left: 0,
    });
    assert.deepEqual(extensionTarget({ width: 16, height: 16 }, 0.5, 'left').offsets, {
        top: 0, right: 0, bottom: 0, left: 8,
    });
    const both = extensionTarget({ width: 16, height: 16 }, 0.5, ['top', 'bottom']);
    assert.deepEqual(both.offsets, { top: 8, right: 0, bottom: 8, left: 0 });
    assert.deepEqual([both.width, both.height], [16, 32]);
    const four = extensionTarget({ width: 16, height: 16 }, 0.5, ['top', 'right', 'bottom', 'left']);
    assert.deepEqual([four.width, four.height], [32, 32]);
});

test('the edges of an answer are read as a list', () => {
    assert.deepEqual(edgeList('bottom'), ['bottom']);
    assert.deepEqual(edgeList(' BOTTOM '), ['bottom']);
    assert.deepEqual(edgeList(['top', 'bottom', 'top']), ['top', 'bottom']);
    assert.deepEqual(edgeList(['top', 'sideways']), ['top']);
    assert.deepEqual(edgeList(''), []);
    assert.deepEqual(edgeList(null), []);
    assert.deepEqual(edgeList(undefined), []);
});

test('the bands of the new canvas cover the ring around the source once', () => {
    const canvas = { width: 32, height: 32 };
    const source = { width: 16, height: 16 };
    const offsets = { top: 8, right: 8, bottom: 8, left: 8 };
    const rects = bandRects(canvas, source, offsets);
    assert.deepEqual(rects.map((rect) => rect.edge), ['top', 'bottom', 'left', 'right']);
    // The bands do not overlap: every pixel of the ring belongs to exactly one band.
    const seen = new Set();
    for (const rect of rects) {
        for (let y = rect.y; y < rect.y + rect.height; y++) {
            for (let x = rect.x; x < rect.x + rect.width; x++) {
                const key = `${x}:${y}`;
                assert.equal(seen.has(key), false, `${key} is in two bands`);
                seen.add(key);
            }
        }
    }
    assert.equal(seen.size, 32 * 32 - 16 * 16);
    assert.equal(bandInnerSide('bottom'), 'top');
    assert.equal(bandInnerSide('top'), 'bottom');
    assert.equal(bandInnerSide('left'), 'right');
    assert.equal(bandInnerSide('right'), 'left');
});

test('the seam metric reads the edge the answer was asked to grow', () => {
    const before = rgbaFrame(16, 16, [10, 20, 30]);
    // The source sits eight pixels below the top of the canvas, so the top seam is read there.
    const canvas = Buffer.alloc(16 * 32 * 4);
    const painted = Buffer.alloc(16 * 32 * 4);
    before.data.copy(canvas, 8 * 16 * 4);
    before.data.copy(painted, 8 * 16 * 4);
    const frame = (data) => ({ width: 16, height: 32, data });
    assert.equal(seamDelta(before, frame(painted), 16, 16, {
        edge: 'top', fraction: 0.1, offsetY: 8,
    }).delta, 0);
    const repainted = rgbaFrame(16, 32, [200, 0, 0]);
    assert.ok(seamDelta(before, repainted, 16, 16, {
        edge: 'top', fraction: 0.1, offsetY: 8,
    }).delta > 0.25);
    // The band of the top edge is the part of the canvas above the source.
    assert.equal(bandFillShare(frame(canvas), 16, 16, 'top', { offsetY: 8 }), 0);
    assert.equal(bandFillShare(frame(canvas), 16, 16, 'bottom', { offsetY: 8 }), 0);
});

test('the seam metric separates a painted band from a resampled frame', () => {
    const before = rgbaFrame(16, 16, [10, 20, 30]);
    assert.equal(seamDelta(before, before, 16, 16, { edge: 'bottom', fraction: 0.1 }).delta, 0);
    const repainted = rgbaFrame(16, 16, [200, 0, 0]);
    assert.ok(seamDelta(before, repainted, 16, 16, { edge: 'bottom', fraction: 0.1 }).delta > 0.25);
    assert.equal(bandFillShare(rgbaFrame(16, 32, [0, 0, 0]), 16, 16, 'bottom'), 1);
});

test('the extension stage writes the grown band and keeps the source pixels', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-extend-'));
    try {
        await writeFile(path.join(root, 'mockup.png'), await sourcePng(32, 16, [10, 20, 30]));
        const grown = await growthPng(32, 32, 16, [10, 20, 30], [0, 128, 255]);
        const calls = [];
        const client = {
            images: {
                async edit(params) {
                    calls.push(params);
                    return { images: [{ bytes: grown, mime: 'image/png' }] };
                },
            },
        };
        const state = stateFor(root, { async run() { return plan; } }, client);

        await runExtension(state, () => {});

        assert.equal(calls.length, 1);
        assert.equal(calls[0].size, '32x32');
        assert.equal(state.extended.length, 1);
        assert.equal(state.extended[0].kept, false);
        assert.equal(state.extended[0].to, path.join('decomposition', 'extended', 'mockup.png'));
        assert.equal(state.images[0], state.extended[0].to);
        assert.equal(state.canvas[0].width, 32);
        assert.equal(state.canvas[0].height, 32);

        const output = await readFile(path.join(root, state.extended[0].to));
        const frame = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        assert.deepEqual([frame.info.width, frame.info.height], [32, 32]);
        const at = (x, y) => Array.from(frame.data.subarray((y * frame.info.width + x) * 4, (y * frame.info.width + x) * 4 + 4));
        assert.deepEqual(at(6, 1), [10, 20, 30, 255]);
        assert.deepEqual(at(6, 15), [10, 20, 30, 255]);
        assert.deepEqual(at(6, 16), [0, 128, 255, 255]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the extension stage can grow the right edge', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-extend-right-'));
    try {
        await writeFile(path.join(root, 'mockup.png'), await sourcePng(16, 16, [10, 20, 30]));
        const grown = await growthRightPng(32, 16, 16, [10, 20, 30], [0, 128, 255]);
        const client = {
            images: {
                async edit() { return { images: [{ bytes: grown, mime: 'image/png' }] }; },
            },
        };
        const state = stateFor(root, {
            async run() {
                return { ...plan, data: { ...plan.data, edge: 'right' } };
            },
        }, client);

        await runExtension(state, () => {});

        assert.equal(state.extended[0].kept, false);
        const output = await readFile(path.join(root, state.extended[0].to));
        const frame = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        assert.deepEqual([frame.info.width, frame.info.height], [32, 16]);
        const at = (x, y) => Array.from(frame.data.subarray((y * frame.info.width + x) * 4, (y * frame.info.width + x) * 4 + 4));
        assert.deepEqual(at(13, 5), [10, 20, 30, 255]);
        assert.deepEqual(at(16, 5), [0, 128, 255, 255]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a failed seam attempt is followed by a successful retry', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-extend-retry-'));
    try {
        await writeFile(path.join(root, 'mockup.png'), await sourcePng(32, 16, [10, 20, 30]));
        const repainted = await sourcePng(32, 32, [200, 0, 0]);
        const grown = await growthPng(32, 32, 16, [10, 20, 30], [0, 128, 255]);
        let calls = 0;
        const client = {
            images: {
                async edit() {
                    calls += 1;
                    return { images: [{ bytes: calls === 1 ? repainted : grown, mime: 'image/png' }] };
                },
            },
        };
        const state = stateFor(root, { async run() { return plan; } }, client);

        await runExtension(state, () => {});

        assert.equal(calls, 2);
        assert.equal(state.extended[0].kept, false);
        assert.equal(await stat(path.join(root, state.extended[0].to)).then(() => true), true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a moved seam is refused and leaves no artifact behind', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-extend-seam-'));
    try {
        await writeFile(path.join(root, 'mockup.png'), await sourcePng(32, 16, [10, 20, 30]));
        const repainted = await sourcePng(32, 32, [200, 0, 0]);
        let calls = 0;
        const client = {
            images: {
                async edit() {
                    calls += 1;
                    return { images: [{ bytes: repainted, mime: 'image/png' }] };
                },
            },
        };
        const state = stateFor(root, { async run() { return plan; } }, client);

        await runExtension(state, () => {});

        assert.equal(calls, 2, 'the stage retries up to maxAttempts');
        assert.equal(state.extended[0].kept, true);
        assert.match(state.warnings.join('\n'), /seam of the bottom band drifted/);
        assert.equal(await stat(path.join(root, 'decomposition', 'extended', 'mockup.png')).catch(() => null), null);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the extension stage can grow the top edge', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-extend-top-'));
    try {
        await writeFile(path.join(root, 'mockup.png'), await sourcePng(16, 16, [10, 20, 30]));
        const grown = await growthTopPng(16, 32, 8, [10, 20, 30], [0, 128, 255]);
        const client = {
            images: {
                async edit() { return { images: [{ bytes: grown, mime: 'image/png' }] }; },
            },
        };
        const state = stateFor(root, {
            async run() {
                return { ...plan, data: { ...plan.data, edge: 'top', edges: ['top'] } };
            },
        }, client);

        await runExtension(state, () => {});

        assert.equal(state.extended[0].kept, false);
        assert.deepEqual(state.extended[0].edges, ['top']);
        const output = await readFile(path.join(root, state.extended[0].to));
        const frame = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        assert.deepEqual([frame.info.width, frame.info.height], [16, 32]);
        const at = (x, y) => Array.from(frame.data.subarray((y * frame.info.width + x) * 4, (y * frame.info.width + x) * 4 + 4));
        assert.deepEqual(at(6, 1), [0, 128, 255, 255], 'the band is painted above the source');
        assert.deepEqual(at(6, 10), [10, 20, 30, 255], 'the source keeps its pixels');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the extension stage can grow the left edge', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-extend-left-'));
    try {
        await writeFile(path.join(root, 'mockup.png'), await sourcePng(16, 16, [10, 20, 30]));
        const grown = await growthLeftPng(32, 16, 8, [10, 20, 30], [0, 128, 255]);
        const client = {
            images: {
                async edit() { return { images: [{ bytes: grown, mime: 'image/png' }] }; },
            },
        };
        const state = stateFor(root, {
            async run() {
                return { ...plan, data: { ...plan.data, edge: 'left', edges: ['left'] } };
            },
        }, client);

        await runExtension(state, () => {});

        assert.equal(state.extended[0].kept, false);
        const output = await readFile(path.join(root, state.extended[0].to));
        const frame = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        assert.deepEqual([frame.info.width, frame.info.height], [32, 16]);
        const at = (x, y) => Array.from(frame.data.subarray((y * frame.info.width + x) * 4, (y * frame.info.width + x) * 4 + 4));
        assert.deepEqual(at(1, 5), [0, 128, 255, 255], 'the band is painted left of the source');
        assert.deepEqual(at(10, 5), [10, 20, 30, 255], 'the source keeps its pixels');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the extension stage grows two edges at once', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-extend-two-'));
    try {
        await writeFile(path.join(root, 'mockup.png'), await sourcePng(16, 16, [10, 20, 30]));
        const grown = await growthTopPng(16, 32, 8, [10, 20, 30], [0, 128, 255]);
        const client = {
            images: {
                async edit() { return { images: [{ bytes: grown, mime: 'image/png' }] }; },
            },
        };
        const state = stateFor(root, {
            async run() {
                return { ...plan, data: { ...plan.data, edge: 'top', edges: ['top', 'bottom'] } };
            },
        }, client);

        await runExtension(state, () => {});

        assert.equal(state.extended[0].kept, false);
        assert.deepEqual(state.extended[0].edges, ['top', 'bottom']);
        const output = await readFile(path.join(root, state.extended[0].to));
        const frame = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        assert.deepEqual([frame.info.width, frame.info.height], [16, 32]);
        const at = (x, y) => Array.from(frame.data.subarray((y * frame.info.width + x) * 4, (y * frame.info.width + x) * 4 + 4));
        assert.deepEqual(at(6, 1), [0, 128, 255, 255], 'the top band is painted');
        assert.deepEqual(at(6, 30), [0, 128, 255, 255], 'the bottom band is painted');
        assert.deepEqual(at(6, 16), [10, 20, 30, 255], 'the source keeps its pixels');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the padding puts the source away from the top-left corner', async () => {
    const bytes = await sourcePng(16, 16, [10, 20, 30]);
    const padded = await rasterPadImageBytes({
        bytes, engine: 'sharp', targetWidth: 32, targetHeight: 32, offsetX: 8, offsetY: 8,
    });
    assert.equal(padded.width, 32);
    assert.equal(padded.height, 32);
    assert.equal(padded.offsetX, 8);
    assert.equal(padded.offsetY, 8);
    const frame = await sharp(padded.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (x, y) => Array.from(frame.data.subarray((y * frame.info.width + x) * 4, (y * frame.info.width + x) * 4 + 4));
    assert.deepEqual(at(8, 8), [10, 20, 30, 255], 'the source sits at the offset');
    assert.deepEqual(at(0, 0), [0, 0, 0, 0], 'the rest of the canvas is empty');
});
