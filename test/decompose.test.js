/**
 * @file test/decompose.test.js
 * @purpose Tests of the decompose stage: the agent mode, the inline mode, the caps of the stage
 *          and the sandbox the tools run in.
 * @depends node:test, stages/decompose, stages/decompose-screens, agent/tools, agent/paths
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

import { runDecompose } from '../src/stages/decompose.js';
import { planScreens, screenFileName } from '../src/stages/decompose-screens.js';
import { createToolset } from '../src/agent/tools.js';
import { resolveInside } from '../src/agent/paths.js';
import { DECOMPOSER_INLINE_SCHEMA, SUB_REFERENCE_KINDS } from '../src/agent/schemas.js';
import { defaults, validateConfig } from '../src/config.js';

const solidPng = async (width, height, fill) => {
    const data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        data[i * 4] = fill[0];
        data[i * 4 + 1] = fill[1];
        data[i * 4 + 2] = fill[2];
        data[i * 4 + 3] = 255;
    }
    return await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
};

const stateFor = (root, roles, overrides = {}) => ({
    root,
    images: ['reference.png'],
    workDir: 'decomposition',
    config: {
        model: 'vendor/vision',
        roles: {},
        image: { maxSide: 1536, maxMegapixels: 100 },
        limits: { maxImageBytes: 8 * 1024 * 1024 },
        raster: { engine: 'sharp' },
        tools: {},
        stages: {
            decompose: {
                enabled: true,
                mode: 'agent',
                maxTurns: 32,
                maxSubReferences: 12,
                maxRects: 24,
                maxInlinePixels: 64 * 1_000_000,
                minScreenSide: 48,
            },
        },
        ...overrides.config,
    },
    client: { images: null },
    roles,
    model: null,
    effort: null,
    imageModel: null,
    warnings: [],
    extended: [],
    canvas: [],
    screens: [],
    screensFiles: [],
    ...overrides,
});

const mockRoles = (data, calls = []) => ({
    resolve: () => ({ instructions: 'You are the decomposer.', model: 'vendor/vision' }),
    async run(name, params) {
        calls.push({ name, params });
        return { status: 'completed', data, text: '', toolCalls: [], usage: null, error: null };
    },
});

// ---------------------------------------------------------------------------
// Agent mode
// ---------------------------------------------------------------------------

test('agent mode: the role gets the image tools and the output directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-agent-'));
    try {
        await writeFile(path.join(root, 'reference.png'), await solidPng(64, 64, [10, 20, 30]));
        const calls = [];
        const state = stateFor(root, mockRoles({ summary: '', screens: [], subReferences: [], notes: [] }, calls));
        await runDecompose(state, () => {});
        assert.equal(calls.length, 1);
        const params = calls[0].params;
        assert.equal(calls[0].name, 'decomposer');
        const names = (params.extraTools ?? []).map((spec) => spec.name);
        assert.ok(names.includes('crop_image'));
        assert.ok(names.includes('split_image'));
        assert.ok(names.includes('compare_images'));
        assert.match(params.instructions, /decomposition\/screens/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('agent mode: a file the role wrote is collected and the screen points at it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-agent-file-'));
    try {
        await writeFile(path.join(root, 'reference.png'), await solidPng(64, 64, [10, 20, 30]));
        await mkdir(path.join(root, 'decomposition', 'screens'), { recursive: true });
        await writeFile(path.join(root, 'decomposition', 'screens', '01-home.png'), await solidPng(32, 32, [0, 0, 0]));
        const data = {
            summary: 'One screen',
            screens: [{ name: 'home', source: 'reference.png', subReference: 'decomposition/screens/01-home.png', subReferenceKind: 'crop' }],
            subReferences: [{ path: 'decomposition/screens/01-home.png', screen: 'home', kind: 'crop', source: 'reference.png', note: '' }],
            notes: [],
        };
        const state = stateFor(root, mockRoles(data));
        await runDecompose(state, () => {});
        assert.equal(state.screensFiles.length, 1);
        assert.equal(state.screensFiles[0].rel, 'decomposition/screens/01-home.png');
        assert.equal(state.screens[0].subReference, 'decomposition/screens/01-home.png');
        assert.equal(state.screens[0].subReferenceKind, 'crop');
        assert.deepEqual(state.images, ['decomposition/screens/01-home.png']);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('agent mode: a file that does not exist is dropped with a warning', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-agent-missing-'));
    try {
        await writeFile(path.join(root, 'reference.png'), await solidPng(64, 64, [10, 20, 30]));
        const data = {
            summary: '',
            screens: [{ name: 'home', source: 'reference.png', subReference: 'decomposition/screens/01-home.png', subReferenceKind: 'crop' }],
            subReferences: [],
            notes: [],
        };
        const state = stateFor(root, mockRoles(data));
        await runDecompose(state, () => {});
        assert.equal(state.screensFiles.length, 0);
        assert.match(state.warnings.join('\n'), /not found/);
        assert.equal(state.screens[0].subReference, null);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('agent mode: a screen the role named but did not write is cut by the harness', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-agent-cut-'));
    try {
        await writeFile(path.join(root, 'reference.png'), await solidPng(128, 64, [10, 20, 30]));
        await mkdir(path.join(root, 'decomposition', 'screens'), { recursive: true });
        await writeFile(path.join(root, 'decomposition', 'screens', '01-first.png'), await solidPng(64, 64, [0, 0, 0]));
        const data = {
            summary: 'Two screens',
            screens: [
                {
                    name: 'first', source: 'reference.png', rect: { x: 0, y: 0, width: 64, height: 64 },
                    subReference: 'decomposition/screens/01-first.png', subReferenceKind: 'crop',
                },
                {
                    name: 'second', source: 'reference.png', rect: { x: 64, y: 0, width: 64, height: 64 },
                    subReference: 'decomposition/screens/02-second.png', subReferenceKind: 'crop',
                },
            ],
            subReferences: [{ path: 'decomposition/screens/01-first.png', screen: 'first', kind: 'crop', source: 'reference.png', note: '' }],
            notes: [],
        };
        const state = stateFor(root, mockRoles(data));
        const events = [];
        await runDecompose(state, (event) => events.push(event));

        assert.equal(state.screensFiles.length, 2, 'the missing screen is cut');
        const cut = events.find((event) => event.type === 'decompose.cut');
        assert.ok(cut, 'the cut is reported');
        assert.equal(cut.screen, 'second');
        assert.equal(cut.file, 'decomposition/screens/02-second.png');
        const written = path.join(root, 'decomposition', 'screens', '02-second.png');
        assert.equal((await stat(written)).isFile(), true);
        const frame = await sharp(written).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        assert.deepEqual([frame.info.width, frame.info.height], [64, 64]);
        assert.deepEqual(state.screens[1].subReference, 'decomposition/screens/02-second.png');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('agent mode: a path outside the working directory is refused', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-agent-escape-'));
    try {
        await writeFile(path.join(root, 'reference.png'), await solidPng(64, 64, [10, 20, 30]));
        const data = {
            summary: '',
            screens: [],
            subReferences: [{ path: '../evil.png', screen: 'evil', kind: 'crop', source: '', note: '' }],
            notes: [],
        };
        const state = stateFor(root, mockRoles(data));
        await runDecompose(state, () => {});
        assert.equal(state.screensFiles.length, 0);
        assert.match(state.warnings.join('\n'), /outside the working directory/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('agent mode: the number of sub-references is capped', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-agent-cap-'));
    try {
        await writeFile(path.join(root, 'reference.png'), await solidPng(64, 64, [10, 20, 30]));
        await mkdir(path.join(root, 'decomposition', 'screens'), { recursive: true });
        const listed = [];
        for (let index = 1; index <= 5; index++) {
            const name = `${String(index).padStart(2, '0')}-screen.png`;
            await writeFile(path.join(root, 'decomposition', 'screens', name), await solidPng(32, 32, [0, 0, 0]));
            listed.push({ path: `decomposition/screens/${name}`, screen: `screen-${index}`, kind: 'crop', source: '', note: '' });
        }
        const config = {
            stages: {
                decompose: {
                    enabled: true, mode: 'agent', maxTurns: 32, maxSubReferences: 2,
                    maxRects: 24, maxInlinePixels: 64 * 1_000_000, minScreenSide: 48,
                },
            },
        };
        const state = stateFor(root, mockRoles({ summary: '', screens: [], subReferences: listed, notes: [] }), { config });
        await runDecompose(state, () => {});
        assert.equal(state.screensFiles.length, 2);
        assert.match(state.warnings.join('\n'), /more than 2/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// The sandbox of the tools
// ---------------------------------------------------------------------------

test('the tool executor refuses a write outside the allowed directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-tools-write-'));
    try {
        await writeFile(path.join(root, 'reference.png'), await solidPng(64, 64, [10, 20, 30]));
        const toolset = createToolset({ root, config: { tools: {}, raster: { engine: 'sharp' } } });
        toolset.setWriteDirs([path.join(root, 'decomposition', 'screens')]);
        await assert.rejects(
            () => toolset.execute('crop_image', { path: 'reference.png', x: 0, y: 0, width: 10, height: 10, output: 'evil.png' }),
            /forbidden/,
        );
        assert.equal(await stat(path.join(root, 'evil.png')).catch(() => null), null);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the tool executor clamps a crop box to the frame', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-tools-crop-'));
    try {
        await writeFile(path.join(root, 'reference.png'), await solidPng(64, 64, [10, 20, 30]));
        const toolset = createToolset({ root, config: { tools: {}, raster: { engine: 'sharp' } } });
        const answer = await toolset.execute('crop_image', {
            path: 'reference.png', x: 60, y: 60, width: 100, height: 100, output: 'decomposition/screens/01-home.png',
        });
        assert.match(answer, /4×4/);
        const info = await sharp(path.join(root, 'decomposition', 'screens', '01-home.png')).metadata();
        assert.deepEqual([info.width, info.height], [4, 4]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a path that leaves the working directory is refused', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-paths-'));
    try {
        await assert.rejects(() => resolveInside(root, '../outside.png'), /outside the working directory/);
        const located = await resolveInside(root, 'inside/file.png');
        assert.equal(located.rel, 'inside/file.png');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Inline mode
// ---------------------------------------------------------------------------

test('inline mode: the role gets no tool that writes a file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-inline-tools-'));
    try {
        await writeFile(path.join(root, 'reference.png'), await solidPng(64, 64, [10, 20, 30]));
        const calls = [];
        const config = {
            stages: {
                decompose: {
                    enabled: true, mode: 'inline', maxTurns: 32, maxSubReferences: 12,
                    maxRects: 24, maxInlinePixels: 64 * 1_000_000, minScreenSide: 48,
                },
            },
        };
        const state = stateFor(root, mockRoles({ summary: '', screens: [], subReferences: [], notes: [] }, calls), { config });
        await runDecompose(state, () => {});
        const names = (calls[0].params.extraTools ?? []).map((spec) => spec.name);
        assert.ok(names.includes('view_image'));
        for (const forbidden of ['crop_image', 'split_image', 'generate_image', 'edit_image', 'correct_perspective']) {
            assert.ok(!names.includes(forbidden), `${forbidden} must not be offered in inline mode`);
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('inline mode: the harness cuts the rectangle and keeps the pixels', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-inline-cut-'));
    try {
        await writeFile(path.join(root, 'reference.png'), await solidPng(200, 100, [10, 20, 30]));
        const data = {
            summary: 'One screen',
            screens: [{ name: 'Home', source: 'reference.png', rect: { x: 20, y: 10, width: 60, height: 40 } }],
            subReferences: [],
            notes: [],
        };
        const config = {
            stages: {
                decompose: {
                    enabled: true, mode: 'inline', maxTurns: 32, maxSubReferences: 12,
                    maxRects: 24, maxInlinePixels: 64 * 1_000_000, minScreenSide: 32,
                },
            },
        };
        const state = stateFor(root, mockRoles(data), { config });
        await runDecompose(state, () => {});

        assert.equal(state.screensFiles.length, 1);
        assert.equal(state.screensFiles[0].rel, 'decomposition/screens/01-home.png');
        assert.equal(state.screens[0].subReferenceKind, 'crop');
        assert.deepEqual(state.images, ['decomposition/screens/01-home.png']);

        const cut = await sharp(path.join(root, 'decomposition', 'screens', '01-home.png'))
            .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        assert.deepEqual([cut.info.width, cut.info.height], [60, 40]);
        const source = await sharp(path.join(root, 'reference.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const sourceAt = (x, y) => {
            const at = (y * source.info.width + x) * 4;
            return Array.from(source.data.subarray(at, at + 4));
        };
        const cutAt = (x, y) => {
            const at = (y * cut.info.width + x) * 4;
            return Array.from(cut.data.subarray(at, at + 4));
        };
        assert.deepEqual(cutAt(0, 0), sourceAt(20, 10));
        assert.deepEqual(cutAt(59, 39), sourceAt(79, 49));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('inline mode: the caps drop the rects that do not fit', () => {
    const frame = { width: 200, height: 100 };
    const source = { width: 200, height: 100 };
    const screens = [
        { name: 'a', rect: { x: 0, y: 0, width: 100, height: 100 } },
        { name: 'b', rect: { x: 0, y: 0, width: 100, height: 100 } },
        { name: 'tiny', rect: { x: 0, y: 0, width: 30, height: 200 } },
        { name: 'huge', rect: { x: 0, y: 0, width: 400, height: 400 } },
    ];
    const planned = planScreens({
        decomposition: { screens },
        frame,
        source,
        limits: { maxRects: 2, maxInlinePixels: 15_000, minScreenSide: 48 },
    });
    assert.deepEqual(planned.accepted.map((item) => item.name), ['a']);
    assert.deepEqual(planned.dropped.map((item) => item.name), ['b', 'tiny', 'huge']);
    assert.match(planned.dropped.find((item) => item.name === 'b').reason, /budget/);
    assert.match(planned.dropped.find((item) => item.name === 'tiny').reason, /smaller than 48/);
    assert.match(planned.dropped.find((item) => item.name === 'huge').reason, /budget/);

    const count = planScreens({
        decomposition: { screens },
        frame,
        source,
        limits: { maxRects: 2, maxInlinePixels: 64 * 1_000_000, minScreenSide: 48 },
    });
    assert.deepEqual(count.accepted.map((item) => item.name), ['a', 'b']);
    assert.match(count.dropped[0].reason, /more than 2/);
});

test('inline mode: the rects are mapped back from the picture the model saw', () => {
    const planned = planScreens({
        decomposition: { screens: [{ name: 'home', rect: { x: 10, y: 5, width: 20, height: 10 } }] },
        frame: { width: 100, height: 50 },
        source: { width: 400, height: 200 },
        limits: { maxRects: 24, maxInlinePixels: 64 * 1_000_000, minScreenSide: 32 },
    });
    assert.deepEqual(planned.accepted[0].rect, { x: 40, y: 20, width: 80, height: 40 });
});

test('the file name of a screen is its order and a slug', () => {
    assert.equal(screenFileName(0, 'Home Screen'), '01-home-screen.png');
    assert.equal(screenFileName(9, ''), '10-screen.png');
});

// ---------------------------------------------------------------------------
// State, artifact and config
// ---------------------------------------------------------------------------

test('the stage writes the decomposition object into the state and into a file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-json-'));
    try {
        await writeFile(path.join(root, 'reference.png'), await solidPng(64, 64, [10, 20, 30]));
        const data = { summary: 'One screen', screens: [], subReferences: [], notes: [] };
        const state = stateFor(root, mockRoles(data));
        await runDecompose(state, () => {});
        const written = JSON.parse(await readFile(path.join(root, 'decomposition', 'decompose.json'), 'utf-8'));
        assert.equal(written.summary, 'One screen');
        assert.equal(state.decomposition.summary, 'One screen');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a failed role call leaves the state empty and warns', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-failed-'));
    try {
        await writeFile(path.join(root, 'reference.png'), await solidPng(64, 64, [10, 20, 30]));
        const roles = {
            resolve: () => ({ instructions: 'x' }),
            async run() { return { status: 'error', data: null, text: '', toolCalls: [], usage: null, error: 'boom' }; },
        };
        const state = stateFor(root, roles);
        await runDecompose(state, () => {});
        assert.deepEqual(state.screens, []);
        assert.deepEqual(state.screensFiles, []);
        assert.match(state.warnings.join('\n'), /returned no data/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the decompose section of the config accepts maxTurns and the two modes', () => {
    const config = structuredClone(defaults);
    config.stages.decompose.maxTurns = 12;
    config.stages.decompose.mode = 'inline';
    assert.doesNotThrow(() => validateConfig(config));
    config.stages.decompose.mode = 'bogus';
    assert.throws(() => validateConfig(config), /mode/);
});

test('the kinds of a sub-reference are the six of the monolith', () => {
    assert.deepEqual(SUB_REFERENCE_KINDS, ['crop', 'split', 'restored', 'repaired', 'regenerated', 'figma-export']);
});

test('the inline schema asks for a rectangle and allows an empty kind', () => {
    const screen = DECOMPOSER_INLINE_SCHEMA.properties.screens.items;
    assert.ok(screen.properties.rect);
    assert.ok(screen.properties.subReferenceKind.enum.includes(''));
});
