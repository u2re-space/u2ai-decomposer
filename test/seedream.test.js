/**
 * @file test/seedream.test.js
 * @purpose Tests of the seedream-5.5 client: the bodies of the two modes, the geometry of the
 *          layer boxes and the task runner.
 * @depends node:test, openai/seedream
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import {
    SEEDREAM_MODEL, decomposeLayers, generateImage, generationBody, isSeedream55,
    layerDecompositionBody, normalizeLayerBox, parseLayerDecomposition, seedreamGenerationSize,
    seedreamLayerSize, taskImageSources,
} from '../src/openai/seedream.js';

const PNG = await sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
}).png().toBuffer();

const dataUri = (bytes) => `data:image/png;base64,${bytes.toString('base64')}`;

/** A channel that answers the task route and records what it was asked. */
const fakeChannel = (answer, calls = []) => ({
    label: 'fake-host',
    call: async (path, options = {}) => {
        calls.push({ path, body: options.body ?? null, method: options.method ?? 'POST' });
        if (path === 'images/generations') {
            return { code: 200, data: [{ status: 'submitted', task_id: 'task-1' }] };
        }
        if (path.startsWith('tasks/')) return answer;
        throw new Error(`unexpected route: ${path}`);
    },
});

// ---------------------------------------------------------------------------
// The bodies
// ---------------------------------------------------------------------------

test('the decomposition body carries one image and no background', () => {
    const body = layerDecompositionBody({ source: { bytes: PNG, mime: 'image/png' } });
    assert.equal(body.model, SEEDREAM_MODEL);
    assert.equal(body.layer_decomposition, true);
    assert.equal(body.image_urls.length, 1);
    assert.match(body.image_urls[0], /^data:image\/png;base64,/);
    assert.equal(body.size, 'auto');
    assert.equal('background' in body, false, 'the vendor refuses a background in the decomposition mode');
    assert.equal('n' in body, false, 'the decomposition mode answers one task');
    assert.deepEqual(body.layer_decomposition_options, { text_recognition: true });
});

test('the decomposition body asks for as many outputs as layers are wanted', () => {
    const body = layerDecompositionBody({ source: { bytes: PNG }, maxImages: 12, textRecognition: false });
    assert.deepEqual(body.layer_decomposition_options, { max_images: 12 });
    const refused = layerDecompositionBody({ source: { bytes: PNG }, maxImages: 1, textRecognition: false });
    assert.equal('max_images' in (refused.layer_decomposition_options ?? {}), false, 'the gateway clamps the count to [2, 100]');
});

test('the decomposition needs exactly one input image', () => {
    assert.throws(() => layerDecompositionBody({ source: { bytes: Buffer.alloc(0) } }), /exactly one input image/);
});

test('the decomposition only asks for the tiers the vendor accepts', () => {
    assert.equal(seedreamLayerSize('2K'), '2K');
    assert.equal(seedreamLayerSize('1.5k'), '1.5K');
    assert.equal(seedreamLayerSize('16:9'), 'auto', 'a ratio is a synchronous 400 in this mode');
    assert.equal(seedreamLayerSize('1024x1024'), 'auto');
});

test('the generation body carries the prompt and the references', () => {
    const body = generationBody({ prompt: 'a cat', references: ['https://example.com/a.png'] });
    assert.equal(body.prompt, 'a cat');
    assert.deepEqual(body.image_urls, ['https://example.com/a.png']);
    assert.equal(body.output_format, 'png');
    assert.equal(body.background, 'transparent');
    assert.equal('n' in body, false);
    assert.throws(() => generationBody({ prompt: '  ' }), /needs a prompt/);
    assert.throws(() => generationBody({ prompt: 'x', references: Array.from({ length: 11 }, (_, i) => `${i}`) }), /at most 10/);
});

test('a transparent JPEG is not a request the vendor accepts', () => {
    const body = generationBody({ prompt: 'a cat', background: 'transparent', format: 'jpeg' });
    assert.equal('background' in body, false);
    assert.equal(body.output_format, 'jpeg');
});

test('the generation frame accepts the tiers, the ratios and the exact frames in budget', () => {
    assert.equal(seedreamGenerationSize(''), '1K');
    assert.equal(seedreamGenerationSize('2K'), '2K');
    assert.equal(seedreamGenerationSize('16:9'), '16:9');
    assert.equal(seedreamGenerationSize('2048x1152'), '2048x1152');
    assert.equal(seedreamGenerationSize('64x64'), '1K', 'a frame below the pixel budget is a 400');
});

