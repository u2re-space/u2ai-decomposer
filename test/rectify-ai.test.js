/**
 * @file test/rectify-ai.test.js
 * @purpose Tests of the `ai-mode` of the rectify stage: the AI straightens the reference, the
 *          geometry cuts the straightened picture, and a straightening that is not flatter is
 *          rolled back.
 * @depends node:test, stages/rectify-ai, stages/index, image/skew
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

import { runRectifyAi, straightenReference, STRAIGHTENED_DIR } from '../src/stages/rectify-ai.js';
import { RECTIFIED_DIR } from '../src/stages/rectify.js';
import { stageById } from '../src/stages/index.js';

const SCREEN_REL = 'decomposition/screens/01-home.png';
const RECT_REL = `decomposition/${RECTIFIED_DIR}/01-home.png`;
const REFERENCE_REL = 'decomposition/extended/app.png';

/** A picture of horizontal stripes: the shape the skew measurement looks for. */
const stripes = async (degrees = 0) => {
    const width = 320;
    const height = 240;
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
    if (!degrees) return await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
    return await sharp(data, { raw: { width, height, channels: 4 } })
        .rotate(degrees, { background: { r: 0, g: 0, b: 0 } })
        .png()
        .toBuffer();
};

/** The bytes of the picture the role was shown. */
const shown = (params) => Buffer.from(String(params.parts[0].image_url).split(',')[1], 'base64');

const mockRoles = (answers, calls = []) => ({
    resolve: () => ({ instructions: 'You are the rectifier.' }),
    async run(name, params) {
        calls.push({ name, params });
        const answer = Array.isArray(answers) ? answers[Math.min(calls.length - 1, answers.length - 1)] : answers;
        return { status: 'completed', data: answer, text: '', toolCalls: [], usage: null, error: null };
    },
});

/** The answer of the rectifier: one screen, cut by the corners the role names. */
const cutAnswer = {
    verdict: 'rectified',
    assessment: 'one phone in the picture',
    screens: [{
        label: 'home',
        output: RECT_REL,
        quad: { tl: { x: 0, y: 0 }, tr: { x: 319, y: 0 }, br: { x: 319, y: 239 }, bl: { x: 0, y: 239 } },
    }],
};

/** A work dir with a tilted reference and the crop the decompose stage made of it. */
const aiDir = async (degrees = 6) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-rectify-ai-'));
    await mkdir(path.join(root, 'decomposition', 'extended'), { recursive: true });
    await mkdir(path.join(root, 'decomposition', 'screens'), { recursive: true });
    await writeFile(path.join(root, REFERENCE_REL), await stripes(degrees));
    await writeFile(path.join(root, SCREEN_REL), await stripes(degrees));
    return root;
};

const aiState = (root, roles, overrides = {}) => ({
    root,
    workDir: 'decomposition',
    images: [REFERENCE_REL],
    references: [REFERENCE_REL],
    screens: [{ name: 'home', source: REFERENCE_REL, subReference: SCREEN_REL, subReferenceKind: 'crop' }],
    screensFiles: [{ rel: SCREEN_REL, screen: 'home', kind: 'crop', source: REFERENCE_REL, note: '' }],
    config: {
        model: 'vendor/vision',
        imageModel: 'vendor/painter',
        roles: {},
        image: { maxSide: 1536, maxMegapixels: 100 },
        limits: { maxImageBytes: 8 * 1024 * 1024 },
        raster: { engine: 'sharp' },
        tools: {},
        stages: {
            rectify: {
                enabled: true,
                mode: 'ai-mode',
                maxTurns: 24,
                maxSplitTurns: 32,
                maxAttempts: 2,
                residualSkewLimitDeg: 0.8,
                minImprovementDeg: 0.4,
                review: false,
                straightenAttempts: 1,
                maxRepairPasses: 2,
                maxPatches: 3,
                boxPadding: 16,
                quality: 'low',
                cleanOverlap: true,
            },
        },
    },
    client: { images: null },
    roles,
    model: null,
    effort: null,
    imageModel: 'vendor/painter',
    warnings: [],
    rectified: [],
    restored: [],
    overlapResolved: [],
    ...overrides,
});

// ---------------------------------------------------------------------------
// The first half of the mode: the AI straightens the reference
// ---------------------------------------------------------------------------

