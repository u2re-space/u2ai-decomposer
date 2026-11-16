/**
 * @file test/reception.test.js
 * @module test/reception
 * @purpose Tests of the reception and of the mini-plan: the stages the plan names, the order
 *          they run in, the parameters they get and the file the plan is written to.
 * @depends node:test, stages/plan, stages/reception, stages/index, shared/pipeline
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm } from 'node:fs/promises';

import {
    PLAN_FILE, MANDATORY_STAGES, STAGE_PARAMS,
    normalizePlan, defaultPlan, mentionsLayers, applyPlan, planOrder,
} from '../src/stages/plan.js';
import { runReception, receptionCatalogue, RECEPTION_TOOLS } from '../src/stages/reception.js';
import { rectifyMode, STAGE_IDS } from '../src/stages/index.js';
import { runPipeline } from '../src/shared/pipeline.js';

const STAGES = STAGE_IDS;

/**
 * The answer of the reception role, as the API returns it.
 * @param {object} plan the plan the role wrote
 * @returns {object}
 */
function answerWith(plan) {
    return {
        id: 'resp_plan',
        status: 'completed',
        model: 'm',
        output: [{
            type: 'message',
            content: [{ type: 'output_text', text: JSON.stringify(plan) }],
        }],
    };
}

/**
 * A client that answers the reception with a fixed plan.
 * @param {object} plan
 * @returns {{ client: object, calls: object[] }}
 */
function planClient(plan) {
    const calls = [];
    return {
        calls,
        client: {
            responses: {
                async create(params) {
                    calls.push(params);
                    return answerWith(plan);
                },
            },
        },
    };
}

// ---------------------------------------------------------------------------
// The law of the plan
// ---------------------------------------------------------------------------

test('the plan drops the stages that do not exist and keeps the first of a pair', () => {
    const { plan, warnings } = normalizePlan({
        steps: [
            { stage: 'decompose', why: 'cut', params: {} },
            { stage: 'decompose', why: 'again', params: {} },
            { stage: 'teleport', why: 'no such stage', params: {} },
        ],
        skipped: [],
    }, { stages: STAGES });

    assert.deepEqual(plan.steps.map((step) => step.stage), ['decompose', 'resolve']);
    assert.ok(warnings.some((message) => message.includes('teleport')));
    assert.ok(warnings.some((message) => message.includes('twice')));
});

test('the stages every run needs are added back', () => {
    const { plan, warnings } = normalizePlan({
        steps: [{ stage: 'rectify', why: 'straighten', params: {} }],
        skipped: [{ stage: 'decompose', why: 'not needed' }],
    }, { stages: STAGES });

    assert.deepEqual(plan.steps.map((step) => step.stage), ['decompose', 'rectify', 'resolve']);
    assert.deepEqual(MANDATORY_STAGES, ['decompose', 'resolve']);
    assert.ok(warnings.some((message) => message.includes('decompose')));
    assert.ok(warnings.some((message) => message.includes('resolve')));
});

test('the order of the model is kept, the dependencies of the house are not', () => {
    const { plan } = normalizePlan({
        steps: [
            { stage: 'resolve', why: 'the answer', params: {} },
            { stage: 'rectify', why: 'straighten', params: {} },
            { stage: 'decompose', why: 'cut', params: {} },
        ],
        skipped: [],
    }, { stages: STAGES });

    assert.deepEqual(plan.steps.map((step) => step.stage), ['decompose', 'rectify', 'resolve']);
});

test('a stage that works on the screens waits for the stage that cuts them', () => {
    const ordered = planOrder([
        { stage: 'resolve', params: {} },
        { stage: 'reconstruct', params: {} },
        { stage: 'decompose', params: {} },
    ]);
    assert.deepEqual(ordered.map((step) => step.stage), ['decompose', 'reconstruct', 'resolve']);
});

test('the parameters outside the table of the stage are dropped with a warning', () => {
    const { plan, warnings } = normalizePlan({
        steps: [
            { stage: 'decompose', why: 'cut', params: { mode: 'inline', maxTurns: 99 } },
            { stage: 'reconstruct', why: 'repair', params: { quality: 'ultra', maxPasses: 4 } },
            { stage: 'rectify', why: 'straighten', params: { mode: 'ai-mode' } },
        ],
        skipped: [],
    }, { stages: STAGES });

    const byId = Object.fromEntries(plan.steps.map((step) => [step.stage, step.params]));
    assert.deepEqual(byId.decompose, { mode: 'inline' });
    assert.deepEqual(byId.reconstruct, { maxPasses: 4 });
    assert.deepEqual(byId.rectify, { mode: 'ai-mode' });
    assert.ok(warnings.some((message) => message.includes('maxTurns')));
    assert.ok(warnings.some((message) => message.includes('ultra')));
});