test('the model id of the family is recognized in every spelling', () => {
    assert.equal(isSeedream55('seedream-5-5'), true);
    assert.equal(isSeedream55('bytedance-seed/seedream-5-5'), true);
    assert.equal(isSeedream55('seedream 5.5'), false);
    assert.equal(isSeedream55('gpt-image-2.6'), false);
});

// ---------------------------------------------------------------------------
// The geometry
// ---------------------------------------------------------------------------

test('an absolute box is read in the pixels of the base', () => {
    assert.deepEqual(
        normalizeLayerBox({ absolute: [84, 156, 756, 468] }, { width: 840, height: 1248 }),
        { x: 84, y: 156, width: 672, height: 312 },
    );
});

test('a normalized box is scaled to the canvas of the base', () => {
    // x = left / 1000 * W, y = top / 1000 * H, w = (right - left) / 1000 * W,
    // h = (bottom - top) / 1000 * H.
    assert.deepEqual(
        normalizeLayerBox({ normalized: [100, 125, 900, 375] }, { width: 1000, height: 1000 }),
        { x: 100, y: 125, width: 800, height: 250 },
    );
    assert.deepEqual(
        normalizeLayerBox({ normalized: [100, 125, 900, 375] }, { width: 840, height: 1248 }),
        { x: 84, y: 156, width: 672, height: 312 },
    );
});

test('a box without a usable frame stays a hole', () => {
    assert.equal(normalizeLayerBox(null, { width: 10, height: 10 }), null);
    assert.equal(normalizeLayerBox({ absolute: [1, 2] }, { width: 10, height: 10 }), null);
    assert.equal(normalizeLayerBox({ normalized: [1, 2, 3, 4] }, null), null, 'a normalized box needs a canvas');
    assert.equal(normalizeLayerBox({ absolute: [10, 10, 10, 20] }, { width: 10, height: 10 }), null);
});

test('the answer is read index by index: the base first, then the layers', () => {
    const answer = {
        code: 200,
        data: {
            status: 'completed',
            result: {
                images: [{
                    url: [dataUri(PNG), dataUri(PNG), dataUri(PNG)],
                    sizes: ['840x1248', '1512x702', '200x100'],
                    output_formats: ['png', 'png', 'png'],
                    backgrounds: ['opaque', 'transparent', 'transparent'],
                    layers: [
                        { z_index: 0, size: '840x1248', output_format: 'png', background: 'opaque' },
                        {
                            z_index: 1,
                            name: 'Sale title',
                            description: 'Printed sale title',
                            bounding_box: { absolute: [84, 156, 756, 468], normalized: [100, 125, 900, 375] },
                            text_recognition: {
                                text: 'SUMMER SALE',
                                lines: [{
                                    bounding_box: { absolute: [126, 156, 714, 468] },
                                    runs: [{ text: 'SUMMER SALE', style: { similar_font_family: 'Arial', bold: true } }],
                                }],
                            },
                        },
                        { z_index: 2, name: 'Badge', bounding_box: { normalized: [10, 20, 110, 60] } },
                    ],
                }],
            },
        },
    };
    const parsed = parseLayerDecomposition(answer);
    assert.equal(parsed.base.url, dataUri(PNG));
    assert.deepEqual(parsed.base.size, { width: 840, height: 1248 });
    assert.equal(parsed.layers.length, 2);

    const title = parsed.layers[0];
    assert.equal(title.name, 'Sale title');
    assert.equal(title.z, 1);
    assert.equal(title.background, 'transparent');
    assert.deepEqual(title.box, { x: 84, y: 156, width: 672, height: 312 });
    assert.equal(title.text.text, 'SUMMER SALE');
    assert.deepEqual(title.text.lines[0].box, { x: 126, y: 156, width: 588, height: 312 });
    assert.equal(title.text.lines[0].runs[0].style.bold, true);

    // The second layer has no absolute box, so it is read on the canvas of the base.
    assert.deepEqual(parsed.layers[1].box, { x: 8, y: 25, width: 84, height: 50 });
    assert.equal(parsed.ocr.length, 1);
});

test('the canvas of the base is the one the caller knows', () => {
    const answer = {
        data: {
            status: 'completed',
            result: {
                images: [{
                    url: [dataUri(PNG), dataUri(PNG)],
                    sizes: ['840x1248'],
                    layers: [
                        { z_index: 0 },
                        { z_index: 1, bounding_box: { normalized: [0, 0, 500, 500] } },
                    ],
                }],
            },
        },
    };
    const parsed = parseLayerDecomposition(answer, { baseFrame: { width: 200, height: 100 } });
    assert.deepEqual(parsed.layers[0].box, { x: 0, y: 0, width: 100, height: 50 });
});

