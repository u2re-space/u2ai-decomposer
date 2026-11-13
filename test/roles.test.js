/**
 * @file test/roles.test.js
 * @module test/roles
 * @purpose Tests of the role registry and the run loop against a mock client.
 * @depends node:test, roles/index, model/profiles
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRoleRunner, resolveRole, resolveRoleInstructions, ROLE_INSTRUCTIONS } from '../src/roles/index.js';
import { parseResponse } from '../src/openai/responses.js';

/**
 * A client that answers with a fixed payload and records what it was asked.
 * @param {object} answer the Responses API answer to return
 * @returns {{ client: object, calls: object[] }}
 */
function mockClient(answer) {
    const calls = [];
    return {
        calls,
        client: {
            responses: {
                async create(params) {
                    calls.push(params);
                    return answer;
                },
            },
        },
    };
}

test('every built-in role has instructions', () => {
    for (const name of Object.keys(ROLE_INSTRUCTIONS)) {
        assert.ok(resolveRoleInstructions(name)?.length > 20, `${name} has no instructions`);
    }
});

test('a role takes its model from the role, then from roles.default, then from the top level', () => {
    const config = {
        model: 'top-model',
        roles: { default: { model: 'default-model' }, decomposer: { model: 'own-model' } },
    };
    assert.equal(resolveRole(config, 'decomposer').model, 'own-model');
    assert.equal(resolveRole(config, 'rectifier').model, 'default-model');

    const withoutDefault = { model: 'top-model', roles: { decomposer: {} } };
    assert.equal(resolveRole(withoutDefault, 'decomposer').model, 'top-model');
});

test('the effort of a role is clamped to what the model accepts', () => {
    const config = {
        model: 'openai/gpt-6-luna',
        roles: { decomposer: { effort: 'xhigh' } },
    };
    assert.equal(resolveRole(config, 'decomposer').effort, 'medium');
});

test('a role asks the API with its instructions and reads the JSON answer', async () => {
    const { client, calls } = mockClient({
        id: 'resp_1',
        status: 'completed',
        model: 'm',
        output: [{ type: 'message', content: [{ type: 'output_text', text: '{"screens":[{"name":"home"}]}' }] }],
    });
    const runner = createRoleRunner({ client, config: { model: 'm', roles: {} } });
    const result = await runner.run('decomposer', {
        text: 'split this collage',
        parts: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }],
        schema: { type: 'object', properties: { screens: { type: 'array' } } },
        schemaName: 'decomposition',
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.data, { screens: [{ name: 'home' }] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'm');
    assert.ok(calls[0].instructions.includes('decomposer') || calls[0].instructions.length > 20);
    assert.equal(calls[0].schemaName, 'decomposition');
    assert.equal(calls[0].parts.length, 1);
});

test('a failing call comes back as an error, not as a crash', async () => {
    const client = {
        responses: {
            async create() { throw new Error('the host is down'); },
        },
    };
    const runner = createRoleRunner({ client, config: { model: 'm', roles: {} } });
    const result = await runner.run('extender', { text: 'x' });
    assert.equal(result.status, 'error');
    assert.match(result.error, /the host is down/);
});

test('an unknown role is refused', async () => {
    const { client } = mockClient({ output: [] });
    const runner = createRoleRunner({ client, config: { model: 'm', roles: {} } });
    const result = await runner.run('nonsense', { text: 'x' });
    assert.equal(result.status, 'error');
    assert.match(result.error, /Unknown role/);
});

test('the tool loop runs the calls of the model and feeds the results back', async () => {
    const answers = [
        {
            id: 'resp_1',
            status: 'completed',
            output: [{
                type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'view_image',
                arguments: '{"path":"a.png"}',
            }],
        },
        {
            id: 'resp_2',
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: '{"verdict":"done"}' }] }],
        },
    ];
    const calls = [];
    const client = {
        responses: {
            async create(params) {
                calls.push(params);
                return answers.shift();
            },
        },
    };
    const executed = [];
    const toolset = {
        specs: [{ type: 'function', name: 'view_image', parameters: { type: 'object', properties: {} } }],
        async execute(name, args) {
            executed.push({ name, args });
            return 'Image a.png: 100x50';
        },
    };
    const runner = createRoleRunner({ client, config: { model: 'm', roles: {} }, toolset });
    const result = await runner.run('decomposer', { text: 'look at it', maxTurns: 3 });
    assert.equal(calls.length, 2);
    assert.deepEqual(executed, [{ name: 'view_image', args: { path: 'a.png' } }]);
    assert.equal(result.text, '{"verdict":"done"}');
    assert.deepEqual(result.trace, [{ tool: 'view_image', args: { path: 'a.png' } }]);
    // The second call carries the tool result back to the model.
    assert.equal(calls[1].input.length, 2);
    assert.equal(calls[1].input[1].type, 'function_call_output');
    assert.match(calls[1].input[1].output, /100x50/);
});
