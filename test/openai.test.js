/**
 * @file test/openai.test.js
 * @module test/openai
 * @purpose Tests of the AI subsystem: request building, answer parsing, backends, fallbacks
 *          and the client against a local mock host.
 * @depends node:test, node:http, openai/*
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { buildResponsesBody, parseResponse, extractToolCalls, imagePart } from '../src/openai/responses.js';
import { encodeMultipart, imageSizeFields, resolveImageFormat, sniffImage, parseImageSize, paddedSizeToMinPixels } from '../src/openai/images.js';
import { createClient, resolveBackends, retryDelayMs } from '../src/openai/client.js';
import { outOfCredit } from '../src/openai/errors.js';
import { fallbackChain, fallbackModels, withModelFallback } from '../src/openai/fallback.js';
import { getModelProfile, snapEffort, contextBytes } from '../src/model/profiles.js';
import { toChatBody, fromChatCompletion, responsesRouteUnsupported } from '../src/openai/chat.js';

/** A 1×1 PNG, used where the answer of the images API is checked. */
const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
);

/**
 * Start a mock API host.
 * @param {(req: object, res: object, body: string) => void} handler
 * @returns {Promise<{ url: string, close: () => Promise<void>, calls: object[] }>}
 */
async function startServer(handler) {
    const calls = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            calls.push({ url: req.url, method: req.method, headers: req.headers, body });
            handler(req, res, body);
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return {
        url: `http://127.0.0.1:${port}/v1`,
        calls,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

/**
 * Answer with JSON.
 * @param {object} res
 * @param {object} payload
 * @returns {void}
 */
function sendJson(res, payload) {
    const text = JSON.stringify(payload);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(text);
}

test('buildResponsesBody packs instructions, text and images into one request', () => {
    const body = buildResponsesBody({
        model: 'openai/gpt-6.1-sol',
        instructions: 'Be exact.',
        input: 'What is on the picture?',
        parts: [imagePart(PNG_1PX, 'image/png')],
        effort: 'high',
        maxOutputTokens: 1024,
    });
    assert.equal(body.model, 'openai/gpt-6.1-sol');
    assert.equal(body.instructions, 'Be exact.');
    assert.equal(body.input.length, 1);
    assert.equal(body.input[0].role, 'user');
    assert.equal(body.input[0].content[0].type, 'input_text');
    assert.equal(body.input[0].content[1].type, 'input_image');
    assert.match(body.input[0].content[1].image_url, /^data:image\/png;base64,/);
    assert.deepEqual(body.reasoning, { effort: 'high' });
    assert.equal(body.max_output_tokens, 1024);
});

test('buildResponsesBody adds the schema as a tool and as the text format', () => {
    const schema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] };
    const body = buildResponsesBody({ model: 'm', input: 'x', schema, schemaName: 'plan' });
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0].name, 'plan');
    assert.deepEqual(body.tools[0].parameters, schema);
    assert.equal(body.text.format.type, 'json_schema');
    assert.equal(body.text.format.name, 'plan');
    assert.equal(body.text.format.strict, true);
});