test('the table of the parameters names only what the stages accept', () => {
    assert.deepEqual(Object.keys(STAGE_PARAMS).sort(), [...STAGES].sort());
    assert.deepEqual(STAGE_PARAMS.rectify.mode.values, ['geometry', 'ai-mode']);
    assert.equal(STAGE_PARAMS.resolve.layers.type, 'boolean');
});

test('the plan of a run that nobody planned is the usual work', () => {
    const plan = defaultPlan(STAGES, 'do it');
    assert.deepEqual(plan.steps.map((step) => step.stage), STAGES);
    assert.deepEqual(plan.skipped, []);
    assert.equal(plan.prompt, 'do it');
});

// ---------------------------------------------------------------------------
// The parameters of the plan reach the config of the run
// ---------------------------------------------------------------------------

test('the plan writes its parameters into a copy and leaves the config of the user alone', () => {
    const config = { stages: { rectify: { mode: 'auto', maxTurns: 24 } } };
    const { config: copy, warnings } = applyPlan(config, {
        steps: [{ stage: 'rectify', params: { mode: 'geometry' } }],
    }, {});

    assert.equal(copy.stages.rectify.mode, 'geometry');
    assert.equal(copy.stages.rectify.maxTurns, 24, 'the other settings survive');
    assert.equal(config.stages.rectify.mode, 'auto', 'the config of the user is not touched');
    assert.deepEqual(warnings, []);
});

test('the layer split is refused when nobody asked for it', () => {
    const config = { stages: { resolve: { layers: false } } };
    const plan = { steps: [{ stage: 'resolve', params: { layers: true } }] };

    const refused = applyPlan(config, plan, { layersAllowed: false });
    assert.equal(refused.config.stages.resolve.layers, false);
    assert.ok(refused.warnings.some((message) => message.includes('layer split')));

    const allowed = applyPlan(config, plan, { layersAllowed: true });
    assert.equal(allowed.config.stages.resolve.layers, true);
    assert.deepEqual(allowed.warnings, []);
});

test('the task asks for the layers in English and in Russian', () => {
    assert.equal(mentionsLayers('split the screen into layers'), true);
    assert.equal(mentionsLayers('a layered design'), true);
    assert.equal(mentionsLayers('разложи послойно'), true);
    assert.equal(mentionsLayers('дай слои экрана'), true);
    assert.equal(mentionsLayers('just straighten the picture'), false);
    assert.equal(mentionsLayers(''), false);
});

// ---------------------------------------------------------------------------
// The mode of the rectify stage
// ---------------------------------------------------------------------------

test('the mode of the rectify stage is auto until somebody decides', () => {
    const geometry = { config: { stages: { rectify: { mode: 'auto' } } }, client: {} };
    assert.equal(rectifyMode(geometry), 'geometry', 'no picture model, no ai-mode');

    const withModel = {
        config: { stages: { rectify: { mode: 'auto' } }, imageModel: 'vendor/editor' },
        client: { images: {} },
    };
    assert.equal(rectifyMode(withModel), 'ai-mode', 'a picture model is there');

    const decided = {
        config: { stages: { rectify: { mode: 'geometry' } } },
        client: { images: {} },
        imageModel: 'vendor/editor',
    };
    assert.equal(rectifyMode(decided), 'geometry', 'the decision of the plan wins');
});

// ---------------------------------------------------------------------------
// The reception
// ---------------------------------------------------------------------------

