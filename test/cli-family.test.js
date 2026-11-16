/**
 * @file test/cli-family.test.js
 * @module test/cli-family
 * @purpose The tests of the free door to the CLIs of the house: the catalogue, the manual and
 *          the tool `ai_cli` with its rules.
 * @depends node:test, node:os, node:path, agent/tools, agent/cli-family, agent/tool-specs, stages
 * @ai.tags test, cli, family
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';

import { createToolset } from '../src/agent/tools.js';
import {
    FAMILY_CLIS,
    familyDoc,
    familyNames,
    familyOutputArg,
    familyPathArgs,
} from '../src/agent/cli-family.js';
import { TOOL_SPECS, toolEnabled, toolSpecs } from '../src/agent/tool-specs.js';
import { AGENT_TOOLS } from '../src/stages/decompose.js';
import { RECTIFIER_TOOLS } from '../src/stages/rectify.js';
import { RESTORER_TOOLS } from '../src/stages/reconstruct.js';
import { OVERLAP_TOOLS } from '../src/stages/overlap.js';
import { EXTENDER_TOOLS } from '../src/stages/extension.js';
import { DIRECTOR_TOOLS } from '../src/stages/resolve.js';
import { RECEPTION_TOOLS } from '../src/stages/reception.js';
import { defaults } from '../src/config.js';

/**
 * A working directory with a fake CLI of the house in it.
 *
 * The fake CLI is a Node script: the resolver runs a `.js` entry with the same Node that
 * runs the tests, so the test needs no binary and no network.
 * @param {{ cli?: string, env?: string, print?: string }} [options]
 * @returns {Promise<{ root: string, config: object, tools: object, env: object }>}
 */
async function workspace({ cli = 'ai-image', env = 'AI_IMAGE_BIN', print = 'the help of the cli' } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-family-'));
    const fake = path.join(root, 'fake-cli.js');
    await writeFile(fake, `console.log(${JSON.stringify(print)});\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`);
    const config = structuredClone(defaults);
    const vars = { ...process.env, [env]: fake };
    return { root, config, tools: createToolset({ root, config, env: vars }), env: vars };
}

test('the catalogue holds the CLIs of the house', () => {
    assert.deepEqual(
        familyNames().sort(),
        ['ai', 'ai-decompose', 'ai-image', 'ai-measure', 'ai-webdev'],
    );
    // Every CLI of the house has a way to be found and a way to be asked for its version.
    for (const name of familyNames()) {
        const spec = FAMILY_CLIS[name];
        assert.ok(spec.command, `${name} has a command`);
        assert.ok(spec.env, `${name} has an environment variable`);
        assert.ok(spec.summary, `${name} has a summary`);
    }
});

test('the manual tells the role to ask the CLI for its flags', () => {
    const manual = familyDoc('family');
    assert.match(manual, /--help/);
    assert.match(manual, /--version/);
    for (const name of familyNames()) assert.match(manual, new RegExp(name));
});

test('the manual has a part for the flags and a part for the commands', () => {
    assert.match(familyDoc('flags'), /--effort/);
    assert.match(familyDoc('commands'), /vectorize/);
    // An unknown topic is not an error: the whole manual comes back.
    assert.match(familyDoc('what-is-this'), /--help/);
    assert.match(familyDoc('all'), /--help/);
});

test('the paths of a command line are found, and the words are not', () => {
    const args = ['measure', 'landing.png', '--out', 'measurements', 'docs', 'cssUnits'];
    // The place where the command writes is not a path of the input: it has its own rule.
    assert.deepEqual(familyPathArgs(args), ['landing.png']);
    // The flag with a value in the same word is a path too.
    assert.deepEqual(familyPathArgs(['--image=ref/shot.png']), ['ref/shot.png']);
    // A word that ends with a dot is not a file.
    assert.deepEqual(familyPathArgs(['generate', 'a picture of the hero.']), []);
});