test('the AI straightens the reference and the geometry cuts the straightened picture', async () => {
    const root = await aiDir();
    try {
        const straight = await stripes(0);
        const edits = [];
        const calls = [];
        const events = [];
        const client = {
            images: {
                edit: async (params) => {
                    edits.push(params);
                    return { images: [{ bytes: straight, mime: 'image/png' }] };
                },
                generate: async () => ({ images: [] }),
            },
        };
        const state = aiState(root, mockRoles(cutAnswer, calls), { client });
        await runRectifyAi(state, (event) => events.push(event));

        assert.equal(edits.length, 1, 'the editor is asked once');
        const reference = await readFile(path.join(root, REFERENCE_REL));
        assert.deepEqual(edits[0].image.bytes, reference, 'the editor got the reference itself');

        assert.equal(calls.length, 1, 'the role is asked about the reference');
        assert.deepEqual(shown(calls[0].params), straight, 'the role sees the straightened picture');
        assert.match(calls[0].params.text, new RegExp(STRAIGHTENED_DIR));

        // The screen is cut out of the straightened picture.
        assert.equal(state.screens[0].subReference, RECT_REL);
        assert.deepEqual(state.images, [RECT_REL]);
        const straightened = await readdir(path.join(root, 'decomposition', STRAIGHTENED_DIR));
        assert.equal(straightened.length, 1, straightened.join(', '));
        const event = events.find((item) => item.type === 'rectify.straightened');
        assert.equal(event.accepted, true);
        assert.ok(Math.abs(event.before) > 1, `the reference was tilted (${event.before}°)`);
        assert.ok(Math.abs(event.after) < 1, `the picture is level now (${event.after}°)`);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a straightened reference that is not flatter is rolled back', async () => {
    const root = await aiDir();
    try {
        const straight = await stripes(0);
        const tilted = await stripes(10);
        const edits = [];
        const calls = [];
        const events = [];
        const client = {
            images: {
                edit: async (params) => {
                    edits.push(params);
                    return { images: [{ bytes: tilted, mime: 'image/png' }] };
                },
                generate: async () => ({ images: [] }),
            },
        };
        const state = aiState(root, mockRoles(cutAnswer, calls), { client });
        await runRectifyAi(state, (event) => events.push(event));

        assert.equal(edits.length, 1, 'the editor is asked once');
        assert.deepEqual(shown(calls[0].params), await readFile(path.join(root, REFERENCE_REL)),
            'the role sees the original reference, not the answer of the editor');
        const event = events.find((item) => item.type === 'rectify.straightened');
        assert.equal(event.accepted, false);
        assert.match(event.reason, /not flatter/);
        const straightened = await readdir(path.join(root, 'decomposition', STRAIGHTENED_DIR));
        assert.deepEqual(straightened, [], 'the file of the refused attempt is deleted');
        // The cut still happens — on the original picture, and the tilt gate has the last word:
        // a cut of a picture that is still tilted is not a screen.
        assert.equal(state.screens[0].subReference, SCREEN_REL);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a reference that is already level is not sent to the editor', async () => {
    const root = await aiDir(0);
    try {
        const edits = [];
        const calls = [];
        const client = {
            images: {
                edit: async (params) => {
                    edits.push(params);
                    return { images: [{ bytes: await stripes(0), mime: 'image/png' }] };
                },
                generate: async () => ({ images: [] }),
            },
        };
        const state = aiState(root, mockRoles(cutAnswer, calls), { client });
        await runRectifyAi(state, () => {});

        assert.equal(edits.length, 0, 'there is nothing to straighten');
        assert.deepEqual(shown(calls[0].params), await readFile(path.join(root, REFERENCE_REL)));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('every attempt of the straightening starts from the original picture', async () => {
    const root = await aiDir();
    try {
        const edits = [];
        const client = {
            images: {
                edit: async (params) => {
                    edits.push(params);
                    // The first answer is flatter than the reference, the second one is worse.
                    const bytes = edits.length === 1 ? await stripes(4) : await stripes(10);
                    return { images: [{ bytes, mime: 'image/png' }] };
                },
                generate: async () => ({ images: [] }),
            },
        };
        const state = aiState(root, mockRoles(cutAnswer), { client });
        state.config.stages.rectify.straightenAttempts = 2;
        const result = await straightenReference({
            client,
            editorModel: 'vendor/painter',
            file: { rel: REFERENCE_REL, abs: path.join(root, REFERENCE_REL) },
            root,
            outDir: path.join(root, 'decomposition', STRAIGHTENED_DIR),
            engine: 'sharp',
            attempts: 2,
        });

        assert.equal(edits.length, 2, 'the AI is asked twice');
        const reference = await readFile(path.join(root, REFERENCE_REL));
        assert.deepEqual(edits[0].image.bytes, reference);
        assert.deepEqual(edits[1].image.bytes, reference, 'the second attempt starts from the original');
        assert.equal(result.accepted, true);
        assert.ok(Math.abs(result.after) < 4.5, `the flattest attempt wins (${result.after}°)`);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// The mode of the config
// ---------------------------------------------------------------------------

test('the mode of the config chooses the way the stage runs', async () => {
    const root = await aiDir();
    try {
        const edits = [];
        const client = {
            images: {
                edit: async (params) => {
                    edits.push(params);
                    return { images: [{ bytes: await stripes(0), mime: 'image/png' }] };
                },
                generate: async () => ({ images: [] }),
            },
        };
        const state = aiState(root, mockRoles(cutAnswer), { client });
        state.config.stages.rectify.mode = 'geometry';
        await stageById('rectify').run(state, () => {});
        assert.equal(edits.length, 0, 'the geometry mode does not touch the editor');

        state.config.stages.rectify.mode = 'ai-mode';
        await stageById('rectify').run(state, () => {});
        assert.equal(edits.length, 1, 'the ai-mode straightens the reference');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
