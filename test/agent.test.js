/**
 * @file test/agent.test.js
 * @purpose Tests of the agent infrastructure: the tool catalogue, the MCP client, the skill packs
 *          and the decomposer role against a mock client.
 * @depends node:test, agent/tool-specs, agent/mcp, agent/skills, roles/index
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';

import { TOOL_SPECS, toolSpecs, toolEnabled, configKeyFor, enabledToolNames } from '../src/agent/tool-specs.js';
import { createToolset, mcpToolEntries } from '../src/agent/tools.js';
import { parseRpcBody, mcpToolSpecs, connectMcp } from '../src/agent/mcp.js';
import { loadSkills, skillsForRole } from '../src/agent/skills.js';
import { createRoleRunner } from '../src/roles/index.js';
import { DECOMPOSER_SCHEMA } from '../src/agent/schemas.js';

test('the config switch of a tool is named after its domain', () => {
    assert.equal(configKeyFor('crop_image'), 'image_crop');
    assert.equal(configKeyFor('correct_perspective'), 'image_correct_perspective');
    assert.equal(toolEnabled({ image_crop: false }, 'crop_image'), false);
    assert.equal(toolEnabled({ image_crop: true }, 'crop_image'), true);
    // A tool that the config does not mention is on.
    assert.equal(toolEnabled({}, 'crop_image'), true);
});

test('the tool list follows the switches and the role', () => {
    const all = toolSpecs({});
    assert.ok(all.length >= Object.keys(TOOL_SPECS).length - 2);
    assert.ok(all.every((spec) => spec.type === 'function' && spec.parameters?.type === 'object'));

    const withoutCrop = toolSpecs({ image_crop: false });
    assert.ok(!withoutCrop.some((spec) => spec.name === 'crop_image'));

    const rectifier = toolSpecs({}, { role: 'rectifier' });
    assert.ok(rectifier.some((spec) => spec.name === 'correct_perspective'));
    assert.ok(!rectifier.some((spec) => spec.name === 'split_image'));
});

test('the image tools need the images API', () => {
    const withoutApi = enabledToolNames({}, { role: 'decomposer' });
    assert.ok(!withoutApi.includes('generate_image'));
    const withApi = enabledToolNames({}, { role: 'decomposer', imageApi: true });
    assert.ok(withApi.includes('generate_image'));
    assert.ok(withApi.includes('edit_image'));
});

test('a toolset answers a call with the result of the operation', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-tools-'));
    try {
        const source = path.join(dir, 'picture.png');
        await writeFile(source, Buffer.from('not really a picture'));
        const toolset = createToolset({ root: dir, config: { tools: {} } });
        const answer = await toolset.execute('read_file', { path: 'picture.png' });
        assert.equal(answer, 'not really a picture');
        const unknown = await toolset.execute('no_such_tool', {});
        assert.match(unknown, /Unknown tool/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('the MCP answer is read from JSON and from an SSE stream', () => {
    assert.deepEqual(parseRpcBody('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}'), {
        jsonrpc: '2.0', id: 1, result: { ok: true },
    });
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n\n';
    assert.deepEqual(parseRpcBody(sse).result, { tools: [] });
    assert.equal(parseRpcBody(''), null);
});

test('the tools of an MCP server are named so that two servers cannot collide', () => {
    const entries = mcpToolEntries([
        { name: 'figma', tools: [{ name: 'get file', description: 'read a file', inputSchema: { type: 'object' } }] },
        { name: 'figma', tools: [{ name: 'get file', description: 'read a file' }] },
    ]);
    assert.equal(entries[0].name, 'mcp_figma_get_file');
    assert.equal(entries[1].name, 'mcp_figma_get_file');
    const specs = mcpToolSpecs([{ name: 'get file', description: 'read a file' }], 'mcp_figma');
    assert.equal(specs[0].name, 'mcp_figma_get_file');
});

test('a server that is not there is not a crash', async () => {
    const connection = await connectMcp({ name: 'nowhere', url: 'http://127.0.0.1:1/mcp' });
    assert.equal(connection.tools.length, 0);
    assert.ok(connection.error);
    const result = await connection.call('anything', {});
    assert.ok(result.error);
});

test('the skill packs are read per role', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-skills-'));
    try {
        await writeFile(path.join(dir, 'shared.md'), 'Always answer in Russian.');
        await writeFile(path.join(dir, 'rectifier.md'), 'Measure the corners twice.');
        await writeFile(path.join(dir, 'restorer.md'), 'Keep the palette.');

        const rectifier = await loadSkills({ dir, role: 'rectifier' });
        assert.deepEqual(rectifier.map((pack) => pack.name).sort(), ['rectifier', 'shared']);
        const restorer = await loadSkills({ dir, role: 'restorer' });
        assert.deepEqual(restorer.map((pack) => pack.name).sort(), ['restorer', 'shared']);
        const text = await skillsForRole({ dir, role: 'rectifier' });
        assert.match(text, /Measure the corners twice/);
        assert.match(text, /Always answer in Russian/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('the skill pack of a role is appended to its instructions', async () => {
    const calls = [];
    const client = {
        responses: {
            async create(params) {
                calls.push(params);
                return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"verdict":"keep"}' }] }] };
            },
        },
    };
    const runner = createRoleRunner({
        client,
        config: { model: 'm', roles: {} },
        skills: { rectifier: 'The corners are the truth.' },
    });
    await runner.run('rectifier', { text: 'look' });
    assert.match(calls[0].instructions, /The corners are the truth/);
});

test('the decomposer role returns a decomposition and a tool trace', async () => {
    const answers = [
        {
            id: 'resp_1',
            status: 'completed',
            output: [{
                type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'view_image',
                arguments: '{"path":"original.png"}',
            }],
        },
        {
            id: 'resp_2',
            status: 'completed',
            output: [{
                type: 'message',
                content: [{
                    type: 'output_text',
                    text: JSON.stringify({
                        summary: 'One screen',
                        screens: [{ name: 'home', source: 'original.png', purpose: 'home' }],
                        subReferences: [],
                        notes: [],
                    }),
                }],
            }],
        },
    ];
    const client = {
        responses: {
            async create() { return answers.shift(); },
        },
    };
    const toolset = {
        specs: [{ type: 'function', name: 'view_image', parameters: { type: 'object', properties: {} } }],
        async execute() { return 'Image original.png: 1024x768'; },
    };
    const runner = createRoleRunner({ client, config: { model: 'm', roles: {} }, toolset });
    const result = await runner.run('decomposer', {
        text: 'split this',
        schema: DECOMPOSER_SCHEMA,
        schemaName: 'decomposition',
        maxTurns: 3,
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.data.summary, 'One screen');
    assert.equal(result.data.screens[0].name, 'home');
    assert.deepEqual(result.trace, [{ tool: 'view_image', args: { path: 'original.png' } }]);
});
