/**
 * @file test/resolve.test.js
 * @purpose Tests of the resolve stage: the chain of the files, the validation of the output and
 *          the layer split of the advanced mode.
 * @depends node:test, stages/resolve
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

import { buildChain, clampBox, followChain, layerSlug, runResolve } from '../src/stages/resolve.js';
import { defaults, validateConfig } from '../src/config.js';

const SCREEN_REL = 'decomposition/screens/01-home.png';
const RECTIFIED_REL = 'decomposition/rectified/01-home.png';
const RESTORED_REL = 'decomposition/restored/01-home.png';
const OVERLAP_REL = 'decomposition/overlap/01-home.png';

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
    outDir: '.',
    workDir: 'decomposition',
    images: [SCREEN_REL],
    screens: [{ name: 'home', source: 'reference.png', subReference: SCREEN_REL, subReferenceKind: 'crop' }],
    screensFiles: [{ rel: SCREEN_REL, screen: 'home', kind: 'crop', source: 'reference.png', note: '' }],
    decomposition: { summary: 'one screen', screens: [], subReferences: [], notes: [] },
    config: {
        model: 'vendor/vision',
        imageModel: 'vendor/painter',
        roles: {},
        image: { maxSide: 1536, maxMegapixels: 100 },
        limits: { maxImageBytes: 8 * 1024 * 1024 },
        raster: { engine: 'sharp' },
        tools: {},
        stages: { resolve: { enabled: true, layers: false, maxLayers: 32 } },
    },
    client: { images: null },
    roles,
    model: null,
    effort: null,
    imageModel: null,
    advanced: false,
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

/** A work dir with the screens of every stage of the chain. */
const workDirWith = async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-resolve-'));
    for (const rel of [SCREEN_REL, RECTIFIED_REL, RESTORED_REL, OVERLAP_REL]) {
        const abs = path.join(root, ...rel.split('/'));
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, await stripes());
    }
    return root;
};

const chainState = () => ({
    rectified: [{ from: SCREEN_REL, to: RECTIFIED_REL }],
    restored: [{ from: RECTIFIED_REL, to: RESTORED_REL }],
    overlapResolved: [{ from: RESTORED_REL, to: OVERLAP_REL }],
});

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

test('the chain of the files ends at the last file the stages wrote', () => {
    const chain = buildChain(chainState());
    const traced = followChain(SCREEN_REL, chain);
    assert.equal(traced.path, OVERLAP_REL);
    assert.deepEqual(traced.steps, ['rectify', 'reconstruct', 'overlap']);
});

test('a file nobody replaced stays where it is', () => {
    const chain = buildChain(chainState());
    const traced = followChain('decomposition/screens/02-about.png', chain);
    assert.equal(traced.path, 'decomposition/screens/02-about.png');
    assert.deepEqual(traced.steps, []);
});

test('a layer name is a name a file can carry', () => {
    assert.equal(layerSlug('Price Card 1', 0), 'price-card-1');
    assert.equal(layerSlug('Панель', 2), 'layer-3');
});

test('a box is kept inside the frame', () => {
    const box = clampBox({ x: -10, y: 5, width: 100, height: 50 }, { width: 80, height: 40 });
    assert.deepEqual(box, { x: 0, y: 5, width: 80, height: 35 });
    assert.equal(clampBox({ x: 0, y: 0, width: 0, height: 10 }, { width: 80, height: 40 }), null);
});

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