test('the reception asks the role and reads the plan', async () => {
    const warnings = [];
    const asked = [];
    const state = {
        root: process.cwd(),
        images: [],
        references: [],
        workDir: 'decomposition',
        config: { plan: { maxTurns: 4 }, raster: { engine: 'auto' } },
        roles: {
            async run(name, params) {
                asked.push({ name, params });
                return {
                    status: 'completed',
                    data: {
                        summary: 'cut the collage and straighten it',
                        steps: [
                            { stage: 'decompose', why: 'three screens', params: {} },
                            { stage: 'rectify', why: 'the photo is tilted', params: { mode: 'ai-mode' } },
                            { stage: 'resolve', why: 'the answer', params: {} },
                        ],
                        skipped: [{ stage: 'extend', why: 'nothing is cut' }],
                        notes: [],
                    },
                };
            },
        },
        model: 'm',
        effort: 'low',
        warnings,
        prompt: 'cut the collage',
    };

    const plan = await runReception(state);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].name, 'reception');
    assert.equal(asked[0].params.schemaName, 'plan');
    assert.deepEqual(asked[0].params.extraTools, []);
    assert.deepEqual(plan.steps.map((step) => step.stage), ['decompose', 'rectify', 'resolve']);
    assert.equal(plan.steps[1].params.mode, 'ai-mode');
    assert.deepEqual(plan.skipped.map((item) => item.stage), ['extend', 'reconstruct', 'overlap']);
    assert.equal(plan.prompt, 'cut the collage');
    assert.deepEqual(RECEPTION_TOOLS, []);
});

test('the reception reads the catalogue of the stages', () => {
    const catalogue = receptionCatalogue();
    for (const id of STAGES) assert.ok(catalogue.includes(id), `${id} is in the catalogue`);
    assert.ok(catalogue.includes('quality'));
    assert.ok(catalogue.includes('maxPasses'));
});

// ---------------------------------------------------------------------------
// The run follows the plan
// ---------------------------------------------------------------------------

test('the run asks the reception, writes the plan and follows it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-plan-'));
    const events = [];
    try {
        const { client, calls } = planClient({
            summary: 'only the cut and the answer',
            steps: [
                { stage: 'decompose', why: 'cut', params: {} },
                { stage: 'resolve', why: 'the answer', params: {} },
            ],
            skipped: [
                { stage: 'extend', why: 'nothing is cut' },
                { stage: 'rectify', why: 'the picture is flat' },
                { stage: 'reconstruct', why: 'nothing is broken' },
                { stage: 'overlap', why: 'one screen' },
            ],
            notes: [],
        });

        // The stages the plan leaves out are off: the run has to do exactly what the plan says.
        const config = {
            model: 'vendor/vision',
            roles: {},
            plan: { enabled: true, maxTurns: 4 },
            stages: {
                extend: { enabled: false },
                decompose: { enabled: true },
                rectify: { enabled: false },
                reconstruct: { enabled: false },
                overlap: { enabled: false },
                resolve: { enabled: true },
            },
        };

        await runPipeline({
            root,
            images: [],
            outDir: '.',
            stages: null,
            config,
            client,
            prompt: 'cut it',
            notify: (event) => events.push(event),
        });

        assert.equal(calls.length, 1, 'the reception asked once');
        const written = JSON.parse(await readFile(path.join(root, 'decomposition', PLAN_FILE), 'utf8'));
        assert.deepEqual(written.steps.map((step) => step.stage), ['decompose', 'resolve']);
        assert.equal(written.prompt, 'cut it');

        const ready = events.find((event) => event.type === 'plan.ready');
        assert.ok(ready, 'the reader is told about the plan');
        assert.deepEqual(ready.stages, ['decompose', 'resolve']);
        assert.deepEqual(ready.skipped, ['extend', 'rectify', 'reconstruct', 'overlap']);

        const started = events.filter((event) => event.type === 'stage.start').map((event) => event.stage);
        assert.deepEqual(started, ['decompose', 'resolve'], 'the run follows the plan');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the run without a plan does the usual work', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-noplan-'));
    const events = [];
    try {
        const client = {
            responses: {
                async create() { throw new Error('the reception must not be called'); },
            },
        };
        const config = {
            model: 'vendor/vision',
            roles: {},
            plan: { enabled: false, maxTurns: 4 },
            stages: {
                extend: { enabled: false },
                decompose: { enabled: true },
                rectify: { enabled: false },
                reconstruct: { enabled: false },
                overlap: { enabled: false },
                resolve: { enabled: true },
            },
        };

        await runPipeline({
            root,
            images: [],
            outDir: '.',
            stages: null,
            config,
            client,
            notify: (event) => events.push(event),
        });

        const written = JSON.parse(await readFile(path.join(root, 'decomposition', PLAN_FILE), 'utf8'));
        assert.deepEqual(written.steps.map((step) => step.stage), ['decompose', 'resolve']);
        const started = events.filter((event) => event.type === 'stage.start').map((event) => event.stage);
        assert.deepEqual(started, ['decompose', 'resolve']);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
