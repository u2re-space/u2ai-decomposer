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

import { runRectifyAi, straightenReference, mapBoxToReference, REPAIRED_DIR, STRAIGHTENED_DIR } from '../src/stages/rectify-ai.js';
import { RECTIFIED_DIR } from '../src/stages/rectify.js';
import { perspectiveRectify } from '../src/image/rectify.js';
import { rasterCrop } from '../src/image/raster.js';
import { planFragment } from '../src/stages/restore-plan.js';
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

/**
 * A picture of thin horizontal lines.
 *
 * The lines are one pixel high, so the resampling of a projection blurs them: the cut of a screen
 * holds grey where the reference holds a sharp line. That is what tells a fragment of the screen
 * from a fragment of the reference.
 */
const lines = async (width = 320, height = 240) => {
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        const on = y % 8 === 0;
        for (let x = 0; x < width; x++) {
            const at = (y * width + x) * 4;
            const value = on ? 240 : 20;
            data[at] = value;
            data[at + 1] = value;
            data[at + 2] = value;
            data[at + 3] = 255;
        }
    }
    return await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
};

/** The bytes of the picture the role was shown. */
const shown = (params) => Buffer.from(String(params.parts[0].image_url).split(',')[1], 'base64');

/** A picture of one colour: what an editor that paints its fragment leaves behind. */
const solid = async (r, g, b, width = 320, height = 240) => await sharp({
    create: { width, height, channels: 3, background: { r, g, b } },
}).png().toBuffer();

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

        const asked = calls.filter((call) => call.name === 'rectifier');
        assert.equal(asked.length, 1, 'the role is asked about the reference');
        assert.deepEqual(shown(asked[0].params), straight, 'the role sees the straightened picture');
        assert.match(asked[0].params.text, new RegExp(STRAIGHTENED_DIR));

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
// The second half of the mode: the AI repairs the fragments
// ---------------------------------------------------------------------------

/**
 * The corners of two screens of a collage.
 *
 * The reference is level, and the screens inside it are seen at an angle: the cut of these corners
 * is a perspective, and the pixels of the cut are the pixels of the reference, read at another
 * angle. A fragment of the screen and a fragment of the reference are therefore not the same
 * bytes — which is what tells the two sources of a repair apart.
 */
const COLLAGE_QUADS = [
    { tl: { x: 40, y: 10 }, tr: { x: 140, y: 20 }, br: { x: 160, y: 230 }, bl: { x: 20, y: 220 } },
    { tl: { x: 180, y: 20 }, tr: { x: 280, y: 10 }, br: { x: 300, y: 220 }, bl: { x: 160, y: 230 } },
];

/** The answer of the rectifier: the two screens of the collage. */
const collageAnswer = {
    verdict: 'rectified',
    assessment: 'two phones in the picture',
    screens: [
        { label: 'home', output: RECT_REL, quad: COLLAGE_QUADS[0] },
        { label: 'detail', output: `decomposition/${RECTIFIED_DIR}/02-detail.png`, quad: COLLAGE_QUADS[1] },
    ],
};

/** The repair plan of the repairer of the ai-mode. */
const repairPlan = (source = 'screen', region = { x: 10, y: 10, width: 50, height: 40 }) => ({
    verdict: 'repair',
    assessment: 'a seam runs along the left of the screen',
    patches: [{
        kind: 'seam',
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
        source,
        finding: 'a seam runs along the left of the screen',
        prompt: 'remove the seam and continue the background of the screen without a break',
    }],
});

/** A mock that answers every role by its name. */
const mockRolesByName = (answers, calls = []) => ({
    resolve: () => ({ instructions: 'You are the rectifier.' }),
    async run(name, params) {
        const index = calls.filter((call) => call.name === name).length;
        calls.push({ name, params });
        const answer = typeof answers === 'function' ? answers(name, index) : answers[name];
        return { status: 'completed', data: answer, text: '', toolCalls: [], usage: null, error: null };
    },
});

/** The pixels of a picture, for the comparison of two fragments. */
const pixels = async (bytes) => {
    const frame = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return frame.data;
};

/** A work dir with a level reference and the crop the decompose stage made of it. */
const repairDir = async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-rectify-repair-'));
    await mkdir(path.join(root, 'decomposition', 'extended'), { recursive: true });
    await mkdir(path.join(root, 'decomposition', 'screens'), { recursive: true });
    await writeFile(path.join(root, REFERENCE_REL), await lines());
    await writeFile(path.join(root, SCREEN_REL), await lines());
    return root;
};