test('the final file of every screen is written to decomposition.json', async () => {
    const root = await workDirWith();
    try {
        const state = stateFor(root, mockRoles(null), chainState());
        await runResolve(state, () => {});
        const saved = JSON.parse(await readFile(path.join(root, 'decomposition.json'), 'utf8'));
        assert.equal(saved.screens.length, 1);
        assert.equal(saved.screens[0].subReference, OVERLAP_REL);
        assert.equal(saved.screens[0].subReferenceKind, 'repaired');
        assert.equal(saved.subReferences[0].path, OVERLAP_REL);
        assert.match(saved.subReferences[0].note, /rectify → reconstruct → overlap/);
        assert.equal(state.outputPath, path.join(root, 'decomposition.json'));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a screen without a file is reported and does not point at nothing', async () => {
    const root = await workDirWith();
    try {
        const state = stateFor(root, mockRoles(null), {
            screens: [
                { name: 'home', source: 'reference.png', subReference: SCREEN_REL, subReferenceKind: 'crop' },
                { name: 'ghost', source: 'reference.png', subReference: 'decomposition/screens/09-ghost.png', subReferenceKind: 'crop' },
            ],
        });
        await runResolve(state, () => {});
        const saved = JSON.parse(await readFile(path.join(root, 'decomposition.json'), 'utf8'));
        assert.equal(saved.screens.length, 2);
        assert.equal(saved.screens[0].subReference, SCREEN_REL);
        assert.equal(saved.screens[1].subReference, null);
        assert.equal(saved.screens[1].missing, true);
        assert.match(saved.notes.join('\n'), /The screen "ghost" has no file/);
        assert.equal(saved.subReferences.length, 1, 'a screen without a file is not a sub-reference');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('without the advanced mode no layer is cut', async () => {
    const root = await workDirWith();
    try {
        const calls = [];
        const state = stateFor(root, mockRoles({ assessment: 'x', layers: [] }, calls));
        await runResolve(state, () => {});
        assert.equal(calls.length, 0, 'the director is not asked');
        const saved = JSON.parse(await readFile(path.join(root, 'decomposition.json'), 'utf8'));
        assert.deepEqual(saved.layers, []);
        assert.equal(await stat(path.join(root, 'layers')).catch(() => null), null);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the advanced mode cuts the layers out of the screen', async () => {
    const root = await workDirWith();
    try {
        const calls = [];
        const roles = mockRoles({
            assessment: 'a header, a card and a button',
            layers: [
                { name: 'nav-logo', description: 'the logo', x: 10, y: 8, width: 120, height: 40 },
                { name: 'price card', description: 'the price', x: 200, y: 100, width: 100, height: 80 },
            ],
        }, calls);
        const state = stateFor(root, roles, { advanced: true });
        const events = [];
        await runResolve(state, (event) => events.push(event));

        assert.equal(calls.length, 1);
        assert.equal(calls[0].name, 'director');
        assert.equal(calls[0].params.parts.length, 1, 'the screen is attached');

        const saved = JSON.parse(await readFile(path.join(root, 'decomposition.json'), 'utf8'));
        assert.equal(saved.layers.length, 2);
        assert.equal(saved.layersTarget, SCREEN_REL);
        assert.deepEqual(saved.layerFrame, { width: 320, height: 240 });
        assert.deepEqual(saved.layers[0].box, { x: 10, y: 8, width: 120, height: 40 });
        assert.equal(saved.layers[0].path, 'layers/01-nav-logo.png');

        const files = await readdir(path.join(root, 'layers'));
        assert.deepEqual(files.sort(), ['01-nav-logo.png', '02-price-card.png']);
        const layer = await sharp(path.join(root, 'layers', '01-nav-logo.png')).metadata();
        assert.deepEqual([layer.width, layer.height], [120, 40], 'the layer is the box of the screen');
        assert.equal(events.filter((event) => event.type === 'resolve.layers').length, 1);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a layer without a usable box is dropped', async () => {
    const root = await workDirWith();
    try {
        const roles = mockRoles({
            assessment: 'a header',
            layers: [
                { name: 'broken', description: 'no box', x: 0, y: 0, width: 0, height: 0 },
                { name: 'ok', description: 'a box', x: 4, y: 4, width: 40, height: 40 },
            ],
        });
        const state = stateFor(root, roles, { advanced: true });
        await runResolve(state, () => {});
        const saved = JSON.parse(await readFile(path.join(root, 'decomposition.json'), 'utf8'));
        assert.equal(saved.layers.length, 1);
        assert.equal(saved.layers[0].name, 'ok');
        assert.match(state.warnings.join('\n'), /no usable box/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the resolve section of the config accepts the layer limits', () => {
    const config = structuredClone(defaults);
    config.stages.resolve.maxLayers = 8;
    assert.doesNotThrow(() => validateConfig(config));
    config.stages.resolve.maxLayers = 1.5;
    assert.throws(() => validateConfig(config), /maxLayers/);
});
