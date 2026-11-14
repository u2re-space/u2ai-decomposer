/**
 * @file test/batch.test.js
 * @module test/batch
 * @purpose Tests of the batch route: the file of the requests, the answers of the file, the
 *          journal that keeps an answer between the two phases, and the queue that turns a
 *          round of parallel calls into one batch.
 * @depends node:test, openai/batch, openai/journal
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import {
    BATCH_SUBMITTED, batchEndpointFor, buildBatchJsonl, createBatcher, fetchBatch,
    parseBatchResults, submitBatch,
} from '../src/openai/batch.js';
import { createJournal, hashBytes, hashValue, stableStringify } from '../src/openai/journal.js';

/** A channel that answers from a table and remembers what it was asked. */
const fakeChannel = (answers = {}) => {
    const calls = [];
    return {
        calls,
        async call(route, options = {}) {
            calls.push({ route, options });
            const answer = answers[route];
            if (typeof answer === 'function') return await answer(route, options);
            if (answer === undefined) throw new Error(`the host does not know ${route}`);
            return answer;
        },
    };
};

test('the file of a batch is one JSON-object per line, named by custom_id', () => {
    const file = buildBatchJsonl([
        { customId: 'a', body: { model: 'vendor/model', input: [] } },
        { customId: 'b', url: '/v1/chat/completions', method: 'POST', body: { model: 'vendor/model' } },
        { body: { model: 'vendor/model' } },
    ]).toString('utf8');
    const lines = file.trim().split('\n');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.custom_id, 'a');
    assert.equal(first.method, 'POST');
    assert.equal(first.url, '/v1/responses');
    assert.deepEqual(first.body, { model: 'vendor/model', input: [] });
    assert.equal(JSON.parse(lines[1]).custom_id, 'b');
});

test('the answers of a batch are found by custom_id, and a broken line does not spoil the rest', () => {
    const text = [
        '{"custom_id":"a","response":{"status_code":200,"body":{"output_text":"first"}}}',
        '{ this is not json',
        '{"custom_id":"b","error":{"message":"the model is not there"}}',
        '{"custom_id":"c","response":{"status_code":200,"body":{"output_text":"third"}}}',
    ].join('\n');
    const results = parseBatchResults(text);
    assert.equal(results.size, 3);
    assert.equal(results.get('a').ok, true);
    assert.equal(results.get('a').body.output_text, 'first');
    assert.equal(results.get('b').ok, false);
    assert.match(results.get('b').error, /not there/);
    assert.equal(results.get('c').ok, true);
});

test('the route of the batch comes from the base URL of the host', () => {
    assert.equal(batchEndpointFor('https://api.proxyapi.ru/v1'), '/v1/responses');
    assert.equal(batchEndpointFor('https://sprutdock.ru/v1'), '/v1/responses');
    assert.equal(batchEndpointFor('https://routerai.ru/api/v1'), '/api/v1/responses');
});

test('the first phase uploads the file of the requests and creates the batch', async () => {
    const channel = fakeChannel({
        files: { id: 'file-1' },
        batches: { id: 'batch-1', status: 'validating' },
    });
    const submitted = await submitBatch({
        channel,
        requests: [{ customId: 'a', url: '/v1/responses', body: { model: 'vendor/model' } }],
        endpoint: '/v1/responses',
    });
    assert.equal(submitted.id, 'batch-1');
    assert.equal(submitted.inputFileId, 'file-1');
    const upload = channel.calls.find((call) => call.route === 'files');
    assert.equal(upload.options.method, 'POST');
    assert.match(String(upload.options.contentType), /^multipart\/form-data/);
    assert.match(upload.options.rawBody.toString('utf8'), /name="purpose"\r\n\r\nbatch/);
    const create = channel.calls.find((call) => call.route === 'batches');
    assert.deepEqual(create.options.body, {
        input_file_id: 'file-1',
        endpoint: '/v1/responses',
        completion_window: '24h',
    });
});

test('the second phase takes the answers of the batch and puts them by custom_id', async () => {
    const channel = fakeChannel({
        'batches/batch-1': { id: 'batch-1', status: 'completed', output_file_id: 'file-out' },
        'files/file-out/content': '{"custom_id":"a","response":{"status_code":200,"body":{"output_text":"hi"}}}\n',
    });
    const fetched = await fetchBatch({ channel, id: 'batch-1' });
    assert.equal(fetched.ready, true);
    assert.equal(fetched.results.get('a').body.output_text, 'hi');
});

test('a batch that is not done yet is not an error, it is not ready', async () => {
    const channel = fakeChannel({ 'batches/batch-1': { id: 'batch-1', status: 'in_progress' } });
    const fetched = await fetchBatch({ channel, id: 'batch-1', waitMs: 0 });
    assert.equal(fetched.ready, false);
    assert.equal(fetched.status, 'in_progress');
});

