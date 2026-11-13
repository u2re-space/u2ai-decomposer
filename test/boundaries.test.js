/**
 * @file test/boundaries.test.js
 * @purpose The edges of the CLI: no key, a broken config, a JPEG instead of a PNG, and a picture
 *          too small to be a screen.
 * @depends node:test, cli, stages/decompose
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

import { apiKeyAvailable, main } from '../src/cli.js';
import { runDecompose } from '../src/stages/decompose.js';

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

const mockRoles = (answer, calls = []) => ({
    resolve: (name) => ({ instructions: `You are the ${name}.` }),
    async run(name, params) {
        calls.push({ name, params });
        return { status: 'completed', data: answer, text: '', toolCalls: [], usage: null, error: null };
    },
});

/** Run the CLI with a home directory of its own and without any key in the environment. */
const runCli = async (argv, home) => {
    const original = process.env;
    const logs = [];
    const errors = [];
    const log = console.log;
    const error = console.error;
    try {
        process.env = { ...original };
        process.env.AI_DECOMPOSE_HOME = home;
        for (const name of ['AI_DECOMPOSE_API_KEY', 'OPENAI_API_KEY', 'ROUTERAI_API_KEY', 'PROXYAPI_API_KEY',
            'SPRUTDOCK_API_KEY', 'GPTUNNEL_API_KEY']) delete process.env[name];
        console.log = (...args) => logs.push(args.join(' '));
        console.error = (...args) => errors.push(args.join(' '));
        const code = await main(argv);
        return { code, logs: logs.join('\n'), errors: errors.join('\n') };
    } finally {
        console.log = log;
        console.error = error;
        process.env = original;
    }
};

test('a local server needs no key, a remote one does', () => {
    const remote = {
        backends: [{ baseURL: 'https://routerai.ru/api/v1', env: 'ROUTERAI_API_KEY' }],
        baseURL: 'https://routerai.ru/api/v1',
        apiKey: null,
    };
    assert.equal(apiKeyAvailable(remote, {}), false);
    assert.equal(apiKeyAvailable(remote, { ROUTERAI_API_KEY: 'k' }), true);

    const local = {
        backends: [{ baseURL: 'http://localhost:11434/v1' }],
        baseURL: 'http://localhost:11434/v1',
        apiKey: null,
    };
    assert.equal(apiKeyAvailable(local, {}), true, 'a server on this machine is often open');
});

test('without a key the CLI says what to do and stops', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-nokey-'));
    try {
        const { code, errors } = await runCli(['-i', 'reference.png'], home);
        assert.equal(code, 1);
        assert.match(errors, /AI_DECOMPOSE_API_KEY/);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('the dry-run works without a key', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-nokey-'));
    try {
        const { code, logs } = await runCli(['-i', 'reference.png', '--dry-run'], home);
        assert.equal(code, 0);
        assert.match(logs, /Plan:/);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('a broken config file stops the CLI with a message that names it', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-badconfig-'));
    try {
        await writeFile(path.join(home, 'config.json'), '{ not json at all');
        const { code, errors } = await runCli(['-i', 'reference.png'], home);
        assert.equal(code, 1);
        assert.match(errors, /некорректный JSON/);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('a JPEG reference is read and sent to the model as a JPEG', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-jpeg-'));
    try {
        await writeFile(path.join(root, 'reference.jpg'), await sharp(await solidPng(120, 90, [10, 20, 30])).jpeg().toBuffer());
        const calls = [];
        const state = {
            root,
            images: ['reference.jpg'],
            workDir: 'decomposition',
            config: {
                image: { maxSide: 1536, maxMegapixels: 100 },
                raster: { engine: 'sharp' },
                tools: {},
                stages: { decompose: { enabled: true, mode: 'inline', maxRects: 4, maxInlinePixels: 1e7, minScreenSide: 32 } },
            },
            client: { images: null },
            roles: mockRoles({
                summary: 'one screen',
                screens: [{ name: 'Home', source: 'reference.jpg', rect: { x: 0, y: 0, width: 100, height: 80 } }],
                subReferences: [],
                notes: [],
            }, calls),
            model: null,
            effort: null,
            warnings: [],
            screens: [],
            screensFiles: [],
        };
        await runDecompose(state, () => {});
        assert.equal(calls.length, 1);
        const part = calls[0].params.parts[0];
        assert.match(part.image_url ?? '', /data:image\/jpeg;base64,/);
        assert.equal(state.screensFiles.length, 1, 'the picture was cut');
        assert.equal(state.screensFiles[0].rel, 'decomposition/screens/01-home.png');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a picture smaller than the smallest screen is refused', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-small-'));
    try {
        await writeFile(path.join(root, 'reference.png'), await solidPng(24, 24, [10, 20, 30]));
        const state = {
            root,
            images: ['reference.png'],
            workDir: 'decomposition',
            config: {
                image: { maxSide: 1536, maxMegapixels: 100 },
                raster: { engine: 'sharp' },
                tools: {},
                stages: { decompose: { enabled: true, mode: 'inline', maxRects: 4, maxInlinePixels: 1e7, minScreenSide: 48 } },
            },
            client: { images: null },
            roles: mockRoles({
                summary: 'one screen',
                screens: [{ name: 'Tiny', source: 'reference.png', rect: { x: 0, y: 0, width: 24, height: 24 } }],
                subReferences: [],
                notes: [],
            }),
            model: null,
            effort: null,
            warnings: [],
            screens: [],
            screensFiles: [],
        };
        await runDecompose(state, () => {});
        assert.equal(state.screensFiles.length, 0, 'nothing was cut');
        assert.match(state.warnings.join('\n'), /smaller than 48 px/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
