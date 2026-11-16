/**
 * @file test/magick.test.js
 * @module test/magick
 * @purpose Tests of the free ImageMagick: the arguments of the model, the rules that keep them
 *          inside the run, the manual, and the command itself.
 * @depends node:test, image/magick-cli, image/magick-docs, agent/tools
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

import {
    forbiddenMagickArg, magickOutputFile, parseMagickArgs, runMagick,
} from '../src/image/magick-cli.js';
import { MAGICK_DOCS, MAGICK_DOC_URLS, magickDoc } from '../src/image/magick-docs.js';
import { detectMagick } from '../src/image/magick.js';
import { createToolset } from '../src/agent/tools.js';

// ---------------------------------------------------------------------------
// The arguments of the command line
// ---------------------------------------------------------------------------

test('the arguments arrive as an array or as a string', () => {
    assert.deepEqual(parseMagickArgs(['in.png', '-resize', '50%']), ['in.png', '-resize', '50%']);
    assert.deepEqual(parseMagickArgs('in.png -resize 50%'), ['in.png', '-resize', '50%']);
    assert.deepEqual(parseMagickArgs('  '), []);
    assert.deepEqual(parseMagickArgs(null), []);
});

test('a quoted argument stays one argument', () => {
    assert.deepEqual(
        parseMagickArgs('in.png -distort Perspective "0,0 0,0 69,0 0,69" out.png'),
        ['in.png', '-distort', 'Perspective', '0,0 0,0 69,0 0,69', 'out.png'],
    );
});

test('the arguments that leave the run are refused', () => {
    assert.match(forbiddenMagickArg('@args.txt'), /list of arguments/);
    assert.match(forbiddenMagickArg('msl:script.msl'), /protocol/);
    assert.match(forbiddenMagickArg('http://example.com/a.png'), /protocol/);
    assert.match(forbiddenMagickArg('file:C:/Windows/win.ini'), /protocol/);
    assert.match(forbiddenMagickArg('-write'), /operator/);
    assert.match(forbiddenMagickArg('-script'), /operator/);
});

test('a setting of a format is not a protocol', () => {
    assert.equal(forbiddenMagickArg('png:compression-level=9'), null);
    assert.equal(forbiddenMagickArg('xc:red'), null);
    assert.equal(forbiddenMagickArg('in.png'), null);
    assert.equal(forbiddenMagickArg('C:\\Users\\me\\picture.png'), null);
});

test('the file the command writes is the last one that names a picture', () => {
    assert.equal(magickOutputFile(['in.png', '-resize', '50%', 'out.png']), 'out.png');
    assert.equal(magickOutputFile(['in.png', '-resize', '50%']), null);
    assert.equal(magickOutputFile([]), null);
});

// ---------------------------------------------------------------------------
// The manual
// ---------------------------------------------------------------------------

test('the manual has the three parts and the addresses of the full manual', () => {
    for (const topic of ['command-line', 'operators', 'distorts']) {
        assert.ok(MAGICK_DOCS[topic].length > 200, `${topic} is too short`);
    }
    assert.match(MAGICK_DOCS['command-line'], /magick \[settings\]/);
    assert.match(MAGICK_DOCS.operators, /-deskew/);
    assert.match(MAGICK_DOCS.distorts, /Perspective\s+4 pairs/);
    assert.match(MAGICK_DOCS.distorts, /Shepards/);
    for (const url of Object.values(MAGICK_DOC_URLS)) assert.match(url, /^https:\/\//);
});

test('a topic that is not known gives the whole manual', () => {
    assert.equal(magickDoc('distorts'), MAGICK_DOCS.distorts);
    assert.ok(magickDoc('nonsense').includes('command line'));
    assert.ok(magickDoc('all').length > magickDoc('operators').length);
});

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

/** A picture to work on. */
const picture = async (width = 40, height = 30) => {
    const data = Buffer.alloc(width * height * 4);
    for (let at = 0; at < width * height; at++) {
        data[at * 4] = 200;
        data[at * 4 + 1] = 200;
        data[at * 4 + 2] = 200;
        data[at * 4 + 3] = 255;
    }
    return await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
};

test('the manual is a tool of its own', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-magick-help-'));
    try {
        const toolset = createToolset({ root: dir, config: { tools: {}, raster: { engine: 'sharp' } } });
        const answer = await toolset.execute('magick_help', { topic: 'command-line' });
        assert.match(answer, /magick \[settings\]/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('the command line that leaves the run is refused', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-magick-refuse-'));
    try {
        const toolset = createToolset({ root: dir, config: { tools: {}, raster: { engine: 'sharp' } } });
        assert.match(await toolset.execute('magick', { args: ['in.png', '@list.txt'] }), /refused|not allowed/);
        assert.match(await toolset.execute('magick', { args: ['msl:script.msl'] }), /protocol/);
        // A path outside of the working directory is a path outside of the run.
        const outside = path.join(dir, '..', 'outside.png');
        assert.match(await toolset.execute('magick', { args: [outside, 'out.png'] }), /outside/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('the file the command writes lands in the directory the stage opened', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-magick-write-'));
    try {
        const toolset = createToolset({ root: dir, config: { tools: {}, raster: { engine: 'sharp' } } });
        toolset.setWriteDirs([path.join(dir, 'allowed')]);
        const answer = await toolset.execute('magick', { args: ['in.png', 'out.png'] });
        assert.match(answer, /outside|forbidden/i, answer);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('the command runs without a shell and writes the file', async (t) => {
    if (!await detectMagick()) {
        t.skip('ImageMagick is not installed on this machine');
        return;
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-magick-run-'));
    try {
        await writeFile(path.join(dir, 'in.png'), await picture());
        const toolset = createToolset({ root: dir, config: { tools: {}, raster: { engine: 'sharp' } } });
        toolset.setWriteDirs([dir]);
        const answer = await toolset.execute('magick', {
            args: ['in.png', '-resize', '50%', 'out.png'],
        });
        assert.match(answer, /exit 0/, answer);
        const info = await stat(path.join(dir, 'out.png'));
        assert.ok(info.size > 0);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('a command that fails comes back as the words of the program', async (t) => {
    if (!await detectMagick()) {
        t.skip('ImageMagick is not installed on this machine');
        return;
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-magick-fail-'));
    try {
        const toolset = createToolset({ root: dir, config: { tools: {}, raster: { engine: 'sharp' } } });
        toolset.setWriteDirs([dir]);
        const answer = await toolset.execute('magick', { args: ['-distort', 'Perspective', '0,0'] });
        assert.match(answer, /exit [1-9]/, answer);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('a command without ImageMagick says so instead of failing', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-magick-none-'));
    try {
        const result = await runMagick({ args: ['-version'], cwd: dir, exe: 'definitely-not-magick' });
        assert.notEqual(result.code, 0);
        assert.ok(result.stderr.length > 0);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
