/**
 * @file test/progress.test.js
 * @module test/progress
 * @purpose Tests of the live progress: the roles ask for a stream, the transport announces
 *           its retries, and the renderer shows what the run is doing instead of going quiet.
 * @depends node:test, roles/index, cli/renderer, openai/client, openai/stream
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRoleRunner } from '../src/roles/index.js';
import { createRenderer, createPlainRenderer, formatDuration } from '../src/cli/renderer.js';
import { requestTimeoutMs, streamUnsupported } from '../src/openai/client.js';
import { createStreamReducer } from '../src/openai/stream.js';

/**
 * Run a function with the stdout and the stderr captured.
 * @param {Function} fn the function to run
 * @returns {Promise<{ out: string, err: string }>} what was written
 */
async function capture(fn) {
    const original = process.stdout.write.bind(process.stdout);
    const originalError = process.stderr.write.bind(process.stderr);
    let out = '';
    let err = '';
    process.stdout.write = (chunk, ...rest) => {
        out += String(chunk);
        const callback = rest.find((item) => typeof item === 'function');
        callback?.();
        return true;
    };
    process.stderr.write = (chunk, ...rest) => {
        err += String(chunk);
        const callback = rest.find((item) => typeof item === 'function');
        callback?.();
        return true;
    };
    try {
        await fn();
    } finally {
        process.stdout.write = original;
        process.stderr.write = originalError;
    }
    return { out, err };
}

test('a role asks for a streamed answer and says what it is doing', async () => {
    const calls = [];
    const events = [];
    const client = {
        responses: {
            async create(params) {
                calls.push(params);
                return {
                    id: 'resp_1',
                    status: 'completed',
                    output: [{ type: 'message', content: [{ type: 'output_text', text: '{"verdict":"keep"}' }] }],
                };
            },
        },
    };
    const runner = createRoleRunner({
        client,
        config: { model: 'm', roles: {} },
        onEvent: (event) => events.push(event),
    });
    const result = await runner.run('extender', { text: 'x' });

    assert.equal(result.status, 'completed');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].stream, true, 'the answer is asked for as a stream');
    assert.deepEqual(events.map((event) => event.type), ['role.start', 'role.done']);
    assert.equal(events[0].role, 'extender');
    assert.equal(events[0].model, 'm');
});

test('a config may turn the stream off', async () => {
    const calls = [];
    const client = {
        responses: {
            async create(params) {
                calls.push(params);
                return { output: [] };
            },
        },
    };
    const runner = createRoleRunner({ client, config: { model: 'm', roles: {}, streaming: false } });
    await runner.run('extender', { text: 'x' });
    assert.equal(calls[0].stream, false);
});

test('the renderer shows the work of the moment and the time it takes', async () => {
    const renderer = createRenderer({ verbose: false });
    const { out } = await capture(async () => {
        renderer.event({ type: 'stage.start', stage: 'extend', label: 'Extend reference' });
        renderer.event({ type: 'role.start', role: 'extender', model: 'vendor/model' });
        await new Promise((resolve) => setTimeout(resolve, 300));
        renderer.event({ type: 'stage.done', stage: 'extend' });
    });
    assert.match(out, /Extend reference/);
    assert.match(out, /the extender role is answering \(vendor\/model\)/);
    assert.match(out, /· \d+ s/, 'the live line carries the elapsed time');
    assert.match(out, /✓ extend · \d+ s/, 'the stage leaves its duration behind');
    assert.match(out, /\r/, 'the live line is redrawn in place');
});

test('the plain renderer writes the progress as lines', async () => {
    const renderer = createPlainRenderer({ verbose: false });
    const { out, err } = await capture(async () => {
        renderer.event({ type: 'stage.start', stage: 'extend', label: 'Extend reference' });
        renderer.event({ type: 'role.start', role: 'extender', model: 'm' });
        renderer.event({ type: 'request.retry', attempt: 2, error: 'no data for 600 s' });
        renderer.event({ type: 'stage.done', stage: 'extend' });
    });
    assert.match(out, /\[extend\] the extender role is answering \(m\)/);
    assert.match(err, /retry 2: no data for 600 s/);
});