test('parseResponse reads the text, the JSON payload and the tool calls', () => {
    const raw = {
        id: 'resp_1',
        status: 'completed',
        model: 'm',
        output: [
            { type: 'message', content: [{ type: 'output_text', text: '{"verdict":"clean"}' }] },
            { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'crop_image', arguments: '{"path":"a.png"}' },
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    };
    const parsed = parseResponse(raw);
    assert.equal(parsed.text, '{"verdict":"clean"}');
    assert.deepEqual(parsed.data, { verdict: 'clean' });
    assert.equal(parsed.toolCalls.length, 1);
    assert.equal(parsed.toolCalls[0].name, 'crop_image');
    assert.deepEqual(parsed.toolCalls[0].arguments, { path: 'a.png' });
    assert.equal(parsed.usage.total, 15);
    assert.equal(extractToolCalls(raw).length, 1);
});

test('encodeMultipart writes the fields and the file bytes', () => {
    const { body, contentType } = encodeMultipart({
        fields: { model: 'm', prompt: 'draw' },
        files: [{ field: 'image', filename: 'a.png', mime: 'image/png', bytes: PNG_1PX }],
    });
    assert.match(contentType, /^multipart\/form-data; boundary=/);
    const text = body.toString('latin1');
    assert.match(text, /name="model"\r\n\r\nm\r\n/);
    assert.match(text, /name="image"; filename="a\.png"/);
    assert.ok(text.includes(PNG_1PX.toString('latin1')));
});

test('imageSizeFields follows the model family', () => {
    const modern = imageSizeFields({ size: '1024x1536', model: 'openai/gpt-image-2.6-sunburst', format: 'png', quality: 'high' });
    assert.equal(modern.size, '1024x1536');
    assert.equal(modern.output_format, 'png');
    assert.equal(modern.quality, 'high');
    const legacy = imageSizeFields({ size: '1024x1024', model: 'dall-e-3' });
    assert.equal(legacy.response_format, 'b64_json');
    assert.equal(legacy.output_format, undefined);
});

test('image helpers read sizes and formats', () => {
    assert.deepEqual(parseImageSize('1024x768'), { width: 1024, height: 768 });
    assert.equal(parseImageSize('nope'), null);
    assert.equal(resolveImageFormat({ format: 'jpg' }), 'jpeg');
    assert.deepEqual(sniffImage(PNG_1PX), { mime: 'image/png', ext: '.png' });
    assert.deepEqual(paddedSizeToMinPixels({ width: 512, height: 512 }), { width: 1024, height: 1024 });
    assert.equal(paddedSizeToMinPixels({ width: 2048, height: 2048 }), null);
});

test('resolveBackends takes the key from the named environment variable', () => {
    const config = {
        baseURL: 'https://primary.example/v1',
        apiKey: 'primary-key',
        backends: [
            { baseURL: 'https://a.example/v1', env: 'A_KEY' },
            { baseURL: 'https://b.example/v1', apiKey: 'b-key' },
            { baseURL: 'https://c.example/v1' },
        ],
    };
    const chain = resolveBackends(config, { env: { A_KEY: 'a-key' } });
    assert.equal(chain.length, 2);
    assert.equal(chain[0].baseURL, 'https://a.example/v1');
    assert.equal(chain[0].apiKey, 'a-key');
    assert.equal(chain[1].apiKey, 'b-key');
});

test('resolveBackends falls back to the primary URL when no backend has a key', () => {
    const chain = resolveBackends({ baseURL: 'https://primary.example/v1', apiKey: 'k', backends: [{ baseURL: 'https://a.example/v1' }] }, { env: {} });
    assert.equal(chain[0].baseURL, 'https://primary.example/v1');
    assert.equal(chain[0].apiKey, 'k');
});

test('the fallback chain lists the model and its fallbacks', () => {
    const config = { fallback: { enabled: true, models: { 'model-a': ['model-b'], '*': ['model-c'] } } };
    assert.deepEqual(fallbackModels(config, 'model-a'), ['model-b', 'model-c']);
    assert.deepEqual(fallbackChain(config, 'model-a'), ['model-a', 'model-b', 'model-c']);
    assert.deepEqual(fallbackChain({ fallback: { enabled: false, models: { 'model-a': ['model-b'] } } }, 'model-a'), ['model-a']);
});

test('withModelFallback moves on to the next model after a failure', async () => {
    const config = { fallback: { enabled: true, models: { 'model-a': ['model-b'] } } };
    const seen = [];
    const { result, model } = await withModelFallback({
        config,
        model: 'model-a',
        call: async (candidate) => {
            seen.push(candidate);
            if (candidate === 'model-a') throw new Error('model is overloaded');
            return 'answer';
        },
    });
    assert.deepEqual(seen, ['model-a', 'model-b']);
    assert.equal(result, 'answer');
    assert.equal(model, 'model-b');
});

test('model profiles clamp the effort and resolve the context budget', () => {
    const profile = getModelProfile('openai/gpt-6-luna');
    assert.equal(snapEffort('xhigh', profile), 'medium');
    assert.equal(snapEffort('low', profile), 'low');
    assert.equal(snapEffort('high', { ceiling: 'high', efforts: ['low', 'medium', 'high'] }), 'high');
    assert.equal(snapEffort('max', { ceiling: null, efforts: null }), 'max');
    assert.equal(contextBytes('small', profile), 16 * 1024);
    assert.equal(contextBytes('auto', profile), profile.window);
    assert.equal(contextBytes(2048, profile), 2048);
});

test('retryDelayMs waits longer on a rate limit', () => {
    assert.ok(retryDelayMs(0, null, 429) >= 3000);
    assert.ok(retryDelayMs(0, '2', null) >= 2000);
});

test('the chat transport carries the request and the answer over', () => {
    const body = toChatBody({
        model: 'm',
        instructions: 'Be exact.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
        reasoning: { effort: 'high' },
        text: { format: { type: 'json_schema', name: 'plan', schema: { type: 'object' } } },
    });
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages[1].content, 'hello');
    assert.equal(body.reasoning_effort, 'high');
    assert.equal(body.response_format.type, 'json_schema');

    const answer = fromChatCompletion({
        id: 'chat_1',
        model: 'm',
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    });
    assert.equal(answer.status, 'completed');
    assert.equal(answer.output_text, '{"ok":true}');
    assert.equal(answer.usage.total_tokens, 7);
});

