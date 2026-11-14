/**
 * @file test/phases.test.js
 * @purpose Behavioural port of the monolith's reference phases (`archive/reference-phases` of the
 *          Universal-AI repository) onto the new pipeline.
 *
 *          The monolith let every phase be switched with a mode: `auto`, `always` or `off`. There is
 *          no such switch here — the six stages run in a fixed order and each one is switched off
 *          as a whole through `stages.<id>.enabled`. What is left of the phases is the behaviour
 *          they were written for: which frames are worth asking about, when an answer counts as the
 *          same picture and not a redraw, and which of the role's own numbers are trusted.
 *
 *          The generative half is stubbed: these tests are about the harness refusing a bad answer,
 *          not about what a model returns.
 *
 * @depends node:test, stages/extension, stages/decompose, stages/rectify, stages/overlap,
 *   stages/resolve, stages/restore-plan
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

import {
    bandFillShare,
    extensionTarget,
    extenderPrompt,
    EXTENDER_FRAME,
    regionDelta,
    runExtension,
    seamDelta,
} from '../src/stages/extension.js';
import { AGENT_TOOLS, INLINE_TOOLS } from '../src/stages/decompose.js';
import { RECTIFIER_TOOLS } from '../src/stages/rectify.js';
import { OVERLAP_TOOLS } from '../src/stages/overlap.js';
import { DIRECTOR_TOOLS } from '../src/stages/resolve.js';
import { editorPrompt, EDITOR_FRAME, MIN_FRAGMENT_SIDE, planFragment } from '../src/stages/restore-plan.js';
import { defaults } from '../src/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A flat RGBA picture of one colour. */
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

/** A PNG of one colour. */
const sourcePng = async (width, height, fill) => sharp(rgbaFrame(width, height, fill).data,
    { raw: { width, height, channels: 4 } }).png().toBuffer();

/** The pixel at a place in a decoded picture. */
const pixelAt = (frame, x, y) => {
    const at = (y * frame.width + x) * 4;
    return [frame.data[at], frame.data[at + 1], frame.data[at + 2], frame.data[at + 3]];
};

/** The state the extension stage expects. */
const stateFor = (root, roles, client, overrides = {}) => ({
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
    ...overrides,
});

const extendPlan = (overrides = {}) => ({
    status: 'completed',
    data: {
        verdict: 'extend',
        assessment: 'The last row is cut off.',
        edge: 'bottom',
        prompt: 'Continue the list rows in the same grey with the same separators.',
        ...overrides,
    },
});

// ---------------------------------------------------------------------------
// Phase 0.5: the frame that ends inside real content
// ---------------------------------------------------------------------------

test('extend: the frame asked of the editor is a local pad, not the model floor', () => {
    // The monolith grew a 1024×768 reference up to the 1024×1024 preset the image editor serves.
    // Here the canvas is padded locally: the source keeps its own scale, and only a band of a
    // quarter of the long edge is added to it.
    assert.deepEqual(extensionTarget({ width: 1024, height: 768 }, 0.25, 'bottom'),
        { width: 1024, height: 1024, band: 256, offsets: { top: 0, right: 0, bottom: 256, left: 0 } });
    assert.deepEqual(extensionTarget({ width: 1024, height: 768 }, 0.25, 'right'),
        { width: 1280, height: 768, band: 256, offsets: { top: 0, right: 256, bottom: 0, left: 0 } });
    // Every edge of the picture may grow: the source is cut into screens from wherever it is.
    assert.deepEqual(extensionTarget({ width: 1024, height: 768 }, 0.25, 'left'),
        { width: 1280, height: 768, band: 256, offsets: { top: 0, right: 0, bottom: 0, left: 256 } });
    assert.deepEqual(extensionTarget({ width: 1024, height: 768 }, 0.25, 'top'),
        { width: 1024, height: 1024, band: 256, offsets: { top: 256, right: 0, bottom: 0, left: 0 } });
    // A frame that cannot be measured, or a band that would be empty, is refused.
    assert.equal(extensionTarget({ width: 0, height: 10 }, 0.25, 'bottom'), null);
    assert.equal(extensionTarget(null, 0.25, 'bottom'), null);
    assert.equal(extensionTarget({ width: 32, height: 16 }, 0, 'bottom'), null);
});

