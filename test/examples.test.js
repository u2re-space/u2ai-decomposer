/**
 * @file test/examples.test.js
 * @purpose Checks of the packaged examples: the pictures the README points at have to exist, keep
 *          their shape, and the inline path of the decompose stage has to cut a screen out of one
 *          of them the way the documentation says it does.
 * @depends node:test, stages/decompose, openai/images
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { runDecompose } from '../src/stages/decompose.js';
import { sniffImage } from '../src/openai/images.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = path.join(ROOT, 'examples');

const metadataOf = async (file) => await sharp(file).metadata();

test('the example reference is a JPEG under a PNG name', async () => {
    const file = path.join(EXAMPLES, 'original.png');
    const bytes = await readFile(file);
    const meta = await metadataOf(file);
    assert.equal(meta.format, 'jpeg');
    assert.deepEqual([meta.width, meta.height], [1024, 768]);
    // The extension lies, so the format is taken from the content: a JPEG sent as a PNG is a
    // picture no model can read.
    assert.equal(sniffImage(bytes).mime, 'image/jpeg');
});

test('the packaged examples keep their shape', async () => {
    for (const name of ['ai-extended.png', 'ai-rectified.png']) {
        const meta = await metadataOf(path.join(EXAMPLES, name));
        assert.equal(meta.format, 'png', name);
        assert.deepEqual([meta.width, meta.height], [1254, 1254], name);
    }
    for (const name of ['screen-1.png', 'screen-2.png', 'screen-3.png']) {
        const meta = await metadataOf(path.join(EXAMPLES, 'screens', name));
        assert.equal(meta.format, 'png', name);
        assert.deepEqual([meta.width, meta.height], [360, 800], name);
    }
});

test('the inline path cuts a screen out of the example picture, pixel for pixel', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-examples-'));
    try {
        await copyFile(path.join(EXAMPLES, 'ai-rectified.png'), path.join(root, 'reference.png'));
        const rect = { x: 100, y: 200, width: 360, height: 800 };
        const roles = {
            resolve: () => ({ instructions: 'You are the decomposer.' }),
            async run() {
                return {
                    status: 'completed',
                    data: {
                        summary: 'Three phones in one picture.',
                        screens: [{ name: 'home', source: 'reference.png', rect }],
                        subReferences: [],
                        notes: [],
                    },
                    text: '',
                    toolCalls: [],
                    usage: null,
                    error: null,
                };
            },
        };
        const state = {
            root,
            images: ['reference.png'],
            workDir: 'decomposition',
            config: {
                tools: {},
                image: { maxSide: 1536, maxMegapixels: 100 },
                limits: { maxImageBytes: 8 * 1024 * 1024 },
                raster: { engine: 'sharp' },
                stages: { decompose: { mode: 'inline', maxRects: 24, maxInlinePixels: 64_000_000, minScreenSide: 48 } },
            },
            client: { responses: null, images: null },
            roles,
            model: 'vendor/vision',
            effort: null,
            warnings: [],
        };

        await runDecompose(state, () => {});

        assert.equal(state.warnings.length, 0, state.warnings.join('; '));
        assert.equal(state.screensFiles.length, 1);
        const cut = state.screensFiles[0];
        assert.equal(cut.rel, 'decomposition/screens/01-home.png');
        assert.equal(cut.kind, 'crop');
        assert.equal(state.screens[0].subReference, cut.rel);

        const meta = await metadataOf(path.join(root, cut.rel));
        assert.deepEqual([meta.width, meta.height], [rect.width, rect.height]);

        // The screen in the file is the screen in the source: the harness cuts, it does not draw.
        const source = await sharp(path.join(root, 'reference.png')).ensureAlpha().raw()
            .toBuffer({ resolveWithObject: true });
        const written = await sharp(path.join(root, cut.rel)).ensureAlpha().raw()
            .toBuffer({ resolveWithObject: true });
        for (const [x, y] of [[0, 0], [180, 400], [359, 799]]) {
            const from = ((rect.y + y) * source.info.width + (rect.x + x)) * 4;
            const to = (y * written.info.width + x) * 4;
            assert.deepEqual(
                Array.from(written.data.subarray(to, to + 4)),
                Array.from(source.data.subarray(from, from + 4)),
                `the pixel at ${x},${y} is the pixel of the source`,
            );
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