/**
 * The editor of the repair tests.
 *
 * The answer is the picture the editor paints its fragment with.
 */
const mockEditor = (answers, edits = []) => ({
    images: {
        edit: async (params) => {
            edits.push(params);
            const bytes = typeof answers === 'function' ? await answers(edits.length) : await answers;
            return { images: [{ bytes, mime: 'image/png' }] };
        },
        generate: async () => ({ images: [] }),
    },
});

/** The state of the ai-mode for the repair: one pass, one region. */
const repairState = (root, roles, client, maxPasses = 1) => {
    const state = aiState(root, roles, { client });
    state.config.stages.rectify.maxRepairPasses = maxPasses;
    return state;
};

test('the region of the screen is mapped back onto the reference', () => {
    // A rectangle in the reference: the mapping is a translation.
    const quad = { tl: { x: 20, y: 30 }, tr: { x: 120, y: 30 }, br: { x: 120, y: 80 }, bl: { x: 20, y: 80 } };
    const mapped = mapBoxToReference(quad, { width: 100, height: 50 }, { x: 0, y: 0, width: 100, height: 50 });
    assert.ok(mapped, 'the corners are mapped');
    for (const [index, point] of mapped.entries()) {
        const wanted = [[20, 30], [120, 30], [20, 80], [120, 80]][index];
        assert.ok(Math.abs(point.x - wanted[0]) < 0.01, `x of the corner ${index}: ${point.x}`);
        assert.ok(Math.abs(point.y - wanted[1]) < 0.01, `y of the corner ${index}: ${point.y}`);
    }
    // A quad that cannot be used is refused, not guessed.
    assert.equal(mapBoxToReference(null, { width: 10, height: 10 }, { x: 0, y: 0, width: 1, height: 1 }), null);
    assert.equal(mapBoxToReference({ tl: { x: 0, y: 0 } }, { width: 10, height: 10 }, { x: 0, y: 0, width: 1, height: 1 }), null);
});

/** The mean of one channel of a picture. */
const channelMean = (data, channel) => {
    let sum = 0;
    for (let i = channel; i < data.length; i += 4) sum += data[i];
    return sum / (data.length / 4);
};