test('the place where the command writes is found', () => {
    assert.equal(familyOutputArg(['--out', 'build']), 'build');
    assert.equal(familyOutputArg(['-o', 'build']), 'build');
    assert.equal(familyOutputArg(['--out=build']), 'build');
    assert.equal(familyOutputArg(['measure', 'landing.png']), null);
});

test('the tool calls a CLI of the house and answers with its output', async () => {
    const { tools } = await workspace();
    const answer = await tools.execute('ai_cli', { cli: 'ai-image', args: '["--help"]' });
    assert.match(answer, /the help of the cli/);
    assert.match(answer, /code 0/);
    // The arguments are exact: one argument per element.
    assert.match(answer, /\["--help"\]/);
});

test('the tool refuses a CLI that is not one of the house', async () => {
    const { tools } = await workspace();
    const answer = await tools.execute('ai_cli', { cli: 'rm', args: '["-rf", "/"]' });
    assert.match(answer, /not one of the house/);
    assert.match(answer, /ai_cli_help/);
});

test('the tool refuses a path outside the working directory', async () => {
    const { tools } = await workspace();
    const answer = await tools.execute('ai_cli', { cli: 'ai-image', args: '["info", "../secret.png"]' });
    assert.match(answer, /outside the working directory/);
    assert.doesNotMatch(answer, /the help of the cli/);
});

test('the tool refuses a command that does not finish on its own', async () => {
    const { tools } = await workspace();
    const answer = await tools.execute('ai_cli', { cli: 'ai', args: '["serve"]' });
    assert.match(answer, /not started/);
    assert.match(answer, /does not finish on its own/);
});

test('the tool says that the CLI is not installed instead of failing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-no-family-'));
    const config = structuredClone(defaults);
    const tools = createToolset({ root, config, env: { PATH: '' } });
    const answer = await tools.execute('ai_cli', { cli: 'ai-measure', args: '["--help"]' });
    assert.match(answer, /not installed/);
    assert.match(answer, /AI_MEASURE_BIN/);
});

test('the manual of the family is a tool of its own', async () => {
    const { tools } = await workspace();
    const answer = await tools.execute('ai_cli_help', { topic: 'flags' });
    assert.match(answer, /--effort/);
    assert.match(answer, /ai-decompose/);
});

test('the two tools are switched off by one key of the config', () => {
    assert.equal(TOOL_SPECS.ai_cli.configKey, 'external_cli');
    assert.equal(TOOL_SPECS.ai_cli_help.configKey, 'external_cli');
    assert.equal(toolEnabled(defaults.tools, 'ai_cli'), true);
    const off = { ...defaults.tools, external_cli: false };
    assert.equal(toolEnabled(off, 'ai_cli'), false);
    const names = toolSpecs(off).map((spec) => spec.name);
    assert.ok(!names.includes('ai_cli'));
    assert.ok(!names.includes('ai_cli_help'));
});

test('the roles that work with the pictures may call the family', () => {
    // The five roles that work with the pictures: they cut, straighten, repair and extend.
    for (const list of [AGENT_TOOLS, RECTIFIER_TOOLS, RESTORER_TOOLS, OVERLAP_TOOLS, EXTENDER_TOOLS]) {
        assert.ok(list.includes('ai_cli'), 'the list has ai_cli');
        assert.ok(list.includes('ai_cli_help'), 'the list has ai_cli_help');
    }
    // The reception and the director judge the run: they have no reason to call the house.
    assert.ok(!RECEPTION_TOOLS.includes('ai_cli'));
    assert.ok(!DIRECTOR_TOOLS.includes('ai_cli'));
    // The catalogue knows the same five roles.
    for (const role of ['decomposer', 'rectifier', 'restorer', 'overlap', 'extender']) {
        assert.ok(TOOL_SPECS.ai_cli.roles.includes(role), `${role} may call ai_cli`);
    }
    assert.ok(!TOOL_SPECS.ai_cli.roles.includes('director'));
});
