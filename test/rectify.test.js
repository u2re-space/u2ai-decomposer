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
    producedScreens,
    runRectify,
    swapReferencePaths,
    validateRectifiedFile,
    RECTIFIED_DIR,
} from '../src/stages/rectify.js';
import { defaults, validateConfig } from '../src/config.js';

const SCREEN_REL = 'decomposition/screens/01-home.png';
const RECT_REL = `decomposition/${RECTIFIED_DIR}/01-home.png`;

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
        assert.equal(accepted.to, `decomposition/${RECTIFIED_DIR}/02-home.png`, state.warnings.join('; '));
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