test('a missing route is told apart from a missing model', () => {
    assert.equal(responsesRouteUnsupported({ status: 404, message: 'not found' }), true);
    assert.equal(responsesRouteUnsupported({ status: 400, apiCode: 'model_not_found', message: 'unknown model' }), false);
});

test('the client asks the Responses API and reads the answer', async () => {
    const server = await startServer((req, res) => {
        if (req.url === '/v1/responses') {
            sendJson(res, {
                id: 'resp_1',
                status: 'completed',
                model: 'm',
                output: [{ type: 'message', content: [{ type: 'output_text', text: '{"verdict":"clean"}' }] }],
                usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
            });
            return;
        }
        res.writeHead(404).end('{}');
    });
    try {
        const client = await createClient({
            config: { baseURL: server.url, apiKey: 'test', backends: [{ baseURL: server.url, apiKey: 'test' }] },
            env: {},
        });
        const answer = await client.responses.create({ model: 'm', input: 'hello', instructions: 'Be exact.' });
        const parsed = parseResponse(answer);
        assert.equal(parsed.text, '{"verdict":"clean"}');
        assert.deepEqual(parsed.data, { verdict: 'clean' });
        assert.equal(parsed.usage.total, 6);
        const sent = JSON.parse(server.calls[0].body);
        assert.equal(sent.model, 'm');
        assert.equal(sent.instructions, 'Be exact.');
        assert.equal(server.calls[0].headers.authorization, 'Bearer test');
        client.close();
    } finally {
        await server.close();
    }
});

test('the client falls back to Chat Completions when the host has no Responses route', async () => {
    const server = await startServer((req, res) => {
        if (req.url === '/v1/responses') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'unknown route /v1/responses', code: 'not_found' } }));
            return;
        }
        if (req.url === '/v1/chat/completions') {
            sendJson(res, {
                id: 'chat_1',
                model: 'm',
                choices: [{ message: { content: '{"verdict":"clean"}' }, finish_reason: 'stop' }],
            });
            return;
        }
        res.writeHead(404).end('{}');
    });
    try {
        const client = await createClient({
            config: { baseURL: server.url, apiKey: 'test', backends: [{ baseURL: server.url, apiKey: 'test' }] },
            env: {},
        });
        const answer = await client.responses.create({ model: 'm', input: 'hello' });
        const parsed = parseResponse(answer);
        assert.equal(parsed.text, '{"verdict":"clean"}');
        assert.ok(server.calls.some((call) => call.url === '/v1/chat/completions'));
        client.close();
    } finally {
        await server.close();
    }
});

test('the client rotates to the next backend when one fails', async () => {
    const broken = await startServer((req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'gateway is down' } }));
    });
    const healthy = await startServer((req, res) => {
        sendJson(res, {
            id: 'resp_2', status: 'completed', model: 'm',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
        });
    });
    try {
        const client = await createClient({
            config: {
                baseURL: broken.url,
                apiKey: 'test',
                retries: 0,
                limits: { requestRetries: 0 },
                backends: [{ baseURL: broken.url, apiKey: 'test' }, { baseURL: healthy.url, apiKey: 'test' }],
            },
            env: {},
        });
        const answer = await client.responses.create({ model: 'm', input: 'hello' });
        assert.equal(parseResponse(answer).text, 'ok');
        assert.ok(healthy.calls.length >= 1);
        client.close();
    } finally {
        await broken.close();
        await healthy.close();
    }
});