test('a duration is short enough to be read at a glance', () => {
    assert.equal(formatDuration(0), '0 s');
    assert.equal(formatDuration(12_400), '12 s');
    assert.equal(formatDuration(72_000), '1 m 12 s');
    assert.equal(formatDuration(3_840_000), '1 h 04 m');
});

test('the image route has a window of its own', () => {
    const config = { timeoutMs: 600_000, imageTimeoutMs: 900_000 };
    assert.equal(requestTimeoutMs(config, 'text'), 600_000);
    assert.equal(requestTimeoutMs(config, 'images'), 900_000);
    // A config without the fields falls back to the windows of the package.
    assert.equal(requestTimeoutMs({}, 'text'), 600_000);
    assert.equal(requestTimeoutMs({}, 'images'), 900_000);
});

test('a host that refuses the stream is recognized', () => {
    assert.equal(streamUnsupported({ status: 400, message: 'the stream parameter is not supported' }), true);
    assert.equal(streamUnsupported({ status: 400, message: 'bad model' }), false);
    assert.equal(streamUnsupported({ status: 500, message: 'stream error' }), false);
});

test('a stream that ends without the body of the response keeps its items', () => {
    const reducer = createStreamReducer({});
    reducer.handle({ type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } });
    reducer.handle({
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'message', content: [{ type: 'output_text', text: 'ready' }] },
    });
    // The host sends a slim `response.completed` event without the output.
    reducer.handle({ type: 'response.completed', response: { id: 'resp_1', status: 'completed' } });
    const response = reducer.finalResponse();
    assert.equal(response.output.length, 1);
    assert.equal(response.output[0].content[0].text, 'ready');
});

test('the renderer says what every stage decided and produced', async () => {
    const renderer = createPlainRenderer({ verbose: false });
    const { out } = await capture(async () => {
        renderer.event({
            type: 'extend.decision',
            verdict: 'extend',
            edges: ['top', 'bottom'],
            band: 128,
            after: { width: 1024, height: 1024 },
        });
        renderer.event({ type: 'extend.done', file: 'app.png', to: 'decomposition/extended/app.png', width: 1024, height: 1024 });
        renderer.event({ type: 'decompose.cut', screen: 'transfer', file: 'decomposition/screens/02-transfer.png' });
        renderer.event({ type: 'decompose.screens', screens: 3, files: 3, names: ['home', 'transfer', 'articles'] });
        renderer.event({ type: 'rectify.projected', file: 'decomposition/rectified/01-home.png', screen: 'home' });
        renderer.event({ type: 'rectify.file', file: 'decomposition/rectified/02-transfer.png', screen: 'transfer' });
        renderer.event({ type: 'resolve.json', path: 'C:/out/decomposition.json', screens: 3 });
        renderer.event({ type: 'resolve.done', path: 'C:/out/decomposition.json', screens: 3, layers: 12 });
    });
    assert.match(out, /the frame is cut at top \+ bottom/);
    assert.match(out, /extended: app\.png → decomposition\/extended\/app\.png/);
    assert.match(out, /cut: transfer → decomposition\/screens\/02-transfer\.png/);
    assert.match(out, /screens: 3, files: 3 \(home, transfer, articles\)/);
    assert.match(out, /projected: decomposition\/rectified\/01-home\.png \(home\)/);
    assert.match(out, /rectified: decomposition\/rectified\/02-transfer\.png \(transfer\)/);
    assert.match(out, /output: C:\/out\/decomposition\.json \(3 screens, 12 layers\)/);
});

test('the final summary names the output and every screen', async () => {
    const renderer = createPlainRenderer({ verbose: false });
    const { out } = await capture(async () => {
        renderer.summary({
            output: {
                screens: [
                    { name: 'home', subReference: 'decomposition/screens/01-home.png' },
                    { name: 'transfer', subReference: 'decomposition/screens/02-transfer.png' },
                    { name: 'articles', subReference: null },
                ],
                subReferences: [],
                layers: [],
            },
            outputPath: 'C:/out/decomposition.json',
            warnings: ['decompose: screen articles was not cut'],
        });
    });
    assert.match(out, /output: C:\/out\/decomposition\.json/);
    assert.match(out, /screens: 3/);
    assert.match(out, /- home → decomposition\/screens\/01-home\.png/);
    assert.match(out, /- articles → \(no file\)/);
    assert.match(out, /warnings: 1/);
});
