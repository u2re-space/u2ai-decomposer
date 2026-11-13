/**
 * @file test/pipeline.test.js
 * @purpose Tests of the pipeline orchestration: the order of the stages, the selection of the
 *          stages, the stop after a stage, and what happens when a stage fails.
 * @depends node:test, shared/pipeline, stages/index
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { STAGES, runPipeline, runStages } from '../src/shared/pipeline.js';
import { STAGE_DIRS, STAGE_IDS, STAGE_ROLES, stageById } from '../src/stages/index.js';

const configFor = (overrides = {}) => ({
    model: 'vendor/vision',
    imageModel: 'vendor/editor',
    roles: {},
    stages: {
        extend: { enabled: true },
        decompose: { enabled: true },
        rectify: { enabled: true },
        reconstruct: { enabled: true },
        overlap: { enabled: true },
        resolve: { enabled: true },
    },
    ...overrides,
});

const dryRunIn = async (root, options = {}) => {
    const events = [];
    const result = await runPipeline({
        root,
        images: ['reference.png'],
        outDir: '.',
        config: configFor(options.config),
        client: {
            responses: { async create() { throw new Error('the dry-run must not call the API'); } },
            images: { async edit() { throw new Error('the dry-run must not call the API'); } },
        },
        dryRun: true,
        notify: (event) => events.push(event),
        ...options,
    });
    return { events, result, plan: events.find((event) => event.type === 'plan') };
};

test('the stages run in the fixed order', () => {
    assert.deepEqual(STAGE_IDS, ['extend', 'decompose', 'rectify', 'reconstruct', 'overlap', 'resolve']);
    assert.deepEqual(STAGES.map((stage) => stage.id), STAGE_IDS);
    assert.equal(STAGE_ROLES.decompose, 'decomposer');
    assert.equal(STAGE_ROLES.resolve, 'director');
});

test('every stage writes into its own directory of the work directory', () => {
    assert.deepEqual(STAGE_DIRS, {
        extend: 'extended',
        decompose: 'screens',
        rectify: 'rectified',
        reconstruct: 'restored',
        overlap: 'overlap',
        resolve: 'decomposition.json',
    });
    assert.equal(stageById('overlap').label, 'Remove overlaps');
    assert.equal(stageById('nothing'), null);
});

test('the dry-run plans the six stages in order', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-pipe-'));
    try {
        const { plan } = await dryRunIn(root);
        assert.deepEqual(plan.stages.map((stage) => stage.id), STAGE_IDS);
        assert.deepEqual(plan.outputs, [
            path.join('decomposition', 'extended'),
            path.join('decomposition', 'screens'),
            path.join('decomposition', 'rectified'),
            path.join('decomposition', 'restored'),
            path.join('decomposition', 'overlap'),
            'decomposition.json',
        ]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the stage list chooses the stages but not their order', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-pipe-'));
    try {
        const { plan } = await dryRunIn(root, { stages: ['overlap', 'extend'] });
        assert.deepEqual(plan.stages.map((stage) => stage.id), ['extend', 'overlap']);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a disabled stage is not run', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-pipe-'));
    try {
        const config = configFor();
        config.stages.overlap.enabled = false;
        const { plan } = await dryRunIn(root, { config });
        assert.ok(!plan.stages.some((stage) => stage.id === 'overlap'));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the run stops after the named stage', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-pipe-'));
    try {
        const { plan } = await dryRunIn(root, { stopAfter: 'rectify' });
        assert.deepEqual(plan.stages.map((stage) => stage.id), ['extend', 'decompose', 'rectify']);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a stage that fails does not stop the run, and the failure is visible', async () => {
    const state = { warnings: [] };
    const events = [];
    const stages = [
        {
            id: 'first',
            label: 'First',
            async run() { state.warnings.push('first: something is off'); },
        },
        {
            id: 'second',
            label: 'Second',
            async run() { throw new Error('the stage is broken'); },
        },
        {
            id: 'third',
            label: 'Third',
            async run() { state.warnings.push('third: still going'); },
        },
    ];
    const failed = await runStages(stages, state, (event) => events.push(event));

    assert.equal(failed, true);
    assert.deepEqual(state.warnings, [
        'first: something is off',
        'second: the stage is broken',
        'third: still going',
    ]);
    const warnings = events.filter((event) => event.type === 'warning').map((event) => event.message);
    assert.deepEqual(warnings, state.warnings, 'every warning reaches the reader');
    assert.equal(events.filter((event) => event.type === 'stage.error').length, 1);
    assert.deepEqual(events.filter((event) => event.type === 'stage.done').map((event) => event.stage),
        ['first', 'second', 'third'], 'the run goes on after a failure');
});

test('an abort stops the run at once', async () => {
    const state = { warnings: [] };
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    await assert.rejects(() => runStages([{
        id: 'first',
        label: 'First',
        async run() { throw abort; },
    }], state, () => {}), /aborted/);
});
