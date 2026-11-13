/**
 * @file test/reconstruct.test.js
 * @purpose Tests of the reconstruct stage: the plan of the repair, the fragment that goes to the
 *          editor, the stitch back, and the verification that may refuse the result.
 * @depends node:test, stages/reconstruct, stages/restore-plan
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

import { runReconstruct } from '../src/stages/reconstruct.js';
import { EDITOR_FRAME, editorPrompt, pickPatches, planFragment } from '../src/stages/restore-plan.js';
import { defaults, validateConfig } from '../src/config.js';

const SCREEN_REL = 'decomposition/screens/01-home.png';

/** A picture of horizontal stripes: the shape the editor would see as content. */
const stripes = async (width = 320, height = 240) => {
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
    return await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
};

const stateFor = (root, roles, overrides = {}) => ({
    root,
    workDir: 'decomposition',
    images: [SCREEN_REL],
    screens: [{ name: 'home', source: 'reference.png', subReference: SCREEN_REL, subReferenceKind: 'crop' }],
    screensFiles: [{ rel: SCREEN_REL, screen: 'home', kind: 'crop', source: 'reference.png', note: '' }],
    config: {
        model: 'vendor/vision',
        imageModel: 'vendor/painter',
        roles: {},
        image: { maxSide: 1536, maxMegapixels: 100 },
        limits: { maxImageBytes: 8 * 1024 * 1024 },
        raster: { engine: 'sharp' },
        tools: {},
        stages: {
            reconstruct: {
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

/** A work dir with the screen the decompose stage produced and its source. */
const workDirWith = async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-restore-'));
    await mkdir(path.join(root, 'decomposition', 'screens'), { recursive: true });
    await writeFile(path.join(root, 'decomposition', 'screens', '01-home.png'), await stripes());
    await writeFile(path.join(root, 'reference.png'), await stripes());
    return root;
};

const repairPlan = {
    verdict: 'repair',
    assessment: 'a strip of the neighbouring screen came along with the crop',
    patches: [{
        kind: 'leftover',
        x: 10,
        y: 10,
        width: 40,
        height: 30,
        finding: 'the edge of the neighbouring screen is visible on the left',
        prompt: 'remove the strip of the neighbouring screen and continue the background of this screen',
    }],
};

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

test('the fragment grows to the minimum side and stays in the frame', () => {
    const box = planFragment({ x: 10, y: 10, width: 20, height: 20 }, { frameWidth: 200, frameHeight: 100 });
    assert.ok(box.width >= 64 && box.height >= 64, JSON.stringify(box));
    assert.ok(box.x >= 0 && box.y >= 0);
    assert.ok(box.x + box.width <= 200 && box.y + box.height <= 100);

    const edge = planFragment({ x: 0, y: 0, width: 200, height: 100 }, { frameWidth: 200, frameHeight: 100 });
    assert.deepEqual([edge.x, edge.y], [0, 0]);
    assert.deepEqual([edge.width, edge.height], [200, 100]);
});

test('only a targeted repair of this frame is accepted', () => {
    const options = { frameWidth: 200, frameHeight: 200 };
    const good = {
        kind: 'leftover', x: 10, y: 10, width: 40, height: 30,
        finding: 'a strip of a neighbour', prompt: 'remove the strip of the neighbouring screen and continue the background',
    };
    const result = pickPatches([
        good,
        { ...good, kind: 'colour' },
        { ...good, x: -5 },
        { ...good, x: 180, width: 40 },
        { ...good, width: 180, height: 180 },
        { ...good, prompt: 'fix it' },
        { ...good, x: 20, y: 20 },
    ], options);
    assert.deepEqual(result.patches.map((patch) => patch.x), [10]);
    const reasons = result.rejected.map((item) => item.reason).join(' | ');
    assert.match(reasons, /kind of defect/);
    assert.match(reasons, /leaves the frame/);
    assert.match(reasons, /redraw of the whole screen/);
    assert.match(reasons, /too short/);
    assert.match(reasons, /overlaps/);
});

test('the prompt of the editor carries the contract of the fragment', () => {
    const prompt = editorPrompt('remove the strip');
    assert.match(prompt, /^remove the strip/);
    assert.ok(prompt.includes(EDITOR_FRAME));
});

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

test('the restorer role sees the screen and the source it was cut from', async () => {
    const root = await workDirWith();
    try {
        const calls = [];
        const client = mockClient(async () => { throw new Error('a clean screen must not reach the editor'); });
        const state = stateFor(root, mockRoles({ verdict: 'clean', assessment: 'whole screen', patches: [] }, calls), { client });
        await runReconstruct(state, () => {});
        assert.equal(calls.length, 1);
        assert.equal(calls[0].name, 'restorer');
        assert.equal(calls[0].params.parts.length, 2, 'the source is attached for comparison');
        assert.match(calls[0].params.text, /decomposition\/screens\/01-home\.png/);
        assert.match(calls[0].params.text, /320×240/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a clean screen keeps its file', async () => {
    const root = await workDirWith();
    try {
        const client = mockClient(async () => { throw new Error('a clean screen must not reach the editor'); });
        const state = stateFor(root, mockRoles({ verdict: 'clean', assessment: 'whole screen', patches: [] }), { client });
        await runReconstruct(state, () => {});
        assert.equal(state.restored.length, 1);
        assert.equal(state.restored[0].kept, true);
        assert.deepEqual(state.images, [SCREEN_REL]);
        assert.equal(state.screens[0].subReference, SCREEN_REL);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the editor only sees the fragment, and the answer is stitched back into its box', async () => {
    const root = await workDirWith();
    try {
        const edits = [];
        const client = mockClient(async (params) => {
            edits.push(params);
            return { images: [{ bytes: params.image.bytes, mime: 'image/png' }] };
        });
        const roles = mockRoles((name) => (name === 'restorerVerify'
            ? { verdict: 'better', reason: 'the defect is gone' }
            : repairPlan));
        const state = stateFor(root, roles, { client });
        await runReconstruct(state, () => {});

        assert.equal(edits.length, 1);
        const fragment = await sharp(edits[0].image.bytes).metadata();
        assert.ok(fragment.width < 320 && fragment.height < 240, 'the editor got the box, not the screen');
        assert.match(edits[0].prompt, /remove the strip of the neighbouring screen/);
        assert.ok(edits[0].prompt.includes(EDITOR_FRAME));
        assert.equal(edits[0].model, 'vendor/painter');

        const repaired = state.restored.find((item) => item.to);
        assert.equal(repaired.to, 'decomposition/restored/01-home.png', state.warnings.join('; '));
        assert.equal(repaired.patches.length, 1);
        assert.deepEqual(repaired.patches[0].kind, 'leftover');
        assert.equal(state.screens[0].subReference, 'decomposition/restored/01-home.png');
        assert.equal(state.screens[0].subReferenceKind, 'repaired');
        assert.deepEqual(state.images, ['decomposition/restored/01-home.png']);
        const saved = await sharp(path.join(root, 'decomposition', 'restored', '01-home.png')).metadata();
        assert.deepEqual([saved.width, saved.height], [320, 240], 'the screen keeps its dimensions');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a repair the verification refuses is deleted and the original stays', async () => {
    const root = await workDirWith();
    try {
        const client = mockClient(async (params) => ({ images: [{ bytes: params.image.bytes, mime: 'image/png' }] }));
        const roles = mockRoles((name) => (name === 'restorerVerify'
            ? { verdict: 'worse', reason: 'the lettering was redrawn' }
            : repairPlan));
        const state = stateFor(root, roles, { client });
        await runReconstruct(state, () => {});

        assert.equal(state.restored.find((item) => item.to), undefined);
        assert.match(state.warnings.join('\n'), /refused by the verification/);
        assert.equal(await stat(path.join(root, 'decomposition', 'restored', '01-home.png')).catch(() => null), null);
        assert.deepEqual(state.images, [SCREEN_REL]);
        assert.equal(state.screens[0].subReference, SCREEN_REL);
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
        const roles = mockRoles(repairPlan);
        const state = stateFor(root, roles, { client });
        await runReconstruct(state, () => {});
        assert.equal(calls, 2, 'the editor is asked once more');
        assert.equal(state.restored.find((item) => item.to), undefined);
        assert.match(state.warnings.join('\n'), /was not repaired/);
        assert.deepEqual(state.images, [SCREEN_REL]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('without the images API the stage is skipped', async () => {
    const root = await workDirWith();
    try {
        const state = stateFor(root, mockRoles(repairPlan));
        await runReconstruct(state, () => {});
        assert.match(state.warnings.join('\n'), /images API unavailable/);
        assert.equal(state.restored.length, 0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the reconstruct section of the config accepts the patch limits', () => {
    const config = structuredClone(defaults);
    config.stages.reconstruct.maxPatches = 5;
    config.stages.reconstruct.boxPadding = 24;
    assert.doesNotThrow(() => validateConfig(config));
    config.stages.reconstruct.maxPatches = 1.5;
    assert.throws(() => validateConfig(config), /maxPatches/);
});