test('the text request goes to the next host and the next model when the first one refuses it', async () => {
    const broke = await startServer((req, res) => {
        res.writeHead(402).end(JSON.stringify({ detail: 'Insufficient balance to run this request.' }));
    });
    const healthy = await startServer((req, res, body) => {
        if (req.url === '/v1/responses' && JSON.parse(body).model === 'vendor/other-model') {
            sendJson(res, {
                id: 'resp_3', status: 'completed', model: 'vendor/other-model',
                output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
            });
            return;
        }
        res.writeHead(404).end(JSON.stringify({ detail: 'The model is not available here.' }));
    });
    try {
        const client = await createClient({
            config: {
                baseURL: broke.url,
                apiKey: 'test',
                retries: 0,
                limits: { requestRetries: 0 },
                backends: [{ baseURL: broke.url, apiKey: 'test' }, { baseURL: healthy.url, apiKey: 'test' }],
                fallback: {
                    enabled: true,
                    //models: { 'moonshotai/kimi-k3.1-pro': ['vendor/other-model'] },
                    models: { 'minimax/minimax-m3.1-flash': ['vendor/other-model'] }
                },
            },
            env: {},
        });
        const answer = await client.responses.create({ model: 'minimax/minimax-m3.1-flash'/*'moonshotai/kimi-k3.1-pro'*/, input: 'hello' });
        assert.equal(parseResponse(answer).text, 'ok');
        assert.equal(broke.calls.length, 1, 'the host without balance was asked once');
        client.close();
    } finally {
        await broke.close();
        await healthy.close();
    }
});

test('the client edits an image and returns PNG bytes', async () => {
    const server = await startServer((req, res) => {
        if (req.url === '/v1/images/edits') {
            sendJson(res, { data: [{ b64_json: PNG_1PX.toString('base64') }] });
            return;
        }
        res.writeHead(404).end('{}');
    });
    try {
        const client = await createClient({
            config: { baseURL: server.url, apiKey: 'test', imagesBackends: [{ baseURL: server.url, apiKey: 'test' }] },
            env: {},
        });
        const { images } = await client.images.edit({
            model: 'openai/gpt-image-2.6-sunburst',
            prompt: 'restore the details',
            format: 'png',
            image: { filename: 'frag.png', mime: 'image/png', bytes: PNG_1PX },
        });
        assert.equal(images.length, 1);
        assert.equal(images[0].mime, 'image/png');
        assert.deepEqual(images[0].bytes, PNG_1PX);
        const sent = server.calls[0];
        assert.equal(sent.method, 'POST');
        assert.match(sent.headers['content-type'], /^multipart\/form-data; boundary=/);
        assert.match(sent.body, /name="prompt"\r\n\r\nrestore the details/);
        client.close();
    } finally {
        await server.close();
    }
});

test('the picture request goes to the next model when the first one refuses it', async () => {
    const server = await startServer((req, res, body) => {
        if (req.url === '/v1/images/generations') {
            const model = JSON.parse(body).model;
            if (model === 'openai/gpt-image-2.6-sunburst') {
                // The host does not serve this model — it is not the money of the account.
                res.writeHead(404).end(JSON.stringify({ detail: 'The model is not available here.' }));
                return;
            }
            sendJson(res, { data: [{ b64_json: PNG_1PX.toString('base64') }] });
            return;
        }
        res.writeHead(404).end('{}');
    });
    try {
        const client = await createClient({
            config: {
                baseURL: server.url,
                apiKey: 'test',
                imagesBackends: [{ baseURL: server.url, apiKey: 'test' }],
                fallback: {
                    enabled: true,
                    models: { 
                        'openai/gpt-image-2.6-sunburst': ['bytedance-seed/seedream-5-5']
                        //'openai/gpt-image-2.6-sunburst': ['openai/gpt-image-2.6-flare'] 
                    },
                },
            },
            env: {},
        });
        const events = [];
        const answer = await client.images.generate({
            model: 'openai/gpt-image-2.6-sunburst',
            prompt: 'a cat in space',
            size: '1024x1024',
            format: 'png',
        });
        //assert.equal(answer.model, 'openai/gpt-image-2.6-flare');
        assert.equal(answer.model, 'bytedance-seed/seedream-5-5');
        assert.equal(answer.images.length, 1);
        const models = server.calls.map((call) => JSON.parse(call.body).model);
        assert.deepEqual(models, ['openai/gpt-image-2.6-sunburst', 'bytedance-seed/seedream-5-5'/*, 'openai/gpt-image-2.6-flare'*/]);
        void events;
        client.close();
    } finally {
        await server.close();
    }
});