test('the AI repairs a broken region of the screen', async () => {
    const root = await repairDir();
    try {
        const edits = [];
        const client = mockEditor(await solid(20, 20, 220), edits);
        const roles = mockRolesByName((name, index) => {
            if (name === 'rectifier') return collageAnswer;
            if (name === 'restorerVerify') return { verdict: 'better', reason: 'the seam is gone' };
            // Only the first screen of the collage is broken.
            return index === 0 ? repairPlan('screen') : { verdict: 'clean', assessment: 'nothing is broken', patches: [] };
        });
        const state = repairState(root, roles, client);
        await runRectifyAi(state, () => {});

        // The geometry cut the screens out of the reference, and the repair worked on that cut.
        const repaired = `decomposition/${REPAIRED_DIR}/01-home.png`;
        assert.equal(state.screens[0].subReference, repaired);
        assert.equal(state.screensFiles[0].rel, repaired);
        assert.equal(edits.length, 1, 'the editor is asked once');
        const frame = await sharp(edits[0].image.bytes).metadata();
        assert.equal(frame.width, 82, 'the fragment is the box with its margin');
        assert.equal(frame.height, 72);

        // The answer of the editor is stitched into exactly its box, and the rest of the screen
        // keeps the pixels of the cut.
        const screen = await sharp(path.join(root, RECT_REL)).raw().toBuffer({ resolveWithObject: true });
        const box = { left: 0, top: 0, width: 82, height: 72 };
        const inBox = await sharp(screen.data, {
            raw: { width: screen.info.width, height: screen.info.height, channels: 4 },
        }).extract(box).raw().toBuffer();
        const patched = await sharp(path.join(root, repaired)).raw().toBuffer({ resolveWithObject: true });
        const patchedBox = await sharp(patched.data, {
            raw: { width: patched.info.width, height: patched.info.height, channels: 4 },
        }).extract(box).raw().toBuffer();
        assert.ok(channelMean(patchedBox, 2) > 200, 'the answer of the editor is in the box');
        assert.ok(channelMean(inBox, 2) < 200, 'the box was grey before the repair');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the fragment of a region can come from the reference', async () => {
    const root = await repairDir();
    try {
        const edits = [];
        // The first answer paints a region blue, the second one paints another region green.
        const client = mockEditor(async (n) => (
            n === 1 ? await solid(20, 20, 220) : await solid(20, 220, 20)
        ), edits);
        let asked = 0;
        const roles = mockRolesByName((name) => {
            if (name === 'rectifier') return collageAnswer;
            if (name === 'restorerVerify') return { verdict: 'better', reason: 'the seam is gone' };
            asked += 1;
            // The first pass takes the pixels of the screen, the second one takes them from the
            // reference: the region of the second pass overlaps the paint of the first one.
            if (asked === 1) return repairPlan('screen');
            if (asked === 2) return repairPlan('reference', { x: 70, y: 45, width: 20, height: 20 });
            return { verdict: 'clean', assessment: 'nothing is broken', patches: [] };
        });
        const state = repairState(root, roles, client, 2);
        await runRectifyAi(state, () => {});

        assert.equal(edits.length, 2, 'the editor is asked twice');

        // The frame of the screen the geometry cut, and the boxes the two regions were cut with.
        const screenFile = path.join(root, RECT_REL);
        const frame = await sharp(screenFile).metadata();
        const boxOf = (region) => planFragment(region, {
            frameWidth: frame.width,
            frameHeight: frame.height,
            margin: state.config.stages.rectify.boxPadding,
        });
        const first = boxOf({ x: 10, y: 10, width: 50, height: 40 });
        const second = boxOf({ x: 70, y: 45, width: 20, height: 20 });

        // The first fragment comes from the screen itself: it is the cut of the geometry.
        const fromScreen = path.join(root, 'decomposition', 'from-screen.png');
        await rasterCrop({
            input: screenFile,
            output: fromScreen,
            x: first.x,
            y: first.y,
            width: first.width,
            height: first.height,
            cwd: root,
            engine: 'sharp',
        });
        assert.deepEqual(await pixels(edits[0].image.bytes), await pixels(await readFile(fromScreen)),
            'the first fragment is the region of the screen');

        // The second fragment comes from the reference, not from the screen: the screen holds the
        // blue paint of the first pass in that place, and the fragment of the reference is grey.
        const fragment = await pixels(edits[1].image.bytes);
        const coloured = [];
        for (let i = 0; i < fragment.length; i += 4) {
            if (Math.abs(fragment[i] - fragment[i + 2]) > 8) coloured.push(i);
        }
        assert.deepEqual(coloured, [], 'the fragment of the reference has no paint of the screen');

        // And it is exactly the region of the reference the mapping points at.
        const mapped = mapBoxToReference(
            COLLAGE_QUADS[0],
            { width: frame.width, height: frame.height },
            second,
        );
        assert.ok(mapped, 'the corners of the region are mapped');
        const expected = path.join(root, 'decomposition', 'expected-fragment.png');
        await perspectiveRectify({
            input: path.join(root, REFERENCE_REL),
            output: expected,
            quad: mapped,
            outputSize: { width: second.width, height: second.height },
            cwd: root,
            engine: 'sharp',
        });
        assert.deepEqual(fragment, await pixels(await readFile(expected)),
            'the fragment is the region of the reference');

        // Both paints landed: the blue one of the first pass and the green one of the second.
        const repaired = path.join(root, 'decomposition', REPAIRED_DIR, '01-home.png');
        const result = await sharp(repaired).raw().toBuffer({ resolveWithObject: true });
        const at = async (left, top, width, height) => await sharp(result.data, {
            raw: { width: result.info.width, height: result.info.height, channels: 4 },
        }).extract({ left, top, width, height }).raw().toBuffer();
        const blue = await at(5, 5, 30, 15);
        const green = await at(85, 30, 20, 20);
        assert.ok(channelMean(blue, 2) > 150, 'the blue paint of the first pass is there');
        assert.ok(channelMean(green, 1) > 150, 'the green paint of the second pass is there');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a repair that is not better is thrown away', async () => {
    const root = await repairDir();
    try {
        const client = mockEditor(await solid(20, 20, 220));
        const roles = mockRolesByName((name, index) => {
            if (name === 'rectifier') return collageAnswer;
            if (name === 'restorerVerify') return { verdict: 'worse', reason: 'the lettering was redrawn' };
            return index === 0 ? repairPlan('screen') : { verdict: 'clean', assessment: 'nothing is broken', patches: [] };
        });
        const state = repairState(root, roles, client);
        await runRectifyAi(state, () => {});

        assert.match(state.warnings.join('\n'), /refused by the verification/);
        assert.equal(state.screens[0].subReference, RECT_REL, 'the screen keeps the bytes it had');
        const files = await readdir(path.join(root, 'decomposition', REPAIRED_DIR)).catch(() => []);
        assert.deepEqual(files, [], 'no repaired file is written');
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
