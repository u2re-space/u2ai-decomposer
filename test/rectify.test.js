/**
 * @file test/rectify.test.js
 * @purpose Tests of the rectify stage: the projection the role asks for, the measurement that
 *          judges it, the re-correct and split passes, and the state the next stage reads.
 * @depends node:test, stages/rectify, image/skew
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

import {
    acceptsRectification,
    cropOfReference,
    producedScreens,
    projectQuad,
    quadCorners,
    runRectify,
    screenFileName,
    swapReferencePaths,
    validateRectifiedFile,
    RECTIFIED_DIR,
} from '../src/stages/rectify.js';
import { defaults, validateConfig } from '../src/config.js';
import { measureResidualSkew } from '../src/image/skew.js';

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

const stateFor = (root, roles, overrides = {}) => ({
    root,
    workDir: 'decomposition',
    images: [SCREEN_REL],
    screens: [{ name: 'home', source: 'reference.png', subReference: SCREEN_REL, subReferenceKind: 'crop' }],
    screensFiles: [{ rel: SCREEN_REL, screen: 'home', kind: 'crop', source: 'reference.png', note: '' }],
    config: {
        model: 'vendor/vision',
        roles: {},
        image: { maxSide: 1536, maxMegapixels: 100 },
        limits: { maxImageBytes: 8 * 1024 * 1024 },
        raster: { engine: 'sharp' },
        tools: {},
        stages: {
            rectify: {
                enabled: true,
                maxTurns: 24,
                maxSplitTurns: 32,
                maxAttempts: 2,
                residualSkewLimitDeg: 0.8,
                minImprovementDeg: 0.4,
                // The review of the cut is a stage of its own: the tests that count the calls of
                // the role turn it off, and the tests of the review turn it on.
                review: false,
            },
        },
    },
    client: { images: null },
    roles,
    model: null,
    effort: null,
    imageModel: null,
    warnings: [],
    rectified: [],
    restored: [],
    overlapResolved: [],
    ...overrides,
});

const mockRoles = (answers, calls = []) => ({
    resolve: () => ({ instructions: 'You are the rectifier.' }),
    async run(name, params) {
        calls.push({ name, params });
        const answer = Array.isArray(answers) ? answers[Math.min(calls.length - 1, answers.length - 1)] : answers;
        return { status: 'completed', data: answer, text: '', toolCalls: [], usage: null, error: null };
    },
});

/** A work dir with the screen the decompose stage produced. */
const workDirWith = async (screen = 0) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-rectify-'));
    await mkdir(path.join(root, 'decomposition', 'screens'), { recursive: true });
    await writeFile(path.join(root, 'decomposition', 'screens', '01-home.png'), await stripes(screen));
    return root;
};

// ---------------------------------------------------------------------------
// The rule that judges a projection
// ---------------------------------------------------------------------------

test('a copy is kept only when the tilt really went down', () => {
    const skew = (angleDeg, confidence = 0.9) => ({ angleDeg, confidence, best: 10, flat: 1 });
    assert.equal(acceptsRectification(skew(8), skew(0.2)).ok, true, 'levelled');
    assert.equal(acceptsRectification(skew(8), skew(6)).ok, true, 'improved');
    const stalled = acceptsRectification(skew(8), skew(7.9));
    assert.equal(stalled.ok, false, 'a projection that barely moved the tilt is a wasted resampling');
    assert.match(stalled.reason, /not enough improvement/);
    const worse = acceptsRectification(skew(2), skew(9));
    assert.equal(worse.ok, false);
    assert.match(worse.reason, /9\.0/);
    assert.equal(acceptsRectification(skew(8, 0.05), skew(5, 0.05)).ok, true,
        'a frame without measurable boundaries is not judged by the measurement');
});

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

test('the corners of an answer are read in the order the projection wants', () => {
    const quad = { tl: { x: 1, y: 2 }, tr: { x: 3, y: 4 }, br: { x: 5, y: 6 }, bl: { x: 7, y: 8 } };
    assert.deepEqual(quadCorners(quad), [
        { x: 1, y: 2 }, { x: 3, y: 4 }, { x: 7, y: 8 }, { x: 5, y: 6 },
    ]);
    assert.equal(quadCorners(null), null);
    assert.equal(quadCorners({ tl: { x: 1, y: 2 } }), null);
    assert.equal(quadCorners({ ...quad, br: { x: 'x', y: 6 } }), null);
});