test('the picture request goes to the next host when the first one has no balance', async () => {
    const broke = await startServer((req, res) => {
        res.writeHead(402, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'Insufficient balance to run this request.' }));
    });
    const healthy = await startServer((req, res) => {
        sendJson(res, { data: [{ b64_json: PNG_1PX.toString('base64') }] });
    });
    try {
        const client = await createClient({
            config: {
                baseURL: broke.url,
                apiKey: 'test',
                imagesBackends: [{ baseURL: broke.url, apiKey: 'test' }, { baseURL: healthy.url, apiKey: 'test' }],
            },
            env: {},
        });
        const answer = await client.images.generate({
            model: 'openai/gpt-image-2.6-sunburst',
            prompt: 'a cat in space',
            size: '1024x1024',
            format: 'png',
        });
        assert.equal(answer.images.length, 1);
        assert.equal(broke.calls.length, 1, 'the host without balance was asked once');
        assert.equal(healthy.calls.length, 1, 'the next host took the request');
        client.close();
    } finally {
        await broke.close();
        await healthy.close();
    }
});

test('a host without balance is not asked again in the same run', async () => {
    const broke = await startServer((req, res) => {
        res.writeHead(402, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'Insufficient balance to run this request.' }));
    });
    const healthy = await startServer((req, res) => {
        sendJson(res, { data: [{ b64_json: PNG_1PX.toString('base64') }] });
    });
    try {
        const events = [];
        const client = await createClient({
            config: {
                baseURL: broke.url,
                apiKey: 'test',
                imagesBackends: [{ baseURL: broke.url, apiKey: 'test' }, { baseURL: healthy.url, apiKey: 'test' }],
            },
            env: {},
            onEvent: (event) => events.push(event),
        });
        for (let attempt = 0; attempt < 2; attempt++) {
            const answer = await client.images.generate({
                model: 'openai/gpt-image-2.6-sunburst',
                prompt: 'a cat in space',
                size: '1024x1024',
                format: 'png',
            });
            assert.equal(answer.images.length, 1);
        }
        assert.equal(broke.calls.length, 1, 'the host without balance was asked once, not twice');
        assert.equal(healthy.calls.length, 2);
        const brokeEvents = events.filter((event) => event.type === 'host.broke');
        assert.equal(brokeEvents.length, 1);
        assert.equal(brokeEvents[0].backend, broke.url);
        client.close();
    } finally {
        await broke.close();
        await healthy.close();
    }
});

test('the reason of a refusal is read from the detail of the answer', async () => {
    const server = await startServer((req, res) => {
        res.writeHead(402, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'Insufficient balance to run this request.' }));
    });
    try {
        const client = await createClient({
            config: { baseURL: server.url, apiKey: 'test', imagesBackends: [{ baseURL: server.url, apiKey: 'test' }] },
            env: {},
        });
        await assert.rejects(() => client.images.generate({
            model: 'openai/gpt-image-2.6-sunburst',
            prompt: 'a cat in space',
            size: '1024x1024',
            format: 'png',
        }), /Insufficient balance to run this request\./);
        client.close();
    } finally {
        await server.close();
    }
});

test('outOfCredit tells a refusal of money from any other refusal', () => {
    assert.equal(outOfCredit({ status: 402 }), true);
    assert.equal(outOfCredit({ message: 'Insufficient balance to run this request.' }), true);
    assert.equal(outOfCredit({ message: 'insufficient_quota' }), true);
    assert.equal(outOfCredit({ status: 500, message: 'the gateway is down' }), false);
    assert.equal(outOfCredit({ status: 404, message: 'model not found' }), false);
});

test('the client generates an image and returns PNG bytes', async () => {
    const server = await startServer((req, res) => {
        if (req.url === '/v1/images/generations') {
            sendJson(res, { data: [{ b64_json: PNG_1PX.toString('base64') }] });
            return;
        }
        res.writeHead(404).end('{}');
    });
    try {
        const client = await createClient({
            config: { baseURL: server.url, apiKey: 'test', imagesBackends: [{ baseURL: server.url, apiKey: 'test' }] },
            env: {},
        });
        const { images } = await client.images.generate({
            model: 'openai/gpt-image-2.6-sunburst',
            prompt: 'a cat in space',
            size: '1024x1024',
            format: 'png',
        });
        assert.equal(images.length, 1);
        assert.deepEqual(images[0].bytes, PNG_1PX);
        const sent = JSON.parse(server.calls[0].body);
        assert.equal(sent.prompt, 'a cat in space');
        assert.equal(sent.size, '1024x1024');
        client.close();
    } finally {
        await server.close();
    }
});