test('the journal keeps an answer under the hash of the request', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-journal-'));
    try {
        const journal = createJournal({ dir });
        const body = { model: 'vendor/model', input: [{ role: 'user', content: [] }] };
        const hash = journal.hash(body);
        assert.equal(hash.length, 64);
        assert.equal(await journal.read(hash), null);

        await journal.writeJson(hash, { output_text: 'the answer' });
        const read = await journal.read(hash);
        assert.equal(read.kind, 'json');
        assert.equal(read.value.output_text, 'the answer');

        // The same question always has the same name, whatever the order of the keys.
        assert.equal(journal.hash({ input: body.input, model: body.model }), hash);

        const bytesHash = journal.hashBytes(Buffer.from('the picture'));
        await journal.writeBytes(bytesHash, Buffer.from('the picture'));
        const bytes = await journal.read(bytesHash);
        assert.equal(bytes.kind, 'bytes');
        assert.equal(bytes.value.toString('utf8'), 'the picture');

        await journal.writeError(hash, 'the request failed');
        const failed = await journal.read(hash);
        assert.equal(failed.kind, 'error');
        assert.match(failed.value, /failed/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('the journal remembers the batches that were submitted', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-journal-'));
    try {
        const journal = createJournal({ dir });
        await journal.saveBatch({
            id: 'batch-1',
            host: 'https://api.proxyapi.ru/v1',
            endpoint: '/v1/responses',
            requests: [{ customId: 'a', hash: 'h1', model: 'vendor/model' }],
        });
        const rows = await journal.listBatches();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].done, false);
        assert.equal(rows[0].requests[0].hash, 'h1');

        await journal.updateBatch('batch-1', { done: true, status: 'completed' });
        const done = await journal.listBatches();
        assert.equal(done[0].done, true);
        assert.equal(done[0].status, 'completed');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('a round of one request is not a batch: it goes the usual way', async () => {
    const sent = [];
    const batcher = createBatcher({
        collectMs: 5,
        send: async (params) => { sent.push(params); return { output_text: 'one by one' }; },
        run: async () => { throw new Error('the batch must not be used'); },
    });
    const answer = await batcher.add({ model: 'vendor/model', params: { text: 'a' } });
    assert.equal(answer.output_text, 'one by one');
    assert.equal(sent.length, 1);
});

test('a round of many requests goes as one batch, and the answers come by custom_id', async () => {
    const groups = [];
    const batcher = createBatcher({
        collectMs: 5,
        send: async () => { throw new Error('the requests must not go one by one'); },
        run: async (group) => {
            groups.push(group);
            const answers = new Map();
            for (const item of group) answers.set(item.customId, { ok: true, body: { id: item.customId } });
            return answers;
        },
    });
    const [first, second] = await Promise.all([
        batcher.add({ model: 'vendor/model', params: { text: 'a' } }),
        batcher.add({ model: 'vendor/model', params: { text: 'b' } }),
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].length, 2);
    assert.notEqual(first.id, second.id);
});

test('a batch that did not work out sends its requests one by one', async () => {
    const sent = [];
    const batcher = createBatcher({
        collectMs: 5,
        send: async (params) => { sent.push(params); return { output_text: 'fallback' }; },
        run: async () => { throw new Error('the host does not serve the batch route'); },
    });
    const answers = await Promise.all([
        batcher.add({ model: 'vendor/model', params: { text: 'a' } }),
        batcher.add({ model: 'vendor/model', params: { text: 'b' } }),
    ]);
    assert.equal(answers.length, 2);
    assert.equal(sent.length, 2);
    assert.equal(answers[0].output_text, 'fallback');
});

test('a submitted batch refuses its requests with BATCH_SUBMITTED: the answers are not here yet', async () => {
    const batcher = createBatcher({
        collectMs: 5,
        send: async () => { throw new Error('the requests must not go one by one'); },
        run: async () => ({ pending: true, batchId: 'batch-1' }),
    });
    const answers = await Promise.allSettled([
        batcher.add({ model: 'vendor/model', params: { text: 'a' } }),
        batcher.add({ model: 'vendor/model', params: { text: 'b' } }),
    ]);
    for (const answer of answers) {
        assert.equal(answer.status, 'rejected');
        assert.equal(answer.reason.code, BATCH_SUBMITTED);
    }
    assert.equal(answers[0].reason.details.batchId, 'batch-1');
});

test('the name of a request does not depend on the order of the keys', () => {
    assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.equal(hashValue({ b: 1, a: 2 }), hashValue({ a: 2, b: 1 }));
    assert.notEqual(hashValue({ a: 1 }), hashValue({ a: 2 }));
});