test('extend: the source reaches the editor at its own scale', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-phase-extend-'));
    try {
        await writeFile(path.join(root, 'mockup.png'), await sourcePng(32, 16, [10, 20, 30]));
        const calls = [];
        const client = {
            images: {
                async edit(params) {
                    calls.push(params);
                    // The honest answer: the source stays where it was and the band below it is
                    // painted.
                    const data = Buffer.alloc(32 * 32 * 4);
                    for (let y = 0; y < 32; y++) {
                        const fill = y < 16 ? [10, 20, 30] : [0, 128, 255];
                        for (let x = 0; x < 32; x++) {
                            const at = (y * 32 + x) * 4;
                            data[at] = fill[0];
                            data[at + 1] = fill[1];
                            data[at + 2] = fill[2];
                            data[at + 3] = 255;
                        }
                    }
                    const grown = await sharp(data, { raw: { width: 32, height: 32, channels: 4 } }).png().toBuffer();
                    return { images: [{ bytes: grown, mime: 'image/png' }] };
                },
            },
        };
        const state = stateFor(root, { async run() { return extendPlan(); } }, client);
        await runExtension(state, () => {});

        assert.equal(calls.length, 1);
        assert.equal(calls[0].size, '32x32', 'the editor is asked for the padded frame, not a preset');
        const sent = await sharp(calls[0].image.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        assert.deepEqual([sent.info.width, sent.info.height], [32, 32]);
        assert.deepEqual(pixelAt({ width: sent.info.width, data: sent.data }, 6, 1), [10, 20, 30, 255],
            'the source is not resampled on its way to the editor');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('extend: the role writes the wording, the harness adds the contract', () => {
    const text = extenderPrompt('Continue the keyboard rows in the same grey.');
    assert.match(text, /^Continue the keyboard rows in the same grey\.\n\n/);
    assert.ok(text.includes(EXTENDER_FRAME), 'the frame that forbids touching the original is appended');
});

test('extend: the seam tells a painted band from a resampled frame', () => {
    // The real failure this pays for: an editor that answers a 1024×768 → 1024×1024 request by
    // repainting the whole frame. The original area drifts by tens of levels, so a check of the
    // whole area would refuse it — and it would refuse the honest outpaint too, because a
    // diffusion pass never returns the source bytes untouched.
    const source = rgbaFrame(8, 12, [10, 20, 30]);
    const repaintedTop = rgbaFrame(8, 12, [10, 20, 30]);
    for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 8; x++) {
            const at = (y * 8 + x) * 4;
            repaintedTop.data[at] = 200;
            repaintedTop.data[at + 1] = 0;
            repaintedTop.data[at + 2] = 0;
        }
    }
    const whole = regionDelta(source, repaintedTop, 8, 12);
    const seam = seamDelta(source, repaintedTop, 8, 12, { edge: 'bottom', fraction: 0.5 });
    assert.ok(whole.meanDelta > 3, 'the original area did drift');
    assert.equal(seam.meanDelta, 0, 'the last rows of the original area are exactly where they were');
    assert.ok(seam.delta <= defaults.image.seamDeltaMin, 'a band under an untouched seam is accepted');

    // A frame whose seam moved too is a resample: the band below it continues a scaled copy, and
    // stitching it to the untouched original would put two scales in one picture.
    const resampled = seamDelta(source, rgbaFrame(8, 12, [200, 0, 0]), 8, 12, { edge: 'bottom', fraction: 0.5 });
    assert.ok(resampled.delta > defaults.image.seamDeltaMin, 'a resampled frame is refused');
});

test('extend: a band the model left empty is not a growth', () => {
    const answer = { width: 4, height: 6, data: Buffer.alloc(4 * 6 * 4) };
    // Rows 4 and 5 are the grown band; here they are still the transparent padding.
    assert.equal(bandFillShare(answer, 4, 4, 'bottom'), 0);
    for (let i = 4 * 4 * 4; i < answer.data.length; i += 4) answer.data[i + 3] = 255;
    assert.equal(bandFillShare(answer, 4, 4, 'bottom'), 1);
});

test('extend: a verdict of keep leaves the reference alone', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-phase-keep-'));
    try {
        await writeFile(path.join(root, 'mockup.png'), await sourcePng(32, 16, [10, 20, 30]));
        let calls = 0;
        const client = { images: { async edit() { calls += 1; throw new Error('the editor must not be asked'); } } };
        const state = stateFor(root, {
            async run() {
                return extendPlan({ verdict: 'keep', edge: '', prompt: '' });
            },
        }, client);
        await runExtension(state, () => {});

        assert.equal(calls, 0, 'a complete frame is never sent to the editor');
        assert.equal(state.extended.length, 1);
        assert.equal(state.extended[0].kept, true);
        assert.equal(state.extended[0].to, 'mockup.png');
        assert.deepEqual(state.images, ['mockup.png']);
        assert.equal(await stat(path.join(root, 'decomposition', 'extended', 'mockup.png')).catch(() => null), null);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Phase 1: the projection, and the tools that reach it
// ---------------------------------------------------------------------------

test('the stages hold the tools their own job needs', () => {
    // The rectifier owns the geometry: it may project a picture and compare two of them, and it
    // may not crop, split or write — a role that redraws a screen does so in the wrong stage.
    assert.ok(RECTIFIER_TOOLS.includes('correct_perspective'), RECTIFIER_TOOLS.join(', '));
    for (const forbidden of ['crop_image', 'split_image', 'write_file', 'generate_image', 'edit_image']) {
        assert.ok(!RECTIFIER_TOOLS.includes(forbidden), `${forbidden} is not geometry`);
    }

    // The monolith kept the projection away from the decomposer. Here the decomposer cuts the
    // collage itself, so it holds the projection as well — but only in the agent mode: in the
    // inline mode it only names a rectangle and the harness cuts the pixels.
    assert.ok(AGENT_TOOLS.includes('crop_image'), AGENT_TOOLS.join(', '));
    assert.ok(AGENT_TOOLS.includes('split_image'), AGENT_TOOLS.join(', '));
    assert.ok(AGENT_TOOLS.includes('correct_perspective'), AGENT_TOOLS.join(', '));
    assert.deepEqual(INLINE_TOOLS, ['view_image']);

    // The overlap role names the foreign regions and the harness cuts them out, so it may only
    // look and compare.
    assert.deepEqual(OVERLAP_TOOLS, ['view_image', 'compare_images']);

    // The director reads the screen and names the layers; it never draws one.
    assert.deepEqual(DIRECTOR_TOOLS, ['view_image']);
});

test('there is no mode switch left: a stage is either on or off', () => {
    for (const [name, settings] of Object.entries(defaults.stages)) {
        assert.equal(typeof settings.enabled, 'boolean', `${name} has an enabled flag`);
        if (name === 'decompose' || name === 'rectify') continue;
        assert.equal(settings.mode, undefined, `${name} has no auto/always/off mode`);
    }
    // The only modes that survived are the ones that name a different kind of work, not a
    // different amount of it: who cuts the screens, and who straightens the reference.
    assert.deepEqual(defaults.stages.decompose.mode, 'agent');
    assert.deepEqual(defaults.stages.rectify.mode, 'geometry');
});

// ---------------------------------------------------------------------------
// Phase 1.5: the repair lands in one box or not at all
// ---------------------------------------------------------------------------

test('restore: a sliver is grown, a box with context is sent as it was reported', () => {
    const corner = planFragment({ x: 10, y: 10, width: 10, height: 10 },
        { frameWidth: 600, frameHeight: 800 });
    assert.equal(corner.grown, true);
    assert.ok(corner.width >= MIN_FRAGMENT_SIDE && corner.height >= MIN_FRAGMENT_SIDE, JSON.stringify(corner));
    assert.equal(corner.x, 0, 'a box at the corner grows inwards, never off the frame');

    const mid = planFragment({ x: 300, y: 400, width: 120, height: 80 },
        { frameWidth: 600, frameHeight: 800 });
    assert.equal(mid.grown, false, 'a box with context around the damage is sent as it was reported');
    assert.equal(mid.x, 276);
});

test('restore: the prompt the role wrote travels under the fragment contract', () => {
    const text = editorPrompt('Continue the 1 px #DDDDDD border along the cut edge.');
    assert.match(text, /^Continue the 1 px #DDDDDD border along the cut edge\.\n\n/);
    assert.match(text, /fragment cut out of a larger interface screenshot/);
    assert.ok(text.includes(EDITOR_FRAME));
});