test('the file of a screen is named after the screen', () => {
    assert.equal(screenFileName('Home Screen', 0), '01-home-screen.png');
    assert.equal(screenFileName('Ünïcode!', 2), '03-n-code.png');
    assert.equal(screenFileName('', 0), '01-screen.png');
});

test('the stage projects the corners itself when the role wrote no file', async () => {
    const root = await workDirWith();
    try {
        const outDir = path.join(root, 'decomposition', 'rectified');
        await mkdir(outDir, { recursive: true });
        const written = await projectQuad({
            source: path.join(root, 'decomposition', 'screens', '01-home.png'),
            outDir,
            label: 'home',
            quad: { tl: { x: 20, y: 20 }, tr: { x: 300, y: 20 }, br: { x: 300, y: 220 }, bl: { x: 20, y: 220 } },
            index: 0,
            cwd: root,
            engine: 'sharp',
        });
        assert.ok(written, 'the projection is written');
        assert.equal(path.basename(written), '01-home.png');
        assert.equal((await stat(written)).isFile(), true);
        const frame = await sharp(written).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        assert.equal(frame.info.width > 0, true);
        // A quad without corners cannot be projected.
        assert.equal(await projectQuad({
            source: path.join(root, 'decomposition', 'screens', '01-home.png'),
            outDir,
            label: 'home',
            quad: null,
            index: 0,
            cwd: root,
            engine: 'sharp',
        }), null);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the rectifier role gets the projection tool and the output directory', async () => {
    const root = await workDirWith();
    try {
        const calls = [];
        const state = stateFor(root, mockRoles({ verdict: 'keep', assessment: 'flat', screens: [] }, calls));
        await runRectify(state, () => {});
        assert.equal(calls.length, 1);
        assert.equal(calls[0].name, 'rectifier');
        const names = (calls[0].params.extraTools ?? []).map((spec) => spec.name);
        assert.ok(names.includes('correct_perspective'), names.join(', '));
        assert.ok(names.includes('view_image'), names.join(', '));
        for (const forbidden of ['crop_image', 'write_file', 'generate_image', 'edit_image']) {
            assert.ok(!names.includes(forbidden), `${forbidden} is not geometry`);
        }
        assert.match(calls[0].params.text, /decomposition\/rectified/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a flat reference is left exactly where it was', async () => {
    const root = await workDirWith();
    try {
        const state = stateFor(root, mockRoles({ verdict: 'keep', assessment: 'flat export', screens: [] }));
        await runRectify(state, () => {});
        assert.equal(state.rectified.length, 1);
        assert.equal(state.rectified[0].kept, true);
        assert.match(state.rectified[0].reason, /flat export/);
        assert.deepEqual(state.images, [SCREEN_REL]);
        assert.equal(state.screens[0].subReference, SCREEN_REL);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a corrected file replaces the reference', async () => {
    const root = await workDirWith(2);
    try {
        await mkdir(path.join(root, 'decomposition', RECTIFIED_DIR), { recursive: true });
        await writeFile(path.join(root, 'decomposition', RECTIFIED_DIR, '01-home.png'), await stripes(0));
        const state = stateFor(root, mockRoles({
            verdict: 'rectified',
            assessment: 'a photo at an angle',
            screens: [{ label: 'home', output: RECT_REL, quad: null }],
        }));
        await runRectify(state, () => {});
        const accepted = state.rectified.find((item) => item.to);
        assert.equal(accepted.to, RECT_REL, state.warnings.join('; '));
        assert.equal(accepted.from, SCREEN_REL);
        assert.equal(accepted.screen, 'home', 'the label travels — it is what names the screen later');
        assert.equal(state.screens[0].subReference, RECT_REL);
        assert.equal(state.screens[0].subReferenceKind, 'restored');
        assert.deepEqual(state.images, [RECT_REL]);
        assert.equal(state.screensFiles[0].rel, RECT_REL);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a file outside the output directory is not the result', async () => {
    const root = await workDirWith();
    try {
        await writeFile(path.join(root, 'elsewhere.png'), await stripes(0));
        const state = stateFor(root, mockRoles({
            verdict: 'rectified',
            assessment: '',
            screens: [{ label: 'home', output: 'elsewhere.png', quad: null }],
        }));
        await runRectify(state, () => {});
        assert.equal(state.rectified.find((item) => item.to), undefined);
        assert.match(state.warnings.join('\n'), /outside the output directory/);
        assert.deepEqual(state.images, [SCREEN_REL]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a result that is not flatter than the source is deleted', async () => {
    const root = await workDirWith(2);
    try {
        await mkdir(path.join(root, 'decomposition', RECTIFIED_DIR), { recursive: true });
        const bad = path.join(root, 'decomposition', RECTIFIED_DIR, '01-home.png');
        await writeFile(bad, await stripes(8));
        const state = stateFor(root, mockRoles({
            verdict: 'rectified',
            assessment: '',
            screens: [{ label: 'home', output: RECT_REL, quad: null }],
        }));
        await runRectify(state, () => {});
        assert.equal(state.rectified.find((item) => item.to), undefined);
        assert.match(state.warnings.join('\n'), /not enough improvement/);
        assert.equal(await stat(bad).catch(() => null), null, 'the refused file is deleted');
        assert.deepEqual(state.images, [SCREEN_REL]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the re-correct pass asks again when the tilt did not go down', async () => {
    const root = await workDirWith(2);
    try {
        const rectDir = path.join(root, 'decomposition', RECTIFIED_DIR);
        await mkdir(rectDir, { recursive: true });
        await writeFile(path.join(rectDir, '01-home.png'), await stripes(8));
        await writeFile(path.join(rectDir, '02-home.png'), await stripes(0));
        const calls = [];
        const state = stateFor(root, mockRoles([
            { verdict: 'rectified', assessment: '', screens: [{ label: 'home', output: RECT_REL, quad: null }] },
            { verdict: 'rectified', assessment: '', screens: [{ label: 'home', output: `decomposition/${RECTIFIED_DIR}/02-home.png`, quad: null }] },
        ], calls));
        await runRectify(state, () => {});
        assert.equal(calls.length, 2, 'the role is asked once more');
        assert.match(calls[1].params.text, /still measured/);
        const accepted = state.rectified.find((item) => item.to);
        // The screen keeps its canonical name, whatever the file the role happened to write.
        assert.equal(accepted.to, RECT_REL, state.warnings.join('; '));
        const frame = await sharp(path.join(root, accepted.to)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        assert.equal(frame.info.width, 320);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the split pass cuts a picture the role could not separate', async () => {
    const root = await workDirWith();
    try {
        const rectDir = path.join(root, 'decomposition', RECTIFIED_DIR);
        await mkdir(rectDir, { recursive: true });
        await writeFile(path.join(rectDir, '01-home.png'), await stripes(0));
        const calls = [];
        const state = stateFor(root, mockRoles([
            { verdict: 'unresolved', assessment: 'three screens in one picture', screens: [] },
            { verdict: 'rectified', assessment: '', screens: [{ label: 'home', output: RECT_REL, quad: null }] },
        ], calls));
        await runRectify(state, () => {});
        assert.equal(calls.length, 2, 'the role is asked once more');
        assert.equal(calls[1].params.maxTurns, 32, 'the split pass gets the split budget');
        assert.match(calls[1].params.text, /screen by screen/);
        assert.equal(state.rectified.find((item) => item.to)?.to, RECT_REL);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a collage becomes one screen per produced file', async () => {
    const root = await workDirWith();
    try {
        const rectDir = path.join(root, 'decomposition', RECTIFIED_DIR);
        await mkdir(rectDir, { recursive: true });
        await writeFile(path.join(rectDir, '01-a.png'), await stripes(0));
        await writeFile(path.join(rectDir, '02-b.png'), await stripes(0));
        const state = stateFor(root, mockRoles({
            verdict: 'rectified',
            assessment: '',
            screens: [
                { label: 'a', output: `decomposition/${RECTIFIED_DIR}/01-a.png`, quad: null },
                { label: 'b', output: `decomposition/${RECTIFIED_DIR}/02-b.png`, quad: null },
            ],
        }));
        await runRectify(state, () => {});
        assert.equal(state.screens.length, 2);
        assert.deepEqual(state.screens.map((screen) => screen.name), ['a', 'b']);
        assert.deepEqual(state.images, [
            `decomposition/${RECTIFIED_DIR}/01-a.png`,
            `decomposition/${RECTIFIED_DIR}/02-b.png`,
        ]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// The collage is cut out of the reference
// ---------------------------------------------------------------------------

/** A work dir with a reference and a crop the decompose stage made of it. */
const collageDir = async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-rectify-collage-'));
    await mkdir(path.join(root, 'decomposition', 'extended'), { recursive: true });
    await mkdir(path.join(root, 'decomposition', 'screens'), { recursive: true });
    await writeFile(path.join(root, REFERENCE_REL), await stripes(0));
    await writeFile(path.join(root, SCREEN_REL), await stripes(0));
    return root;
};

const collageState = (root, roles, overrides = {}) => stateFor(root, roles, {
    images: [SCREEN_REL],
    references: [REFERENCE_REL],
    screens: [{ name: 'home', source: REFERENCE_REL, subReference: SCREEN_REL, subReferenceKind: 'crop' }],
    screensFiles: [{
        rel: SCREEN_REL, screen: 'home', kind: 'crop', source: REFERENCE_REL, note: '',
    }],
    ...overrides,
});

test('the reference is cut into screens and the crop of it is replaced', async () => {
    const root = await collageDir();
    try {
        const rectDir = path.join(root, 'decomposition', RECTIFIED_DIR);
        await mkdir(rectDir, { recursive: true });
        await writeFile(path.join(rectDir, '01-a.png'), await stripes(0));
        await writeFile(path.join(rectDir, '02-b.png'), await stripes(0));
        const calls = [];
        const state = collageState(root, mockRoles({
            verdict: 'rectified',
            assessment: 'three phones in one picture',
            screens: [
                { label: 'a', output: `decomposition/${RECTIFIED_DIR}/01-a.png`, quad: null },
                { label: 'b', output: `decomposition/${RECTIFIED_DIR}/02-b.png`, quad: null },
            ],
        }, calls));
        await runRectify(state, () => {});

        assert.equal(calls.length, 1, 'the role is asked about the reference, not about the crop');
        assert.match(calls[0].params.text, new RegExp(REFERENCE_REL.replace(/[/.]/g, '\\$&')));
        assert.deepEqual(state.screens.map((screen) => screen.name), ['a', 'b']);
        assert.deepEqual(state.images, [
            `decomposition/${RECTIFIED_DIR}/01-a.png`,
            `decomposition/${RECTIFIED_DIR}/02-b.png`,
        ]);
        // The crop is the screen the reference was cut from: it points at the same files.
        const fromCrop = state.rectified.filter((item) => item.from === SCREEN_REL);
        assert.equal(fromCrop.length, 2);
        assert.deepEqual(fromCrop.map((item) => item.to), [
            `decomposition/${RECTIFIED_DIR}/01-a.png`,
            `decomposition/${RECTIFIED_DIR}/02-b.png`,
        ]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the crop is worked on when the reference cannot be cut', async () => {
    const root = await collageDir();
    try {
        const rectDir = path.join(root, 'decomposition', RECTIFIED_DIR);
        await mkdir(rectDir, { recursive: true });
        await writeFile(path.join(rectDir, '01-home.png'), await stripes(0));
        const calls = [];
        const state = collageState(root, mockRoles([
            { verdict: 'unresolved', assessment: 'cannot cut it', screens: [] },
            { verdict: 'unresolved', assessment: 'cannot cut it', screens: [] },
            { verdict: 'rectified', assessment: '', screens: [{ label: 'home', output: RECT_REL, quad: null }] },
        ], calls));
        await runRectify(state, () => {});
        assert.ok(calls.length >= 2, 'the role is asked again');
        assert.match(calls[calls.length - 1].params.text, new RegExp(SCREEN_REL.replace(/[/.]/g, '\\$&')));
        assert.equal(state.screens[0].subReference, RECT_REL);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a sub-reference that carries work of its own is not a crop of the reference', () => {
    const references = [{ rel: 'decomposition/extended/app.png' }];
    assert.equal(cropOfReference({ rel: 'a.png', kind: 'crop', source: 'decomposition/extended/app.png' }, references)?.rel,
        'decomposition/extended/app.png');
    assert.equal(cropOfReference({ rel: 'a.png', kind: 'crop', source: 'app.png' }, references)?.rel,
        'decomposition/extended/app.png');
    assert.equal(cropOfReference({ rel: 'a.png', kind: 'regenerated', source: 'decomposition/extended/app.png' }, references),
        null);
    assert.equal(cropOfReference({ rel: 'a.png', kind: 'crop', source: 'other.png' }, references), null);
    assert.equal(cropOfReference(null, references), null);
});

// ---------------------------------------------------------------------------
// The review of the cut
// ---------------------------------------------------------------------------

/** A state whose rectify stage reviews its own cut. */
const reviewState = (root, roles) => {
    const state = stateFor(root, roles);
    state.config.stages.rectify.review = true;
    return state;
};

test('the role looks at its own cut and cuts it again when it lost its edges', async () => {
    const root = await workDirWith();
    try {
        const calls = [];
        const state = reviewState(root, mockRoles([
            // The first answer: a cut that is too narrow.
            {
                verdict: 'rectified',
                assessment: 'three phones',
                screens: [{
                    label: 'home',
                    output: '',
                    quad: { tl: { x: 40, y: 40 }, tr: { x: 240, y: 40 }, br: { x: 240, y: 200 }, bl: { x: 40, y: 200 } },
                }],
            },
            // The review: the screen was cut off, here are wider corners.
            {
                verdict: 'recut',
                assessment: 'the left edge of the display was cut off',
                screens: [{
                    label: 'home',
                    output: '',
                    quad: { tl: { x: 10, y: 10 }, tr: { x: 300, y: 10 }, br: { x: 300, y: 230 }, bl: { x: 10, y: 230 } },
                }],
            },
        ], calls));

        await runRectify(state, () => {});

        assert.equal(calls.length, 2, 'the role is asked about the cut it made');
        assert.equal(calls[1].params.schemaName, 'rectifyReview');
        assert.equal(calls[1].params.parts.length, 2, 'the reference and the cut are both in the answer');
        assert.match(calls[1].params.text, /cut off/i);

        const accepted = state.rectified.find((item) => item.to);
        assert.ok(accepted, state.warnings.join('; '));
        const frame = await sharp(path.join(root, accepted.to)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        assert.equal(frame.info.width, 290, 'the re-cut is the wide one');
        assert.equal(frame.info.height, 220);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a re-cut that is smaller than the cut it replaces is refused', async () => {
    const root = await workDirWith();
    try {
        const calls = [];
        const state = reviewState(root, mockRoles([
            {
                verdict: 'rectified',
                assessment: 'three phones',
                screens: [{
                    label: 'home',
                    output: '',
                    quad: { tl: { x: 40, y: 40 }, tr: { x: 240, y: 40 }, br: { x: 240, y: 200 }, bl: { x: 40, y: 200 } },
                }],
            },
            {
                verdict: 'recut',
                assessment: 'the screen was cut off',
                screens: [{
                    label: 'home',
                    output: '',
                    quad: { tl: { x: 60, y: 60 }, tr: { x: 200, y: 60 }, br: { x: 200, y: 180 }, bl: { x: 60, y: 180 } },
                }],
            },
        ], calls));

        await runRectify(state, () => {});

        const accepted = state.rectified.find((item) => item.to);
        const frame = await sharp(path.join(root, accepted.to)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        assert.equal(frame.info.width, 200, 'the first cut stays');
        assert.match(state.warnings.join(' '), /smaller than the cut it replaces/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a cut the role is happy with stays as it is', async () => {
    const root = await workDirWith();
    try {
        const calls = [];
        const state = reviewState(root, mockRoles([
            {
                verdict: 'rectified',
                assessment: 'three phones',
                screens: [{
                    label: 'home',
                    output: '',
                    quad: { tl: { x: 40, y: 40 }, tr: { x: 240, y: 40 }, br: { x: 240, y: 200 }, bl: { x: 40, y: 200 } },
                }],
            },
            { verdict: 'ok', assessment: 'every screen is complete', screens: [] },
        ], calls));

        await runRectify(state, () => {});

        assert.equal(calls.length, 2);
        const accepted = state.rectified.find((item) => item.to);
        const frame = await sharp(path.join(root, accepted.to)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        assert.equal(frame.info.width, 200, 'the first cut stays');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// The attempts of a screen
// ---------------------------------------------------------------------------

test('the best result wins and a worse one is rolled back', async () => {
    const root = await workDirWith(8);
    try {
        const rectDir = path.join(root, 'decomposition', RECTIFIED_DIR);
        await mkdir(rectDir, { recursive: true });
        await writeFile(path.join(rectDir, '01-home.png'), await stripes(4));
        await writeFile(path.join(rectDir, '02-home.png'), await stripes(5));
        const calls = [];
        const state = stateFor(root, mockRoles([
            { verdict: 'rectified', assessment: '', screens: [{ label: 'home', output: RECT_REL, quad: null }] },
            { verdict: 'rectified', assessment: '', screens: [{ label: 'home', output: `decomposition/${RECTIFIED_DIR}/02-home.png`, quad: null }] },
        ], calls));
        state.config.stages.rectify.maxAttempts = 3;
        await runRectify(state, () => {});
        assert.equal(calls.length, 2, 'a screen that did not get any better stops asking');
        assert.match(state.warnings.join('\n'), /not better than the result of the previous attempt/);
        const accepted = state.rectified.find((item) => item.to);
        assert.equal(accepted.to, RECT_REL);
        // The screen keeps the flatter result, not the one that came later.
        const skew = await measureResidualSkew(path.join(root, accepted.to), { maxSide: 900, maxAngleDeg: 15, stepDeg: 0.1 });
        assert.ok(Math.abs(skew.angleDeg - 4) < 0.5, `the better result is kept (${skew.angleDeg}°)`);
        assert.equal(await stat(path.join(rectDir, '02-home.png')).catch(() => null), null,
            'the worse result is deleted');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a screen that is level is not asked again', async () => {
    const root = await workDirWith();
    try {
        const rectDir = path.join(root, 'decomposition', RECTIFIED_DIR);
        await mkdir(rectDir, { recursive: true });
        await writeFile(path.join(rectDir, '01-home.png'), await stripes(0));
        const calls = [];
        const state = stateFor(root, mockRoles({
            verdict: 'rectified',
            assessment: '',
            screens: [{ label: 'home', output: RECT_REL, quad: null }],
        }, calls));
        state.config.stages.rectify.maxAttempts = 3;
        await runRectify(state, () => {});
        assert.equal(calls.length, 1, 'there is nothing left to improve');
        assert.equal(state.rectified.find((item) => item.to)?.to, RECT_REL);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the re-cut takes a part of the same budget', async () => {
    const root = await workDirWith();
    try {
        const calls = [];
        const state = reviewState(root, mockRoles([
            {
                verdict: 'rectified',
                assessment: 'three phones',
                screens: [{
                    label: 'home',
                    output: '',
                    quad: { tl: { x: 40, y: 40 }, tr: { x: 240, y: 40 }, br: { x: 240, y: 200 }, bl: { x: 40, y: 200 } },
                }],
            },
            {
                verdict: 'recut',
                assessment: 'the screen was cut off',
                screens: [{
                    label: 'home',
                    output: '',
                    quad: { tl: { x: 10, y: 10 }, tr: { x: 300, y: 10 }, br: { x: 300, y: 230 }, bl: { x: 10, y: 230 } },
                }],
            },
        ], calls));
        state.config.stages.rectify.maxAttempts = 1;
        await runRectify(state, () => {});
        assert.match(state.warnings.join('\n'), /the re-cut was not tried/);
        const accepted = state.rectified.find((item) => item.to);
        const frame = await sharp(path.join(root, accepted.to)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        assert.equal(frame.info.width, 200, 'the first cut stays');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// The helpers
// ---------------------------------------------------------------------------

test('the file list is read from screens, and an older single-file answer still counts', () => {
    assert.deepEqual(producedScreens({ screens: [{ label: 'home', output: 'a.png', quad: null }] }),
        [{ label: 'home', output: 'a.png', quad: null }]);
    assert.deepEqual(producedScreens({ screens: [{ label: 'home', output: '  ' }] }), []);
    assert.deepEqual(producedScreens({ verdict: 'keep', screens: [] }), []);
    assert.deepEqual(producedScreens(null), []);
    assert.deepEqual(producedScreens({ verdict: 'rectified', output: 'b.png', quad: { tl: 1 } }),
        [{ label: '', output: 'b.png', quad: { tl: 1 } }]);
});

test('a produced file is only a result when it is inside the output directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-rectify-out-'));
    try {
        const outputDir = path.join(root, RECTIFIED_DIR);
        await mkdir(outputDir, { recursive: true });
        await writeFile(path.join(outputDir, 'ok.png'), await stripes(0));
        await writeFile(path.join(outputDir, 'empty.png'), Buffer.alloc(0));
        assert.equal((await validateRectifiedFile(path.join(outputDir, 'ok.png'), outputDir)).ok, true);
        assert.match((await validateRectifiedFile(path.join(root, 'elsewhere.png'), outputDir)).reason,
            /outside the output directory/);
        assert.match((await validateRectifiedFile(path.join(outputDir, 'missing.png'), outputDir)).reason,
            /not found/);
        assert.match((await validateRectifiedFile(path.join(outputDir, 'empty.png'), outputDir)).reason,
            /empty/);
        assert.match((await validateRectifiedFile('', outputDir)).reason, /no path/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the replacement keeps the index it replaces', () => {
    const paths = ['a.png', 'b.png', 'c.png'];
    const { paths: next, swapped } = swapReferencePaths(paths, [
        { from: 'b.png', to: 'rectified/b.png' },
        { from: 'not-a-reference.png', to: 'rectified/x.png' },
    ]);
    assert.deepEqual(next, ['a.png', 'rectified/b.png', 'c.png']);
    assert.deepEqual(swapped, [{ from: 'b.png', to: 'rectified/b.png' }]);
    assert.deepEqual(swapReferencePaths(paths, []).paths, paths);
});

test('one source may become several files', () => {
    const { paths } = swapReferencePaths(['collage.png', 'other.png'], [
        { from: 'collage.png', to: 'rectified/a.png' },
        { from: 'collage.png', to: 'rectified/b.png' },
    ]);
    assert.deepEqual(paths, ['rectified/a.png', 'rectified/b.png', 'other.png']);
});

// ---------------------------------------------------------------------------
// The config
// ---------------------------------------------------------------------------

test('the rectify section of the config accepts the tilt limits', () => {
    const config = structuredClone(defaults);
    config.stages.rectify.residualSkewLimitDeg = 1.2;
    config.stages.rectify.minImprovementDeg = 0.5;
    config.stages.rectify.maxAttempts = 3;
    assert.doesNotThrow(() => validateConfig(config));
    config.stages.rectify.residualSkewLimitDeg = 'flat';
    assert.throws(() => validateConfig(config), /residualSkewLimitDeg/);
});

test('the rectify section of the config accepts the mode and the ai-mode knobs', () => {
    const config = structuredClone(defaults);
    config.stages.rectify.mode = 'ai-mode';
    config.stages.rectify.maxRepairPasses = 2;
    config.stages.rectify.maxPatches = 3;
    config.stages.rectify.boxPadding = 16;
    config.stages.rectify.straightenAttempts = 1;
    config.stages.rectify.cleanOverlap = true;
    config.stages.rectify.quality = 'low';
    assert.doesNotThrow(() => validateConfig(config));
    config.stages.rectify.mode = 'magic';
    assert.throws(() => validateConfig(config), /stages\.rectify\.mode/);
    config.stages.rectify.mode = 'ai-mode';
    config.stages.rectify.maxRepairPasses = 1.5;
    assert.throws(() => validateConfig(config), /maxRepairPasses/);
});
