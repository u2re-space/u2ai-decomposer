/**
 * @file test/overlap.test.js
 * @purpose Tests of the overlap stage: the comparison of the screens, the refusal of a region
 *          that is not a region of this screen, and the cleaning of a region that is.
 * @depends node:test, stages/overlap, stages/restore-plan
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

import { runOverlap } from '../src/stages/overlap.js';
import { EDITOR_FRAME } from '../src/stages/restore-plan.js';
import { defaults, validateConfig } from '../src/config.js';

const HOME_REL = 'decomposition/screens/01-home.png';
const ABOUT_REL = 'decomposition/screens/02-about.png';

/** A picture of horizontal stripes: the shape the editor would see as content. */
const stripes = async (width = 320, height = 240, tone = 240) => {
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        const on = Math.floor(y / 8) % 2 === 0;
        for (let x = 0; x < width; x++) {
            const at = (y * width + x) * 4;
            data[at] = on ? tone : 20;
            data[at + 1] = on ? tone : 20;
            data[at + 2] = on ? tone : 20;
            data[at + 3] = 255;
        }
    }
    return await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
};

const stateFor = (root, roles, overrides = {}) => ({
    root,
    workDir: 'decomposition',
    images: [HOME_REL, ABOUT_REL],
    screens: [
        { name: 'home', source: 'reference.png', subReference: HOME_REL, subReferenceKind: 'crop' },
        { name: 'about', source: 'reference.png', subReference: ABOUT_REL, subReferenceKind: 'crop' },
    ],
    screensFiles: [
        { rel: HOME_REL, screen: 'home', kind: 'crop', source: 'reference.png', note: '' },
        { rel: ABOUT_REL, screen: 'about', kind: 'crop', source: 'reference.png', note: '' },
    ],
    config: {
        model: 'vendor/vision',
        imageModel: 'vendor/painter',
        roles: {},
        image: { maxSide: 1536, maxMegapixels: 100 },
        limits: { maxImageBytes: 8 * 1024 * 1024 },
        raster: { engine: 'sharp' },
        tools: {},
        stages: {
            overlap: {
                enabled: true,
                maxAttempts: 2,
                boxPadding: 16,
                maxPatches: 3,
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
    resolve: (name) => ({ instructions: `You are the ${name}.` }),
    async run(name, params) {
        calls.push({ name, params });
        const answer = typeof answers === 'function' ? answers(name, calls.length) : answers;
        return { status: 'completed', data: answer, text: '', toolCalls: [], usage: null, error: null };
    },
});

const mockClient = (edit) => ({ images: { edit, generate: async () => ({ images: [] }) } });

/** A work dir with the two screens the decompose stage produced. */
const workDirWith = async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-overlap-'));
    await mkdir(path.join(root, 'decomposition', 'screens'), { recursive: true });
    await writeFile(path.join(root, 'decomposition', 'screens', '01-home.png'), await stripes(320, 240));
    await writeFile(path.join(root, 'decomposition', 'screens', '02-about.png'), await stripes(320, 240, 120));
    return root;
};

const overlapPlan = {
    verdict: 'overlap',
    assessment: 'the navigation bar of the collage stayed in the first screen',
    patches: [{
        screen: 'home',
        kind: 'overlap',
        x: 10,
        y: 10,
        width: 40,
        height: 30,
        finding: 'the strip of the neighbouring screen is visible in the corner',
        prompt: 'remove the strip of the neighbouring screen and continue the background of this screen',
    }],
};

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

test('with less than two screens there is nothing to compare', async () => {
    const root = await workDirWith();
    try {
        const calls = [];
        const state = stateFor(root, mockRoles(overlapPlan, calls), {
            images: [HOME_REL],
            screens: [stateFor(root, mockRoles(overlapPlan)).screens[0]],
            screensFiles: [stateFor(root, mockRoles(overlapPlan)).screensFiles[0]],
        });
        await runOverlap(state, () => {});
        assert.match(state.warnings.join('\n'), /less than two screens/);
        assert.equal(calls.length, 0, 'the role is not asked');
        assert.equal(state.overlapResolved.length, 0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('without the images API the stage is skipped', async () => {
    const root = await workDirWith();
    try {
        const state = stateFor(root, mockRoles(overlapPlan));
        await runOverlap(state, () => {});
        assert.match(state.warnings.join('\n'), /images API unavailable/);
        assert.equal(state.overlapResolved.length, 0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the role sees every screen and may compare them', async () => {
    const root = await workDirWith();
    try {
        const calls = [];
        const client = mockClient(async () => { throw new Error('a clean collage must not reach the editor'); });
        const state = stateFor(root, mockRoles({ verdict: 'clean', assessment: 'every screen owns its content', patches: [] }, calls), { client });
        await runOverlap(state, () => {});
        assert.equal(calls.length, 1);
        assert.equal(calls[0].name, 'overlap');
        assert.equal(calls[0].params.parts.length, 2, 'both screens are attached');
        assert.match(calls[0].params.text, /01-home\.png/);
        assert.match(calls[0].params.text, /02-about\.png/);
        const names = (calls[0].params.extraTools ?? []).map((tool) => tool.name);
        assert.deepEqual(names.sort(), ['compare_images', 'view_image']);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a clean comparison keeps the files as they are', async () => {
    const root = await workDirWith();
    try {
        const client = mockClient(async () => { throw new Error('a clean collage must not reach the editor'); });
        const state = stateFor(root, mockRoles({ verdict: 'clean', assessment: 'every screen owns its content', patches: [] }), { client });
        const events = [];
        await runOverlap(state, (event) => events.push(event));
        assert.equal(state.overlapResolved.length, 2);
        assert.ok(state.overlapResolved.every((item) => item.kept === true));
        assert.deepEqual(state.images, [HOME_REL, ABOUT_REL]);
        assert.equal(state.screens[0].subReference, HOME_REL);
        assert.deepEqual(await readdir(path.join(root, 'decomposition', 'overlap')), [],
            'a clean comparison writes no file');
        assert.deepEqual(events.filter((event) => event.type === 'overlap.done').map((event) => event.count), [0]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a foreign region is cut, cleaned and stitched back into its box', async () => {
    const root = await workDirWith();
    try {
        const edits = [];
        const client = mockClient(async (params) => {
            edits.push(params);
            return { images: [{ bytes: params.image.bytes, mime: 'image/png' }] };
        });
        const state = stateFor(root, mockRoles(overlapPlan), { client });
        const events = [];
        await runOverlap(state, (event) => events.push(event));

        assert.equal(edits.length, 1);
        const fragment = await sharp(edits[0].image.bytes).metadata();
        assert.ok(fragment.width < 320 && fragment.height < 240, 'the editor got the box, not the screen');
        assert.match(edits[0].prompt, /remove the strip of the neighbouring screen/);
        assert.ok(edits[0].prompt.includes(EDITOR_FRAME));
        assert.equal(edits[0].model, 'vendor/painter');

        const cleaned = state.overlapResolved.find((item) => item.to);
        assert.equal(cleaned.from, HOME_REL);
        assert.equal(cleaned.to, 'decomposition/overlap/01-home.png', state.warnings.join('; '));
        assert.equal(cleaned.patches.length, 1);
        assert.equal(cleaned.patches[0].kind, 'overlap');

        const saved = await sharp(path.join(root, 'decomposition', 'overlap', '01-home.png')).metadata();
        assert.deepEqual([saved.width, saved.height], [320, 240], 'the screen keeps its dimensions');
        assert.equal(state.screens[0].subReference, 'decomposition/overlap/01-home.png');
        assert.equal(state.screens[1].subReference, ABOUT_REL, 'the clean screen stays where it was');
        assert.deepEqual(state.images, ['decomposition/overlap/01-home.png', ABOUT_REL]);
        assert.equal(events.filter((event) => event.type === 'overlap.file').length, 1);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a region of an unknown screen is refused', async () => {
    const root = await workDirWith();
    try {
        let calls = 0;
        const client = mockClient(async () => { calls += 1; return { images: [] }; });
        const plan = { ...overlapPlan, patches: [{ ...overlapPlan.patches[0], screen: 'nowhere' }] };
        const state = stateFor(root, mockRoles(plan), { client });
        await runOverlap(state, () => {});
        assert.match(state.warnings.join('\n'), /is not one of the screens/);
        assert.equal(calls, 0, 'the editor is not asked for a region of another screen');
        assert.ok(state.overlapResolved.every((item) => item.kept === true));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a region that leaves the frame is refused', async () => {
    const root = await workDirWith();
    try {
        let calls = 0;
        const client = mockClient(async () => { calls += 1; return { images: [] }; });
        const plan = { ...overlapPlan, patches: [{ ...overlapPlan.patches[0], x: 300, width: 60 }] };
        const state = stateFor(root, mockRoles(plan), { client });
        await runOverlap(state, () => {});
        assert.match(state.warnings.join('\n'), /leaves the frame/);
        assert.equal(calls, 0);
        assert.ok(state.overlapResolved.every((item) => item.kept === true));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('an editor that fails leaves the screen alone', async () => {
    const root = await workDirWith();
    try {
        let calls = 0;
        const client = mockClient(async () => {
            calls += 1;
            throw new Error('the editor is down');
        });
        const state = stateFor(root, mockRoles(overlapPlan), { client });
        await runOverlap(state, () => {});
        assert.equal(calls, 2, 'the editor is asked once more');
        assert.match(state.warnings.join('\n'), /was not cleaned/);
        assert.ok(state.overlapResolved.every((item) => item.kept === true));
        assert.deepEqual(state.images, [HOME_REL, ABOUT_REL]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the overlap section of the config accepts the patch limits', () => {
    const config = structuredClone(defaults);
    config.stages.overlap.maxPatches = 5;
    config.stages.overlap.boxPadding = 24;
    assert.doesNotThrow(() => validateConfig(config));
    config.stages.overlap.maxPatches = 1.5;
    assert.throws(() => validateConfig(config), /maxPatches/);
});
