/**
 * @file test/worker.test.js
 * @module test/worker
 * @purpose Tests of the internal worker: its operator channel, its protocol and its child process.
 * @depends node:test, node:assert, cli/protocol, cli/worker, tui/worker-client
 * @ai.tags test, worker, ipc
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrame, FRAME, isFrame, PROTOCOL_VERSION } from '../src/cli/protocol.js';
import { createWorkerInput } from '../src/cli/worker.js';
import { createWorkerClient } from '../src/tui/worker-client.js';

test('a protocol frame carries its version and only a known kind', () => {
    const frame = createFrame(FRAME.ready, { pid: 42 });
    assert.equal(frame.v, PROTOCOL_VERSION);
    assert.equal(frame.type, 'ready');
    assert.equal(frame.pid, 42);
    assert.equal(isFrame(frame), true);
    assert.equal(isFrame({ v: 99, type: 'ready' }), false);
    assert.throws(() => createFrame('unknown'), /Unknown protocol frame/);
});

test('the worker operator channel keeps steering, questions, skips and quit apart', async () => {
    const frames = [];
    const input = createWorkerInput({ send: (frame) => frames.push(frame) });

    input.receive(createFrame(FRAME.input, { text: 'split the screen' }));
    assert.deepEqual(input.takeSteering(), ['split the screen']);

    input.setLocation({ stage: 'decompose', role: 'reception', model: 'test/model', effort: 'high' });
    assert.equal(frames.at(-1).type, 'status');
    assert.equal(frames.at(-1).location.role, 'reception');
    assert.equal(frames.at(-1).location.model, 'test/model');

    const answer = input.askUser('Which picture?');
    const question = frames.at(-1);
    assert.equal(question.type, 'question');
    assert.equal(question.kind, 'ask_user');
    assert.equal(input.receive(createFrame(FRAME.answer, { id: question.id, text: 'screen.png' })), true);
    assert.equal(await answer, 'screen.png');

    input.receive(createFrame(FRAME.command, { name: 'quit' }));
    assert.equal(input.shouldQuit(), true);
    input.close();
});

test('the worker is a child process with a ready frame, live output and a result', async () => {
    const frames = [];
    const logs = [];
    const client = createWorkerClient({
        args: ['--help'],
        onFrame: (frame) => frames.push(frame),
        onLog: (line) => logs.push(line),
    });
    const exit = await client.finished;

    assert.equal(exit.code, 0);
    assert.equal(frames[0].type, 'ready');
    assert.equal(frames.at(-1).type, 'result');
    assert.equal(frames.at(-1).code, 0);
    assert.ok(logs.some((item) => item.stream === 'stdout' && item.line.includes('ai-decompose')));
});