test('a layer without a box keeps no box', () => {
    const answer = {
        data: {
            status: 'completed',
            result: { images: [{ url: [dataUri(PNG), dataUri(PNG)], sizes: ['10x10'], layers: [{ z_index: 0 }, {}] }] },
        },
    };
    const parsed = parseLayerDecomposition(answer);
    assert.equal(parsed.layers.length, 1);
    assert.equal(parsed.layers[0].box, null);
});

// ---------------------------------------------------------------------------
// The task
// ---------------------------------------------------------------------------

test('the task is polled until it is finished', async () => {
    const calls = [];
    const channel = fakeChannel({
        code: 200,
        data: {
            status: 'completed',
            result: {
                images: [{
                    url: [dataUri(PNG), dataUri(PNG)],
                    sizes: ['840x1248', '1512x702'],
                    layers: [{ z_index: 0 }, { z_index: 1, name: 'Title', bounding_box: { absolute: [10, 20, 110, 70] } }],
                }],
            },
        },
    }, calls);
    const decomposition = await decomposeLayers({
        channels: [channel],
        source: { bytes: PNG, mime: 'image/png' },
        coordinateFrame: { width: 840, height: 1248 },
    });
    assert.equal(calls.length, 2, 'the task is created and then polled');
    assert.equal(calls[0].path, 'images/generations');
    assert.equal(calls[0].body.layer_decomposition, true);
    assert.equal(calls[1].path, 'tasks/task-1');
    assert.equal(decomposition.taskId, 'task-1');
    assert.equal(decomposition.layers.length, 1);
    assert.deepEqual(decomposition.layers[0].box, { x: 10, y: 20, width: 100, height: 50 });
});

test('a failed task ends the run with the reason of the vendor', async () => {
    const channel = fakeChannel({
        data: { status: 'failed', error: { message: 'the picture was refused', reason: 'content_policy_violation' } },
    });
    await assert.rejects(
        decomposeLayers({ channels: [channel], source: { bytes: PNG } }),
        (error) => {
            assert.equal(error.code, 'TASK_FAILED');
            assert.equal(error.apiCode, 'content_policy_violation');
            return true;
        },
    );
});

test('a host that does not serve the model hands the task to the next one', async () => {
    const good = fakeChannel({
        data: { status: 'completed', result: { images: [{ url: [dataUri(PNG)], sizes: ['10x10'], layers: [{ z_index: 0 }] }] } },
    });
    const bad = {
        label: 'no-seedream',
        call: async () => { throw Object.assign(new Error('model not found'), { status: 404 }); },
    };
    const decomposition = await decomposeLayers({ channels: [bad, good], source: { bytes: PNG } });
    assert.equal(decomposition.host, 'fake-host');
    assert.equal(decomposition.layers.length, 0);
});

test('a host without balance hands the task to the next one', async () => {
    const good = fakeChannel({
        data: { status: 'completed', result: { images: [{ url: [dataUri(PNG)], sizes: ['10x10'], layers: [{ z_index: 0 }] }] } },
    });
    const broke = {
        label: 'no-money',
        call: async () => {
            throw Object.assign(new Error('Insufficient balance to run this request.'), { status: 402 });
        },
    };
    const decomposition = await decomposeLayers({ channels: [broke, good], source: { bytes: PNG } });
    assert.equal(decomposition.host, 'fake-host');
    assert.equal(decomposition.layers.length, 0);
});

test('the generation answers with the bytes of the picture', async () => {
    const channel = fakeChannel({
        data: { status: 'completed', result: { images: [{ url: [dataUri(PNG)], sizes: ['10x10'] }] } },
    });
    const answer = await generateImage({ channels: [channel], prompt: 'a cat' });
    assert.equal(answer.images.length, 1);
    assert.ok(answer.images[0].bytes.length > 0);
});

test('the sources of an answer are read in every shape', () => {
    assert.deepEqual(taskImageSources({ data: { status: 'completed', result: { images: [{ url: ['a', 'b'] }] } } }), [
        { kind: 'url', value: 'a' },
        { kind: 'url', value: 'b' },
    ]);
    assert.deepEqual(taskImageSources({ data: [{ b64_json: 'zzz' }] }), [{ kind: 'b64', value: 'zzz' }]);
});
