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
    extensionTarget,
    runExtension,
    seamDelta,
} from '../src/stages/extension.js';

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
    });
    assert.deepEqual(extensionTarget({ width: 16, height: 32 }, 0.25, 'right'), {
        width: 24, height: 32, band: 8,
    });
    assert.equal(extensionTarget({ width: 32, height: 16 }, 0, 'bottom'), null);
    assert.equal(extensionTarget({ width: 32, height: 16 }, 0.5, 'left'), null);
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
        assert.match(state.warnings.join('\n'), /seam drifted/);
        assert.equal(await stat(path.join(root, 'decomposition', 'extended', 'mockup.png')).catch(() => null), null);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
