/**
 * @file test/cli.test.js
 * @purpose Tests of the CLI argument parser and the dry-run plan.
 * @depends node:test, cli, shared/pipeline
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { access, mkdtemp, rm } from 'node:fs/promises';

import { parseArgv } from '../src/cli.js';
import { runPipeline } from '../src/shared/pipeline.js';

test('a comma-separated stage list is split into stages', () => {
    const parsed = parseArgv(['--stages', 'extend,decompose', '--no-verbose']);
    assert.deepEqual(parsed.stages, ['extend', 'decompose']);
    assert.equal(parsed.verbose, false);
});

test('the dry-run prints a plan without creating output or calling the client', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-dry-'));
    const events = [];
    let called = false;
    try {
        await runPipeline({
            root,
            images: ['reference.png'],
            outDir: '.',
            stages: ['extend', 'decompose'],
            config: {
                model: 'vendor/vision',
                imageModel: 'vendor/editor',
                roles: {},
                stages: { extend: { enabled: true }, decompose: { enabled: true } },
            },
            client: {
                responses: { async create() { called = true; } },
                images: { async edit() { called = true; } },
            },
            dryRun: true,
            notify: (event) => events.push(event),
        });
        const plan = events.find((event) => event.type === 'plan');
        assert.ok(plan);
        assert.deepEqual(plan.stages.map((stage) => stage.id), ['extend', 'decompose']);
        assert.equal(plan.outputs.length, 2);
        assert.equal(called, false);
        assert.equal(await access(path.join(root, 'decomposition')).catch(() => null), null);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
